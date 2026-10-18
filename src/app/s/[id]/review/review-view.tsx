"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { callTool, newDecisionId, type Field, type SessionState } from "@/lib/client";

type Versions = { revision: number | null; generated?: boolean; builder?: string; public?: string; exec?: string };
type Audience = "builder" | "public" | "exec";

const AUDIENCE_LABEL: Record<Audience, string> = {
  builder: "Builder brief",
  public: "Public (redacted)",
  exec: "Exec one-pager",
};

const KIND_STYLE: Record<string, string> = {
  observation: "bg-emerald-100 text-emerald-800",
  claim: "bg-sky-100 text-sky-800",
  assumption: "bg-violet-100 text-violet-800",
};

const STATUS_TEXT: Record<Field["status"], string> = {
  gap: "Missing",
  vague: "Needs detail",
  known: "Captured",
  unknown: "Owner doesn't know",
  declined: "Owner declined to share",
};

function omit(obj: Record<string, string>, key: string) {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

function redactions(f: Field): { item: string; replacement: string }[] {
  return f.redaction ? JSON.parse(f.redaction) : [];
}

export default function ReviewView() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<SessionState | null>(null);
  const [versions, setVersions] = useState<Versions | null>(null);
  const [tab, setTab] = useState<Audience>("builder");
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmShare, setConfirmShare] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, v] = await Promise.all([
      callTool<SessionState>("get_session", id),
      callTool<Versions>("get_versions", id),
    ]);
    setState(s);
    setVersions(v);
    if (s.status === "shared") setShareLink(`${window.location.origin}/b/${id}`);
    return s;
  }, [id]);

  useEffect(() => {
    // load() only sets state after awaiting the network, so this does not cascade renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().then(
      () => {},
      (e) => setError(String(e.message ?? e)),
    );
  }, [load]);

  async function act<T>(label: string, fn: () => Promise<T>) {
    setBusy(label);
    setError(null);
    try {
      const r = await fn();
      await load();
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const saveField = (f: Field) =>
    act(`save-${f.field_id}`, async () => {
      await callTool("correct_answer", id, { field_id: f.field_id, value: editing[f.field_id] }, newDecisionId());
      setEditing((e) => omit(e, f.field_id));
    });

  const setRedaction = (f: Field, accepted: boolean) =>
    act(`red-${f.field_id}`, () => callTool("set_redaction", id, { field_id: f.field_id, accepted }, newDecisionId()));

  const approve = () =>
    act("approve", async () => {
      await callTool("approve_revision", id, { revision: state!.revision }, newDecisionId());
      setBusy("versions");
      await callTool("generate_versions", id, {}, newDecisionId());
    });

  const regenerate = () => act("versions", () => callTool("generate_versions", id, {}, newDecisionId()));

  const share = () =>
    act("share", async () => {
      const r = await callTool<{ share_path: string }>("confirm_share", id, { revision: versions!.revision }, newDecisionId());
      setShareLink(`${window.location.origin}${r.share_path}`);
      setConfirmShare(false);
    });

  const cancel = () => {
    if (!confirm("Cancel this brief? Nothing will be shared, and it can't be undone.")) return;
    act("cancel", () => callTool("cancel", id, {}, newDecisionId()));
  };

  const backToInterview = () => act("back", () => callTool("back_to_interview", id, {}, newDecisionId()));

  if (!state) return <div className="p-8 text-stone-500">{error ?? "Loading review…"}</div>;

  const fields = state.fields;
  const missing = fields.filter((f) => f.status !== "known");
  const sensitive = fields.filter((f) => redactions(f).length > 0);
  const byKind = (k: string) => fields.filter((f) => f.value && f.kind === k);
  const stale = state.approved_revision != null && state.approved_revision !== state.revision;
  const canEdit = ["reviewing", "approved"].includes(state.status);
  const approved = state.status === "approved" || state.status === "shared";
  const ended = state.status === "cancelled";

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link href={`/s/${id}`} className="text-sm font-semibold text-teal-700">
          ← Interview
        </Link>
        <h1 className="flex-1 text-xl font-semibold text-stone-900">Review your problem brief</h1>
        <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-700">
          {state.status} · revision {state.revision}
        </span>
      </header>
      <p className="mt-1 text-sm text-stone-600">{state.input_line}</p>

      {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {stale && state.status === "reviewing" && (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          You approved revision {state.approved_revision}, but the brief has changed since (now revision {state.revision}). Re-approve
          before anything can be shared.
        </p>
      )}
      {ended && (
        <p className="mt-4 rounded-lg border border-stone-300 bg-stone-100 px-3 py-2 text-sm text-stone-700">
          This brief was cancelled. Nothing was shared.
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Editable fields */}
        <section className="space-y-3">
          <h2 className="font-semibold text-stone-900">Every answer — check and correct</h2>
          {fields.map((f) => {
            const draft = editing[f.field_id];
            return (
              <div key={f.field_id} className="rounded-xl border border-stone-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-stone-900">{f.label}</span>
                  {f.sensitive && <span title="Sensitive">🔒</span>}
                  <span className="ml-auto flex gap-1 text-[11px]">
                    {f.kind && <span className={`rounded px-1.5 py-0.5 font-medium ${KIND_STYLE[f.kind]}`}>{f.kind}</span>}
                    <span className="rounded bg-stone-100 px-1.5 py-0.5 text-stone-600">{STATUS_TEXT[f.status]}</span>
                  </span>
                </div>
                {draft !== undefined ? (
                  <div className="mt-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setEditing({ ...editing, [f.field_id]: e.target.value })}
                      rows={3}
                      className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => saveField(f)}
                        disabled={!draft.trim() || !!busy}
                        className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      >
                        {busy === `save-${f.field_id}` ? "Saving…" : "Save correction"}
                      </button>
                      <button
                        onClick={() => setEditing((e) => omit(e, f.field_id))}
                        className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className={`mt-1.5 text-sm ${f.value ? "text-stone-700" : "italic text-stone-400"}`}>
                      {f.value ?? STATUS_TEXT[f.status]}
                    </p>
                    {f.evidence_quote && f.value && <p className="mt-1 text-xs text-stone-500">“{f.evidence_quote}”</p>}
                    {canEdit && (
                      <button
                        onClick={() => setEditing({ ...editing, [f.field_id]: f.value ?? "" })}
                        className="mt-2 text-sm font-medium text-teal-700 hover:underline"
                      >
                        {f.value ? "Edit" : "Add answer"}
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </section>

        {/* Side: gaps, facts vs assumptions, redactions, approval */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-stone-200 bg-white p-4">
            <h3 className="font-semibold text-stone-900">Missing information ({missing.length})</h3>
            {missing.length === 0 ? (
              <p className="mt-1 text-sm text-stone-500">Nothing missing.</p>
            ) : (
              <ul className="mt-2 space-y-1.5 text-sm">
                {missing.map((f) => (
                  <li key={f.field_id} className="text-stone-700">
                    <span className="font-medium">{f.label}</span>
                    <span className="text-stone-500"> — {STATUS_TEXT[f.status].toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-stone-500">These stay visible in the brief as open questions — never filled in by guesswork.</p>
          </div>

          <div className="rounded-xl border border-stone-200 bg-white p-4">
            <h3 className="font-semibold text-stone-900">Facts vs assumptions</h3>
            {(["observation", "claim", "assumption"] as const).map((k) => (
              <div key={k} className="mt-2">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${KIND_STYLE[k]}`}>
                  {k} ({byKind(k).length})
                </span>
                <ul className="mt-1 space-y-0.5 text-sm text-stone-700">
                  {byKind(k).map((f) => (
                    <li key={f.field_id}>· {f.label}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-stone-200 bg-white p-4">
            <h3 className="font-semibold text-stone-900">Sensitive details ({sensitive.length})</h3>
            {sensitive.length === 0 && <p className="mt-1 text-sm text-stone-500">None flagged.</p>}
            {sensitive.map((f) => (
              <div key={f.field_id} className="mt-3 text-sm">
                {redactions(f).map((r) => (
                  <p key={r.item} className="text-stone-700">
                    <span className="rounded bg-red-50 px-1 line-through decoration-red-400">{r.item}</span> →{" "}
                    <span className="rounded bg-emerald-50 px-1">{r.replacement}</span>
                  </p>
                ))}
                <p className="mt-1 text-xs text-stone-500">
                  in {f.label} ·{" "}
                  {f.redaction_accepted === false ? "keeping original" : f.redaction_accepted ? "redaction accepted" : "redacted by default"}
                </p>
                {canEdit && (
                  <div className="mt-1.5 flex gap-2">
                    <button
                      onClick={() => setRedaction(f, true)}
                      disabled={!!busy || f.redaction_accepted === true}
                      className="rounded-md bg-emerald-700 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                    >
                      Redact in public
                    </button>
                    <button
                      onClick={() => setRedaction(f, false)}
                      disabled={!!busy || f.redaction_accepted === false}
                      className="rounded-md border border-stone-300 px-2 py-1 text-xs disabled:opacity-40"
                    >
                      OK to show
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {!ended && state.status !== "shared" && (
            <div className="rounded-xl border-2 border-teal-700 bg-white p-4">
              <h3 className="font-semibold text-stone-900">Approve</h3>
              {state.status === "reviewing" ? (
                <>
                  <p className="mt-1 text-sm text-stone-600">
                    You&apos;re approving exactly revision {state.revision}. Any later edit needs a fresh approval.
                  </p>
                  <button
                    onClick={approve}
                    disabled={!!busy}
                    className="mt-3 w-full rounded-lg bg-teal-700 px-3 py-2 font-medium text-white disabled:opacity-60"
                  >
                    {busy === "approve" ? "Approving…" : busy === "versions" ? "Writing versions…" : `Approve revision ${state.revision}`}
                  </button>
                  <button onClick={backToInterview} disabled={!!busy} className="mt-2 w-full text-sm text-teal-700 hover:underline">
                    Back to the interview
                  </button>
                </>
              ) : state.status === "approved" ? (
                <p className="mt-1 text-sm text-emerald-800">✓ Revision {state.approved_revision} approved.</p>
              ) : (
                <p className="mt-1 text-sm text-stone-600">Finish the interview first.</p>
              )}
              <button onClick={cancel} disabled={!!busy} className="mt-3 w-full text-sm text-red-700 hover:underline">
                Cancel brief
              </button>
            </div>
          )}
        </aside>
      </div>

      {/* Versions */}
      {approved && versions?.revision != null && (
        <section className="mt-8 rounded-2xl border border-stone-200 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-stone-200 px-4 py-3">
            {(Object.keys(AUDIENCE_LABEL) as Audience[]).map((a) => (
              <button
                key={a}
                onClick={() => setTab(a)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === a ? "bg-teal-700 text-white" : "text-stone-700 hover:bg-stone-100"}`}
              >
                {AUDIENCE_LABEL[a]}
              </button>
            ))}
            <span className="ml-auto text-xs text-stone-500">from approved revision {versions.revision}</span>
          </div>
          {versions.generated ? (
            <div className="p-5">
              <div className="mb-3 flex gap-2">
                <button
                  onClick={() => navigator.clipboard.writeText(versions[tab] ?? "")}
                  className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm"
                >
                  Copy
                </button>
                <a
                  href={`data:text/markdown;charset=utf-8,${encodeURIComponent(versions[tab] ?? "")}`}
                  download={`brief-${tab}-rev${versions.revision}.md`}
                  className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm"
                >
                  Download .md
                </a>
              </div>
              <Markdown text={versions[tab] ?? ""} />
            </div>
          ) : (
            <div className="p-5 text-sm text-stone-600">
              Versions not generated yet.{" "}
              <button onClick={regenerate} disabled={!!busy} className="font-medium text-teal-700 underline">
                {busy === "versions" ? "Writing…" : "Generate now"}
              </button>
            </div>
          )}

          {/* Share gate: separate, explicit confirmation */}
          <div className="border-t border-stone-200 px-5 py-4">
            {shareLink ? (
              <p className="text-sm text-emerald-800">
                ✓ Shared revision {versions.revision} (public, redacted) at{" "}
                <a href={shareLink} target="_blank" className="font-medium underline">
                  {shareLink}
                </a>{" "}
                · now listed on the{" "}
                <a href="/problems" target="_blank" className="font-medium underline">
                  Problem Board
                </a>
              </p>
            ) : state.status === "approved" && versions.generated ? (
              <button onClick={() => setConfirmShare(true)} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white">
                Share with builders…
              </button>
            ) : null}
          </div>
        </section>
      )}

      {confirmShare && versions?.public && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-xl">
            <div className="border-b border-stone-200 px-5 py-4">
              <h3 className="text-lg font-semibold text-stone-900">Share this exact brief?</h3>
              <p className="text-sm text-stone-600">
                This publishes the <strong>public, redacted</strong> version of <strong>revision {versions.revision}</strong> as a
                read-only link. Nothing else is shared.
              </p>
            </div>
            <div className="overflow-y-auto px-5 py-3">
              <Markdown text={versions.public} />
            </div>
            <div className="flex justify-end gap-2 border-t border-stone-200 px-5 py-3">
              <button onClick={() => setConfirmShare(false)} className="rounded-lg border border-stone-300 px-4 py-2 text-sm">
                Not yet
              </button>
              <button
                onClick={share}
                disabled={!!busy}
                className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                {busy === "share" ? "Sharing…" : `Yes, share revision ${versions.revision}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
