import "server-only";
import Firecrawl from "@mendable/firecrawl-js";
import { z } from "zod";
import { sql } from "./db";
import { generateJson } from "./llm";
import {
  FIELDS,
  FIELD_IDS,
  completeness,
  fieldMeta,
  type FieldRow,
  type FieldStatus,
} from "./fields";

// ---------- types & state machine ----------

export type SessionStatus =
  | "awaiting_input"
  | "organizing"
  | "interviewing"
  | "paused"
  | "drafting"
  | "reviewing"
  | "approved"
  | "shared"
  | "cancelled";

type SessionRow = {
  id: string;
  status: SessionStatus;
  input_url: string | null;
  input_line: string | null;
  website_text: string | null;
  cursor_field: string | null;
  revision: number;
  approved_revision: number | null;
  time_budget_min: number | null;
};

const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  awaiting_input: ["organizing", "cancelled"],
  organizing: ["interviewing", "cancelled"],
  interviewing: ["paused", "drafting", "cancelled"],
  paused: ["interviewing", "cancelled"],
  drafting: ["reviewing", "cancelled"],
  reviewing: ["interviewing", "approved", "cancelled"],
  approved: ["reviewing", "shared", "cancelled"],
  shared: [],
  cancelled: [],
};

export class ToolError extends Error {}

async function getSession(id: string): Promise<SessionRow> {
  const rows = await sql`select * from sessions where id = ${id}`;
  if (!rows.length) throw new ToolError(`Session ${id} not found`);
  return rows[0] as SessionRow;
}

async function getFields(id: string): Promise<FieldRow[]> {
  const rows = (await sql`select * from fields where session_id = ${id}`) as FieldRow[];
  const order = new Map<string, number>(FIELD_IDS.map((f, i) => [f, i]));
  return rows.sort((a, b) => order.get(a.field_id)! - order.get(b.field_id)!);
}

async function transition(s: SessionRow, to: SessionStatus) {
  if (s.status === to) return;
  if (!TRANSITIONS[s.status].includes(to)) {
    throw new ToolError(`Cannot go from "${s.status}" to "${to}"`);
  }
  await sql`update sessions set status = ${to}, updated_at = now() where id = ${s.id}`;
  s.status = to;
}

function requireStatus(s: SessionRow, allowed: SessionStatus[], action: string) {
  if (!allowed.includes(s.status)) {
    throw new ToolError(`Cannot ${action} while session is "${s.status}" (allowed: ${allowed.join(", ")})`);
  }
}

/** Bumps revision; if the session was approved, the approval is invalidated (back to reviewing). */
async function bumpRevision(s: SessionRow): Promise<number> {
  const rows = await sql`update sessions set revision = revision + 1, updated_at = now()
                         where id = ${s.id} returning revision`;
  s.revision = rows[0].revision as number;
  if (s.status === "approved") await transition(s, "reviewing");
  return s.revision;
}

async function writeField(
  s: SessionRow,
  fieldId: string,
  patch: Partial<Pick<FieldRow, "status" | "value" | "kind" | "source" | "evidence_quote" | "confidence">>,
  reason: string,
) {
  fieldMeta(fieldId);
  const [old] = (await sql`select value from fields where session_id = ${s.id} and field_id = ${fieldId}`) as {
    value: string | null;
  }[];
  const rev = await bumpRevision(s);
  await sql`update fields set
      status = coalesce(${patch.status ?? null}, status),
      value = coalesce(${patch.value ?? null}, value),
      kind = coalesce(${patch.kind ?? null}, kind),
      source = coalesce(${patch.source ?? null}, source),
      evidence_quote = coalesce(${patch.evidence_quote ?? null}, evidence_quote),
      confidence = coalesce(${patch.confidence ?? null}, confidence),
      updated_revision = ${rev}
    where session_id = ${s.id} and field_id = ${fieldId}`;
  await sql`insert into field_history (session_id, field_id, revision, old_value, new_value, reason)
            values (${s.id}, ${fieldId}, ${rev}, ${old?.value ?? null}, ${patch.value ?? null}, ${reason})`;
  return rev;
}

