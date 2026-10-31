import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "__Host-tessera-session";
const SESSION_SECONDS = 12 * 60 * 60;

export function cloudSessionAuthenticated(request: Request, secret: string): boolean {
  const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim())
    .find((item) => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!cookie) return false;
  const parts = cookie.split(".");
  if (parts.length !== 2) return false;
  const [expires, signature] = parts;
  if (!expires || !signature || !/^\d+$/u.test(expires)
    || !Number.isSafeInteger(Number(expires)) || Number(expires) <= Date.now()
    || !/^[a-f0-9]{64}$/u.test(signature)) return false;
  const expected = sign(expires, secret);
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/** Protect the single shared workspace before exposing credentials or data. */
export async function handleCloudLogin(request: Request, secret: string): Promise<Response> {
  const url = new URL(request.url);
  const destination = url.pathname.startsWith("/feishu") || url.searchParams.get("next") === "feishu" ? "/feishu" : "/";
  if (request.method === "POST") {
    if (request.headers.get("origin") !== url.origin) return new Response("Forbidden", { status: 403 });
    const form = await request.formData();
    const password = form.get("password");
    const valid = typeof password === "string" && password.length <= 512 && timingSafeEqual(
      createHash("sha256").update(password).digest(), createHash("sha256").update(secret).digest(),
    );
    if (valid) {
      const expires = String(Date.now() + SESSION_SECONDS * 1_000);
      return new Response(null, { status: 303, headers: {
        Location: destination, "Cache-Control": "no-store",
        "Set-Cookie": `${SESSION_COOKIE}=${expires}.${sign(expires, secret)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`,
      } });
    }
  }
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera Studio</title><style>
  :root { color-scheme:light dark; font-family:Inter,system-ui,sans-serif; background:light-dark(#fafafa,#0a0a0a); color:light-dark(#18181b,#fafafa) } * {box-sizing:border-box} body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px} main{width:100%;max-width:340px} h1{font-size:25px;letter-spacing:-1px} p{font-size:14px;opacity:.65;line-height:1.7} label{font-size:13px} input,button{width:100%;border-radius:10px;padding:12px;margin-top:10px;font:inherit;border:1px solid light-dark(#ddd,#333);background:transparent;color:inherit} button{background:light-dark(#18181b,#fafafa);color:light-dark(#fff,#18181b);cursor:pointer} small{display:block;margin-top:18px;opacity:.55}
  </style></head><body><main><h1>Tessera Studio</h1><p>输入工作区访问密码，继续使用你的 Agent。</p><form action="/auth/login${destination === "/feishu" ? "?next=feishu" : ""}" method="post"><label for="password">工作区密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="512" required autofocus><button type="submit">进入工作区</button></form>${request.method === "POST" ? "<p role=\"alert\">密码不正确，请重试。</p>" : ""}<small>Powered by Mastra</small></main></body></html>`, {
    status: request.method === "POST" ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" },
  });
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(`tessera-session:${value}`).digest("hex");
}
