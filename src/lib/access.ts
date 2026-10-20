// Single-owner access gate. The cookie holds "<expiry>.<HMAC(expiry)>", keyed by ACCESS_PASSWORD,
// so changing the password signs everyone out. Uses Web Crypto so it runs in the proxy and in routes.

export const ACCESS_COOKIE = "intake_access";
export const ACCESS_TTL_SECONDS = 7 * 24 * 60 * 60;

const enc = new TextEncoder();

async function hmac(data: string) {
  const secret = process.env.ACCESS_PASSWORD;
  if (!secret) throw new Error("ACCESS_PASSWORD is not set");
  const key = await crypto.subtle.importKey("raw", enc.encode(`intake:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createAccessToken() {
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS;
  return `${exp}.${await hmac(String(exp))}`;
}

export async function isValidAccessToken(token: string | undefined) {
  if (!token || !process.env.ACCESS_PASSWORD) return false; // fail closed
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, await hmac(exp));
}

export async function checkPassword(password: string) {
  const expected = process.env.ACCESS_PASSWORD;
  if (!expected) return false;
  // Compare HMACs so the comparison time doesn't depend on the password contents.
  return safeEqual(await hmac(`pw:${password}`), await hmac(`pw:${expected}`));
}

/** For API routes: returns a 401 response if the request isn't from the signed-in owner. */
export async function denyIfLocked(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  const token = cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${ACCESS_COOKIE}=`))
    ?.slice(ACCESS_COOKIE.length + 1);
  if (await isValidAccessToken(token)) return null;
  return Response.json({ ok: false, error: "Locked. Sign in at /login." }, { status: 401 });
}