function looksVague(fieldId: string, value: string) {
  const meta = fieldMeta(fieldId);
  if (value.trim().split(/\s+/).length < 3) return true;
  if (meta.needsNumber && !/\d|once|twice|daily|weekly|monthly|hour|lakh|crore|thousand|hundred/i.test(value)) {
    return true;
  }
  return false;
}

async function snapshot(sessionId: string) {
  const s = await getSession(sessionId);
  const fields = await getFields(sessionId);
  return {
    session_id: s.id,
    status: s.status,
    revision: s.revision,
    approved_revision: s.approved_revision,
    cursor_field: s.cursor_field,
    input_url: s.input_url,
    input_line: s.input_line,
    time_budget_min: s.time_budget_min,
    completeness_pct: completeness(fields),
    fields,
  };
}

async function review(sessionId: string) {
  const snap = await snapshot(sessionId);
  const missing = snap.fields
    .filter((f) => f.status !== "known")
    .map((f) => ({ field_id: f.field_id, label: f.label, status: f.status }));
  return { ...snap, missing };
}

// ---------- tool implementations ----------

const str = z.string().trim().min(1);

const tools = {
  async create_session(_sid: string | null, args: unknown) {
    const a = z
      .object({ url: z.string().trim().optional(), line: str, time_budget_min: z.number().int().positive().optional() })
      .parse(args);
    const [row] = await sql`insert into sessions (input_url, input_line, time_budget_min)
                            values (${a.url || null}, ${a.line}, ${a.time_budget_min ?? null}) returning id`;
    const id = row.id as string;
    for (const f of FIELDS) {
      await sql`insert into fields (session_id, field_id, label) values (${id}, ${f.id}, ${f.label})`;
    }
    return { session_id: id };
  },

  async organize(sid: string) {
    const s = await getSession(sid);
    requireStatus(s, ["awaiting_input"], "organize");
    await transition(s, "organizing");

    let websiteText: string | null = null;
    let scrapeError: string | null = null;
    if (s.input_url) {
      try {
        const fc = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
        const doc = await fc.scrape(s.input_url, { formats: ["markdown"], onlyMainContent: true, timeout: 20000 });
        websiteText = doc.markdown?.slice(0, 20000) || null;
        if (!websiteText) scrapeError = "Page had no readable text";
      } catch (e) {
        scrapeError = `Could not read the page: ${String(e).slice(0, 200)}`;
      }
    }
    await sql`update sessions set website_text = ${websiteText} where id = ${sid}`;

    const sources = `ONE-LINE PROBLEM FROM THE OWNER:\n${s.input_line}\n\nWEBSITE TEXT:\n${websiteText ?? "(none)"}`;
    const out = await generateJson({
      schema: z.object({
        facts: z.array(
          z.object({
            field_id: z.enum(FIELD_IDS),
            value: z.string(),
            kind: z.enum(["observation", "claim", "assumption"]),
            source: z.enum(["user", "website"]),
            evidence_quote: z.string(),
            status: z.enum(["known", "vague"]),
            confidence: z.number().min(0).max(1),
          }),
        ),
        business_summary: z.string(),
      }),
      system:
        "You organise what is already known about a small business problem before an interview. " +
        "Only fill a field if the sources directly support it. evidence_quote MUST be copied verbatim from the sources. " +
        "Marketing claims on a website are 'claim', not 'observation'. Use 'vague' if the support is weak or lacks specifics. " +
        "Leave everything else out — gaps are expected and good. Never invent.",
      prompt: `Fields:\n${FIELDS.map((f) => `- ${f.id}: ${f.label}`).join("\n")}\n\n${sources}`,
    });

    // Anti-hallucination: drop facts whose quote is not actually in the sources.
    const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
    const haystack = norm(sources);
    const accepted = out.facts.filter((f) => f.evidence_quote && haystack.includes(norm(f.evidence_quote)));
    for (const f of accepted) {
      await writeField(s, f.field_id, f, "organize");
    }

    await transition(s, "interviewing");
    return {
      business_summary: out.business_summary,
      scrape_error: scrapeError,
      prefilled: accepted.map((f) => f.field_id),
      dropped_unverifiable: out.facts.length - accepted.length,
      ...(await snapshot(sid)),
    };
  },

  async get_next_question(sid: string, args: unknown) {
    // suggest=true adds an LLM-written question (slower); the chat/voice agent normally writes it from `guidance`.
    const { suggest } = z.object({ suggest: z.boolean().optional() }).parse(args ?? {});
    const s = await getSession(sid);
    if (s.status === "paused") throw new ToolError("Session is paused — call resume first");
    requireStatus(s, ["interviewing"], "ask the next question");
    const fields = await getFields(sid);
    const open = (f: FieldRow) => (f.status === "gap" || f.status === "vague") && f.asked_count < 3;

    // Stay on the current field for a follow-up if it is still open; otherwise take the next by priority.
    const current = fields.find((f) => f.field_id === s.cursor_field);
    const target = current && open(current) ? current : fields.find(open);
    if (!target) {
      return { done: true, completeness_pct: completeness(fields), message: "All fields addressed — call finish_interview." };
    }
    await sql`update fields set asked_count = asked_count + 1 where session_id = ${sid} and field_id = ${target.field_id}`;
    await sql`update sessions set cursor_field = ${target.field_id}, updated_at = now() where id = ${sid}`;

    const followUp = target.asked_count > 0;
    const guidance =
      target.status === "vague"
        ? `We have "${target.value}" — too vague. Probe for a number, a concrete example or a specific person.`
        : followUp
          ? `Asked before without a usable answer. Rephrase more concretely or offer 2-3 example options.`
          : `Ask about: ${target.label}.`;
    const base = {
      done: false,
      field_id: target.field_id,
      label: target.label,
      status: target.status,
      is_follow_up: followUp,
      guidance,
      completeness_pct: completeness(fields),
    };
    if (!suggest) return base;

    const recent = (await sql`select role, content from messages where session_id = ${sid}
                               order by id desc limit 6`) as { role: string; content: string }[];
    const known = fields.filter((f) => f.value).map((f) => `- ${f.field_id} (${f.status}): ${f.value}`);
    const q = await generateJson({
      schema: z.object({ question: z.string(), why: z.string() }),
      system:
        "You are a warm, sharp problem-intake interviewer for small business owners. Write ONE short spoken question " +
        "(max 25 words) for the target field. If the field is 'vague', probe for a number, a concrete example or a specific person. " +
        "Do not repeat questions already asked. Never suggest solutions. Match the language the user last spoke (English/Hindi/Hinglish).",
      prompt:
        `Owner's problem: ${s.input_line}\n` +
        `Target field: ${target.field_id} — ${target.label} (status: ${target.status}, times asked: ${target.asked_count}, current value: ${target.value ?? "none"})\n` +
        `Known so far:\n${known.join("\n") || "(nothing)"}\n` +
        `Recent conversation (newest first):\n${recent.map((m) => `${m.role}: ${m.content}`).join("\n") || "(none)"}`,
    });
    return { ...base, question: q.question, why: q.why };
  },

  async record_answer(sid: string, args: unknown) {
    const a = z
      .object({
        field_id: z.enum(FIELD_IDS),
        value: str,
        kind: z.enum(["observation", "claim", "assumption"]),
        evidence_quote: str,
        confidence: z.number().min(0).max(1).default(0.7),
        is_vague: z.boolean().optional(),
      })
      .parse(args);
    const s = await getSession(sid);
    requireStatus(s, ["interviewing", "reviewing", "approved"], "record an answer");
    const status: FieldStatus = a.is_vague || looksVague(a.field_id, a.value) ? "vague" : "known";
    const revision = await writeField(s, a.field_id, { ...a, status, source: "user" }, "answer");
    return { field_id: a.field_id, status, revision };
  },

  async correct_answer(sid: string, args: unknown) {
    const a = z.object({ field_id: z.enum(FIELD_IDS), value: str }).parse(args);
    const s = await getSession(sid);
    requireStatus(s, ["interviewing", "reviewing", "approved"], "correct an answer");
    const revision = await writeField(
      s,
      a.field_id,
      { value: a.value, status: "known", source: "user", kind: "observation", evidence_quote: a.value },
      "correction",
    );
    return { field_id: a.field_id, revision, approval_invalidated: s.status === "reviewing" && s.approved_revision != null };
  },

  async mark_unknown(sid: string, args: unknown) {
    const a = z.object({ field_id: z.enum(FIELD_IDS) }).parse(args);
    const s = await getSession(sid);
    requireStatus(s, ["interviewing", "reviewing"], "mark unknown");
    // If something is already captured, keep it as "vague" (detail unknown) rather than discarding it; never re-ask either way.
    const [row] = await sql`select value from fields where session_id = ${sid} and field_id = ${a.field_id}`;
    const status: FieldStatus = row?.value ? "vague" : "unknown";
    const revision = await writeField(s, a.field_id, { status }, "unknown");
    await sql`update fields set asked_count = 3 where session_id = ${sid} and field_id = ${a.field_id}`;
    return { revision, status };
  },

  async decline(sid: string, args: unknown) {
    const a = z.object({ field_id: z.enum(FIELD_IDS) }).parse(args);
    const s = await getSession(sid);
    requireStatus(s, ["interviewing", "reviewing"], "decline");
    return { revision: await writeField(s, a.field_id, { status: "declined" }, "declined") };
  },

  async flag_sensitive(sid: string, args: unknown) {
    const a = z.object({ field_id: z.enum(FIELD_IDS), item: str, suggested_redaction: str }).parse(args);
    const s = await getSession(sid);
    requireStatus(s, ["interviewing", "reviewing", "approved"], "flag sensitive info");
    const [row] = await sql`select redaction from fields where session_id = ${sid} and field_id = ${a.field_id}`;
    const list: { item: string; replacement: string }[] = row?.redaction ? JSON.parse(row.redaction) : [];
    if (!list.some((r) => r.item === a.item)) list.push({ item: a.item, replacement: a.suggested_redaction });
    const revision = await bumpRevision(s);
    await sql`update fields set sensitive = true, redaction = ${JSON.stringify(list)}, redaction_accepted = null,
              updated_revision = ${revision} where session_id = ${sid} and field_id = ${a.field_id}`;
    return { field_id: a.field_id, redactions: list, revision };
  },

  async set_redaction(sid: string, args: unknown) {
    const a = z.object({ field_id: z.enum(FIELD_IDS), accepted: z.boolean() }).parse(args);
    const s = await getSession(sid);
    requireStatus(s, ["interviewing", "reviewing", "approved"], "set redaction");
    const revision = await bumpRevision(s);
    await sql`update fields set redaction_accepted = ${a.accepted}, updated_revision = ${revision}
              where session_id = ${sid} and field_id = ${a.field_id}`;
    return { field_id: a.field_id, accepted: a.accepted, revision };
  },

  async pause(sid: string) {
    const s = await getSession(sid);
    await transition(s, "paused");
    return { status: s.status, resume_at: s.cursor_field };
  },

  async resume(sid: string) {
    const s = await getSession(sid);
    requireStatus(s, ["paused"], "resume");
    await transition(s, "interviewing");
    const field = s.cursor_field ? fieldMeta(s.cursor_field) : null;
    return { status: s.status, resume_at: s.cursor_field, resume_label: field?.label ?? null };
  },

  async finish_interview(sid: string) {
    const s = await getSession(sid);
    requireStatus(s, ["interviewing", "paused"], "finish the interview");
    if (s.status === "paused") await transition(s, "interviewing");
    await transition(s, "drafting");
    await transition(s, "reviewing");
    return review(sid);
  },

  async back_to_interview(sid: string) {
    const s = await getSession(sid);
    await transition(s, "interviewing");
    return { status: s.status };
  },

  async get_review(sid: string) {
    return review(sid);
  },

  async get_session(sid: string) {
    const snap = await snapshot(sid);
    const messages = await sql`select role, channel, content, created_at from messages
                               where session_id = ${sid} order by id`;
    return { ...snap, messages };
  },

  async log_message(sid: string, args: unknown) {
    const a = z
      .object({ role: z.enum(["user", "agent", "system"]), channel: z.enum(["text", "voice"]), content: str })
      .parse(args);
    await getSession(sid);
    await sql`insert into messages (session_id, role, channel, content) values (${sid}, ${a.role}, ${a.channel}, ${a.content})`;
    return { logged: true };
  },

  async approve_revision(sid: string, args: unknown) {
    const a = z.object({ revision: z.number().int() }).parse(args);
    const s = await getSession(sid);
    requireStatus(s, ["reviewing"], "approve");
    if (a.revision !== s.revision) {
      throw new ToolError(`Stale approval: you approved revision ${a.revision} but the current revision is ${s.revision}. Review again.`);
    }
    const snap = await snapshot(sid);
    await sql`insert into briefs (session_id, revision, audience, content)
              values (${sid}, ${s.revision}, 'snapshot', ${JSON.stringify(snap.fields)})
              on conflict (session_id, revision, audience) do nothing`;
    await sql`update sessions set approved_revision = ${s.revision} where id = ${sid}`;
    await transition(s, "approved");
    return { approved_revision: s.revision };
  },

  async generate_versions(sid: string) {
    const s = await getSession(sid);
    requireStatus(s, ["approved", "shared"], "generate versions");
    const [snapRow] = await sql`select content from briefs where session_id = ${sid}
                                and revision = ${s.approved_revision} and audience = 'snapshot'`;
    const fields = JSON.parse(snapRow.content as string) as FieldRow[];

    // Public version: apply accepted redactions in code first, so the model never sees the originals.
    const redacted = fields.map((f) => {
      if (!f.sensitive || f.redaction_accepted === false || !f.redaction) return f;
      let value = f.value ?? "";
      let quote = f.evidence_quote ?? "";
      for (const r of JSON.parse(f.redaction) as { item: string; replacement: string }[]) {
        value = value.split(r.item).join(r.replacement);
        quote = quote.split(r.item).join(r.replacement);
      }
      return { ...f, value, evidence_quote: quote };
    });
    const render = (fs: FieldRow[]) =>
      fs
        .map((f) => `- ${f.label} [${f.status}${f.kind ? `, ${f.kind}` : ""}]: ${f.value ?? "UNKNOWN"}${f.evidence_quote ? ` (quote: "${f.evidence_quote}")` : ""}`)
        .join("\n");

    const out = await generateJson({
      schema: z.object({ builder: z.string(), public: z.string(), exec: z.string() }),
      system:
        "You write problem briefs in Markdown from confirmed interview fields. Never add facts that are not in the fields. " +
        "Label assumptions and claims as such. List unknown/vague fields under 'Open questions'. " +
        "builder: technical brief with sections (Problem, Who, Today's workaround, Impact & scale, Constraints, Tried, Success, Facts vs assumptions, Open questions, First 3 investigation steps). " +
        "public: same structure for an open builder community, using ONLY the redacted fields given; omit anything in the confidential field. " +
        "exec: 5-line one-pager (problem, impact, who, ask, next step).",
      prompt: `FULL FIELDS (for builder and exec):\n${render(fields)}\n\nREDACTED FIELDS (the only input allowed for public):\n${render(redacted)}`,
    });
    for (const audience of ["builder", "public", "exec"] as const) {
      await sql`insert into briefs (session_id, revision, audience, content)
                values (${sid}, ${s.approved_revision}, ${audience}, ${out[audience]})
                on conflict (session_id, revision, audience) do update set content = excluded.content`;
    }
    return { revision: s.approved_revision, ...out };
  },

  async get_versions(sid: string) {
    const s = await getSession(sid);
    if (s.approved_revision == null) return { revision: null };
    const rows = (await sql`select audience, content from briefs where session_id = ${sid}
                            and revision = ${s.approved_revision} and audience <> 'snapshot'`) as {
      audience: string;
      content: string;
    }[];
    if (!rows.length) return { revision: s.approved_revision, generated: false };
    return {
      revision: s.approved_revision,
      generated: true,
      ...Object.fromEntries(rows.map((r) => [r.audience, r.content])),
    };
  },

  /** Public read: only the redacted public brief, and only once the owner confirmed sharing. */
  async get_shared(sid: string) {
    const s = await getSession(sid);
    if (s.status !== "shared") throw new ToolError("This brief has not been shared.");
    const [row] = await sql`select content, created_at from briefs where session_id = ${sid}
                            and revision = ${s.approved_revision} and audience = 'public'`;
    return { revision: s.approved_revision, content: row.content as string, created_at: row.created_at };
  },

  /** Public board: only owner-approved, shared, redacted briefs. Never exposes the raw input line. */
  async list_shared() {
    const rows = (await sql`select s.id, s.approved_revision, b.content, s.updated_at
                            from sessions s join briefs b
                              on b.session_id = s.id and b.revision = s.approved_revision and b.audience = 'public'
                            where s.status = 'shared' order by s.updated_at desc limit 50`) as {
      id: string;
      approved_revision: number;
      content: string;
      updated_at: string;
    }[];
    return rows.map((r) => {
      const lines = r.content.split("\n").map((l) => l.trim()).filter(Boolean);
      const summary = lines.find((l) => !l.startsWith("#")) ?? "";
      const open = r.content.match(/open questions[\s\S]*?(?=\n#|$)/i)?.[0].split("\n").filter((l) => /^\s*[-*]/.test(l)).length ?? 0;
      return { id: r.id, revision: r.approved_revision, summary: summary.replace(/^[-*]\s*/, ""), open_questions: open, shared_at: r.updated_at };
    });
  },

  async confirm_share(sid: string, args: unknown) {
    const a = z.object({ revision: z.number().int() }).parse(args);
    const s = await getSession(sid);
    requireStatus(s, ["approved"], "share");
    if (a.revision !== s.approved_revision) {
      throw new ToolError(`Revision ${a.revision} is not the approved revision (${s.approved_revision}).`);
    }
    const [pub] = await sql`select 1 from briefs where session_id = ${sid} and revision = ${a.revision} and audience = 'public'`;
    if (!pub) throw new ToolError("Generate versions before sharing.");
    await transition(s, "shared");
    return { shared_revision: a.revision, share_path: `/b/${sid}` };
  },

  async cancel(sid: string) {
    const s = await getSession(sid);
    await transition(s, "cancelled");
    return { status: s.status };
  },
} satisfies Record<string, (sid: string, args: unknown) => Promise<unknown>>;

export type ToolName = keyof typeof tools;
export const TOOL_NAMES = Object.keys(tools) as ToolName[];

/** Runs a tool. With a decision_id, repeats return the stored result instead of re-applying (idempotent). */
export async function runTool(name: string, sessionId: string | null, args: unknown, decisionId?: string) {
  if (!(name in tools)) throw new ToolError(`Unknown tool "${name}". Available: ${TOOL_NAMES.join(", ")}`);
  if (name !== "create_session" && name !== "list_shared" && !sessionId) throw new ToolError("session_id is required");

  if (decisionId) {
    const [prev] = await sql`select result from decisions where decision_id = ${decisionId}`;
    if (prev) return { ...(prev.result as object), idempotent_replay: true };
  }
  const result = await tools[name as ToolName](sessionId as string, args ?? {});
  if (decisionId) {
    const sid = name === "create_session" ? (result as { session_id: string }).session_id : sessionId;
    await sql`insert into decisions (decision_id, session_id, type, payload, result)
              values (${decisionId}, ${sid}, ${name}, ${JSON.stringify(args ?? {})}, ${JSON.stringify(result)})
              on conflict (decision_id) do nothing`;
  }
  return result;
}
