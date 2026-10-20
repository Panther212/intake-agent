import { ACCESS_COOKIE } from "@/lib/access";

export async function POST() {
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", `${ACCESS_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res;
}
