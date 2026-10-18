import { Modality } from "@google/genai";
import { z, ZodError } from "zod";
import { ai } from "@/lib/llm";
import { runTool, ToolError } from "@/lib/tools";
import { INTERVIEWER_RULES, TOOL_DECLARATIONS, VOICE_RULES, stateForPrompt } from "@/lib/interviewer";

const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-2.5-flash-native-audio-latest";

/**
 * Issues a single-use ephemeral Live API token. The system prompt (with the current brief state and
 * recent conversation) and tools are locked into the token, so the browser never sees the API key
 * and cannot change the agent's instructions. Called again on every reconnect, so a fresh session
 * always resumes from the backend's state.
 */
export async function POST(request: Request) {
  try {
    const { session_id: sid } = z.object({ session_id: z.string().uuid() }).parse(await request.json());
    const state = (await runTool("get_session", sid, {})) as Parameters<typeof stateForPrompt>[0] & {
      messages: { role: string; content: string }[];
    };
    if (!["interviewing", "paused"].includes(state.status)) {
      throw new ToolError(`Voice is only available during the interview (session is ${state.status}).`);
    }
    const recent = state.messages
      .filter((m) => m.role !== "system")
      .slice(-12)
      .map((m) => `${m.role === "user" ? "Owner" : "You"}: ${m.content}`)
      .join("\n");

    const config = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: `${INTERVIEWER_RULES}\n\n${VOICE_RULES}\n\n${stateForPrompt(state)}\n\nConversation so far:\n${recent || "(none yet)"}`,
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };

    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
        liveConnectConstraints: { model: LIVE_MODEL, config },
        httpOptions: { apiVersion: "v1alpha" },
      },
    });
    return Response.json({ ok: true, token: token.name, model: LIVE_MODEL, config, status: state.status });
  } catch (e) {
    if (e instanceof ToolError || e instanceof ZodError) {
      return Response.json({ ok: false, error: e.message }, { status: 400 });
    }
    console.error("[api/token]", e);
    return Response.json({ ok: false, error: "Could not start voice. Try again or use text." }, { status: 500 });
  }
}
