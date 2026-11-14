/**
 * Session + auth primitives. Qexo relied on Django's session middleware and
 * django-passkeys; here sessions are signed opaque ids stored in D1, and
 * every mutating cookie-authenticated request must present the session CSRF
 * token.
 */

import {
  HttpError,
  getCookie,
  hmacHex,
  nowSec,
  safeEqual,
  serializeCookie,
  sha256Hex,
  uuid,
  verifyPassword,
  hashPassword,
  type Ctx,
  type Env,
  type Session,
  type SessionUser,
} from "./lib";
import { Store } from "./store";

const COOKIE = "qexo_session";
const SESSION_TTL = 7 * 24 * 3600;
const SECRET_SETTING = "_SESSION_SECRET";

export async function sessionSecret(env: Env): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const store = new Store(env);
  let secret = await store.get(SECRET_SETTING);
  if (!secret) {
    secret = crypto.randomUUID() + crypto.randomUUID();
    await store.set(SECRET_SETTING, secret);
  }
  return secret;
}

export async function createSession(env: Env, userId: string, req: Request): Promise<{ session: Session; cookie: string }> {
  const id = uuid();
  const csrf = crypto.randomUUID();
  const expires = nowSec() + SESSION_TTL;
  const ip = req.headers.get("cf-connecting-ip") || "";
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, csrf, created_at, expires_at, ua, ip) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, userId, csrf, nowSec(), expires, (req.headers.get("user-agent") || "").slice(0, 255), ip)
    .run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowSec()).run();
  const sig = await hmacHex(await sessionSecret(env), id);
  const secure = new URL(req.url).protocol === "https:";
  const cookie = serializeCookie(COOKIE, `${id}.${sig}`, { maxAge: SESSION_TTL, secure, sameSite: "Lax" });
  return { session: { id, user_id: userId, csrf, expires_at: expires }, cookie };
}

export function clearSessionCookie(): string {
  return serializeCookie(COOKIE, "", { maxAge: 0 });
}

export async function resolveSession(env: Env, req: Request): Promise<{ session: Session; user: SessionUser } | null> {
  const raw = getCookie(req, COOKIE);
  if (!raw) return null;
  const [id, sig] = raw.split(".");
  if (!id || !sig) return null;
  const expected = await hmacHex(await sessionSecret(env), id);
  if (!safeEqual(sig, expected)) return null;
  const session = await env.DB.prepare("SELECT id, user_id, csrf, expires_at FROM sessions WHERE id = ?")
    .bind(id)
    .first<Session>();
  if (!session || session.expires_at < nowSec()) return null;
  const user = await env.DB.prepare("SELECT id, username, is_staff FROM users WHERE id = ?")
    .bind(session.user_id)
    .first<SessionUser>();
  if (!user) return null;
  return { session, user };
}

export async function destroySession(env: Env, req: Request): Promise<void> {
  const raw = getCookie(req, COOKIE);
  if (!raw) return;
  const [id] = raw.split(".");
  if (id) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

export function assertCsrf(ctx: Ctx): void {
  if (!ctx.session) return;
  const method = ctx.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const token = ctx.req.headers.get("x-csrf-token") || "";
  if (!safeEqual(token, ctx.session.csrf)) throw new HttpError("CSRF 校验失败，请刷新页面", 403);
}

export async function requireUser(ctx: Ctx): Promise<SessionUser> {
  if (!ctx.user) throw new HttpError("未登录", 401);
  return ctx.user;
}

export async function requireStaff(ctx: Ctx): Promise<SessionUser> {
  const user = await requireUser(ctx);
  if (!user.is_staff) throw new HttpError("无权限", 403);
  return user;
}

/** Mirrors check_if_api_auth(): token param compared to sha256(WEBHOOK_APIKEY). */
export async function checkApiToken(env: Env, req: Request): Promise<boolean> {
  const url = new URL(req.url);
  let token = url.searchParams.get("token") || req.headers.get("x-api-key") || "";
  if (!token && (req.method === "POST" || req.method === "PUT")) {
    const ct = req.headers.get("content-type") || "";
    try {
      if (ct.includes("application/json")) {
        const clone = req.clone();
        token = String(((await clone.json()) as any)?.token || "");
      } else if (ct.includes("form")) {
        const clone = req.clone();
        token = String((await clone.formData()).get("token") || "");
      }
    } catch {
      token = "";
    }
  }
  if (!token) return false;
  const store = new Store(env);
  const expected = await store.get("WEBHOOK_APIKEY");
  if (!expected) return false;
  return safeEqual(await sha256Hex(token), expected);
}

export async function readConfigToken(env: Env): Promise<string | null> {
  const token = await new Store(env).get("WEBHOOK_APIKEY");
  return token || null;
}

/* ------------------------------------------------------------------ */
/* Rate limiting (D1, fixed window)                                   */
/* ------------------------------------------------------------------ */

export async function rateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = nowSec();
  const row = await env.DB.prepare("SELECT count, reset_at FROM rate_limits WHERE key = ?").bind(key).first<{
    count: number;
    reset_at: number;
  }>();
  if (!row || row.reset_at < now) {
    await env.DB.prepare(
      "INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?) " +
        "ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at",
    )
      .bind(key, now + windowSec)
      .run();
    return true;
  }
  if (row.count >= limit) return false;
  await env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").bind(key).run();
  return true;
}

/* ------------------------------------------------------------------ */
/* Users                                                              */
/* ------------------------------------------------------------------ */

export async function createUser(env: Env, username: string, password: string): Promise<string> {
  const id = uuid();
  const hash = await hashPassword(password);
  await env.DB.prepare("INSERT INTO users (id, username, password_hash, is_staff, created_at) VALUES (?, ?, ?, 1, ?)")
    .bind(id, username, hash, nowSec())
    .run();
  return id;
}

export async function authenticate(env: Env, username: string, password: string): Promise<SessionUser | null> {
  const row = await env.DB.prepare("SELECT id, username, password_hash, is_staff FROM users WHERE username = ?")
    .bind(username)
    .first<{ id: string; username: string; password_hash: string; is_staff: number }>();
  if (!row) return null;
  if (!(await verifyPassword(password, row.password_hash))) return null;
  await env.DB.prepare("UPDATE users SET last_login = ? WHERE id = ?").bind(nowSec(), row.id).run();
  return { id: row.id, username: row.username, is_staff: row.is_staff };
}

export async function replaceUser(env: Env, userId: string, username: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await env.DB.prepare("UPDATE users SET username = ?, password_hash = ? WHERE id = ?").bind(username, hash, userId).run();
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

export async function countUsers(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

/* ------------------------------------------------------------------ */
/* reCAPTCHA                                                          */
/* ------------------------------------------------------------------ */

export async function verifyRecaptcha(
  secret: string,
  token: string,
  kind: "v2" | "v3",
  ip?: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!secret) return { ok: false, detail: "recaptcha secret missing" };
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set("remoteip", ip);
  const res = await fetch("https://www.google.com/recaptcha/api/siteverify", { method: "POST", body });
  const data: any = await res.json().catch(() => ({}));
  if (kind === "v3") {
    const score = Number(data?.score ?? 0);
    return { ok: score > 0.5, detail: JSON.stringify(data) };
  }
  return { ok: !!data?.success, detail: JSON.stringify(data) };
}
