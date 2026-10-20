// Website reading and LLM calls can take a while; give serverless functions room.
export const maxDuration = 60;

import { denyIfLocked } from "@/lib/access";
import type { Content, Part } from "@google/genai";
import { z, ZodError } from "zod";
import { ai, TEXT_MODEL, ThinkingLevel } from "@/lib/llm";
import { sql } from "@/lib/db";
import { runTool, ToolError } from "@/lib/tools";
import { AGENT_TOOL_NAMES, INTERVIEWER_RULES, TOOL_DECLARATIONS, stateForPrompt } from "@/lib/interviewer";

const Body = z.object({
  session_id: z.string().uuid(),
  message: z.string().trim().max(4000).nullish(), // null = start of the interview
});

type ToolEvent = { name: string; args: unknown; ok: boolean; result?: unknown; error?: string };

export async function POST(request: Request) {
  const locked = await denyIfLocked(request);
  if (locked) return locked;
  try {
    const { session_id: sid, message } = Body.parse(await request.json());
    const state = (await runTool("get_session", sid, {})) as Parameters<typeof stateForPrompt>[0] & {
      messages: { role: string; content: string }[];
    };

    if (!["interviewing", "paused"].includes(state.status)) {
      return Response.json({
        ok: true,
        reply: `This interview is ${state.status}. ${["reviewing", "approved"].includes(state.status) ? "Open the review screen to check and approve the brief." : ""}`.trim(),
        events: [],
      });
    }

    // Rebuild the conversation from the database (the backend is the source of truth).
    const contents: Content[] = state.messages
      .filter((m) => m.role !== "system")
      .slice(-24)
      .map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.content }] }));

    if (message) {
      contents.push({ role: "user", parts: [{ text: message }] });
    } else if (state.messages.length === 0) {
      contents.push({
        role: "user",
        parts: [{ text: "(The owner just opened the interview. Greet them in one short sentence, mention in one sentence what you already understood from their website/problem line, then ask the first question.)" }],
      });
    } else {
      contents.push({
        role: "user",
        parts: [{ text: "(The owner just came back to this interview. Welcome them back in a few words, call resume if the session is paused, then ask the next question.)" }],
      });
    }

    const events: ToolEvent[] = [];
    let reply = "";
    for (let step = 0; step < 6; step++) {
      const fresh = (await runTool("get_session", sid, {})) as Parameters<typeof stateForPrompt>[0];
      const res = await ai.models.generateContent({
        model: TEXT_MODEL,
        contents,
        config: {
          systemInstruction: `${INTERVIEWER_RULES}\n\n${stateForPrompt(fresh)}`,
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          temperature: 0.4,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });
      const calls = res.functionCalls ?? [];
      if (!calls.length) {
        reply = res.text?.trim() ?? "";
        break;
      }
      // Keep the model's own content (incl. thought signatures) before answering its calls.
      contents.push(res.candidates?.[0]?.content ?? { role: "model", parts: calls.map((c) => ({ functionCall: c })) });
      const responses: Part[] = [];
      for (const call of calls) {
        const name = call.name ?? "";
        let response: Record<string, unknown>;
        try {
          if (!AGENT_TOOL_NAMES.includes(name)) throw new ToolError(`Tool ${name} not available here`);
          const result = await runTool(name, sid, call.args ?? {});
          events.push({ name, args: call.args, ok: true, result });
          response = { result };
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          events.push({ name, args: call.args, ok: false, error });
          response = { error };
        }
        responses.push({ functionResponse: { id: call.id, name, response } });
      }
      contents.push({ role: "user", parts: responses });
    }

    if (!reply) reply = "Sorry, I lost my train of thought. Could you say that again?";
    // Logged only after a successful turn, so a client retry never duplicates the user's message.
    if (message) await runTool("log_message", sid, { role: "user", channel: "text", content: message });
    await runTool("log_message", sid, { role: "agent", channel: "text", content: reply });
    const status = ((await sql`select status from sessions where id = ${sid}`)[0]?.status as string) ?? state.status;
    return Response.json({ ok: true, reply, events, status });
  } catch (e) {
    if (e instanceof ToolError || e instanceof ZodError) {
      return Response.json({ ok: false, error: e.message }, { status: 400 });
    }
    console.error("[api/chat]", e);
    return Response.json({ ok: false, error: "The interviewer hit an error. Please try again." }, { status: 500 });
  }
}
