// Website reading and LLM calls can take a while; give serverless functions room.
export const maxDuration = 60;

import { z, ZodError } from "zod";
import { runTool, ToolError } from "@/lib/tools";

const Body = z.object({
  name: z.string(),
  session_id: z.string().uuid().nullish(),
  decision_id: z.string().min(1).optional(),
  args: z.unknown().optional(),
});

export async function POST(request: Request) {
  try {
    const body = Body.parse(await request.json());
    const result = await runTool(body.name, body.session_id ?? null, body.args, body.decision_id);
    return Response.json({ ok: true, result });
  } catch (e) {
    if (e instanceof ToolError || e instanceof ZodError) {
      const error = e instanceof ZodError ? z.prettifyError(e) : e.message;
      return Response.json({ ok: false, error }, { status: 400 });
    }
    console.error("[api/tool]", e);
    return Response.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
