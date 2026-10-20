import { z } from "zod";
import { ACCESS_COOKIE, ACCESS_TTL_SECONDS, checkPassword, createAccessToken } from "@/lib/access";

export async function POST(request: Request) {
  if (!process.env.ACCESS_PASSWORD) {
    return Response.json({ ok: false, error: "ACCESS_PASSWORD is not configured on the server." }, { status: 503 });
  }
  const parsed = z.object({ password: z.string().max(200) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success || !(await checkPassword(parsed.data.password))) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return Response.json({ ok: false, error: "Wrong password." }, { status: 401 });
  }
  const res = Response.json({ ok: true });
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  res.headers.append(
    "Set-Cookie",
    `${ACCESS_COOKIE}=${await createAccessToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ACCESS_TTL_SECONDS}${secure}`,
  );
  return res;
}
