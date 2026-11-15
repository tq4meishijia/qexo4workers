/**
 * Shared runtime helpers: HTTP envelopes, WebCrypto, cookies, body parsing,
 * router. Zero npm dependencies so the bundle stays tiny and cold starts fast.
 */

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  KV?: KVNamespace;
  R2?: R2Bucket;
  PUBLIC_ORIGIN?: string;
  GITHUB_API_BASE?: string;
  SESSION_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_HOSTNAMES?: string;
  TURNSTILE_VERIFY_URL?: string;
}

export interface SessionUser {
  id: string;
  username: string;
  is_staff: number;
}

export interface Session {
  id: string;
  user_id: string;
  csrf: string;
  expires_at: number;
}

export interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
  user?: SessionUser;
  session?: Session;
  ip: string;
}

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

export class HttpError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

/** Qexo wire format: every endpoint answers { status, msg, ... }. */
export function ok(msg = "", extra: Record<string, unknown> = {}): Response {
  return json({ msg, status: true, ...extra });
}

export function fail(msg: string, status = 200, extra: Record<string, unknown> = {}): Response {
  return json({ msg, status: false, ...extra }, status);
}

export function text(body: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType, ...SECURITY_HEADERS } });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'self'; img-src * data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'",
      ...SECURITY_HEADERS,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                             */
/* ------------------------------------------------------------------ */

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    let src = "";
    for (const part of pattern.split("/")) {
      if (!part) continue;
      if (part === "*") {
        src += "/(.*)";
        keys.push("wildcard");
      } else if (part.startsWith(":")) {
        src += "/([^/]+)";
        keys.push(part.slice(1));
      } else {
        src += "/" + part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }
    this.routes.push({ method, re: new RegExp("^" + (src || "/") + "/?$"), keys, handler });
    return this;
  }

  get(p: string, h: Handler) { return this.add("GET", p, h); }
  post(p: string, h: Handler) { return this.add("POST", p, h); }
  put(p: string, h: Handler) { return this.add("PUT", p, h); }
  del(p: string, h: Handler) { return this.add("DELETE", p, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method && !(r.method === "GET" && method === "HEAD")) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
      return { handler: r.handler, params };
    }
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Crypto                                                             */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8ToB64(s: string): string {
  return b64encode(enc.encode(s));
}

export function b64ToUtf8(s: string): string {
  return dec.decode(b64decode(s));
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomHex(n = 16): string {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}

export function uuid(): string {
  return crypto.randomUUID();
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return hex(digest);
}

export async function hmacHex(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(input));
  return hex(sig);
}

/** Length-independent comparison that does not short-circuit. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [alg, iter, saltB64, hashB64] = stored.split("$");
    if (alg !== "pbkdf2-sha256") return false;
    const bits = await pbkdf2(password, b64decode(saltB64), Number(iter));
    return safeEqual(b64encode(bits), hashB64);
  } catch {
    return false;
  }
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/* ------------------------------------------------------------------ */
/* Cookies & request body                                             */
/* ------------------------------------------------------------------ */

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; secure?: boolean; httpOnly?: boolean; sameSite?: string; path?: string } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export interface ParsedBody {
  [key: string]: unknown;
}

/** Accepts JSON, urlencoded and multipart bodies; files are kept as File. */
export async function readBody(req: Request): Promise<ParsedBody> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return (await req.json()) as ParsedBody;
    } catch {
      return {};
    }
  }
  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    const fd = await req.formData();
    const out: ParsedBody = {};
    for (const [k, v] of fd.entries()) {
      if (k in out) {
        const prev = out[k];
        out[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  const raw = await req.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const out: ParsedBody = {};
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
    return out;
  }
}

export function str(body: ParsedBody, key: string, fallback = ""): string {
  const v = body[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v === "string") return v;
  return String(v);
}

export function firstFile(body: ParsedBody): File | null {
  const candidates = [body["file[]"], body["file"], body["files[]"]];
  for (const c of candidates) {
    if (c instanceof File) return c;
    if (Array.isArray(c) && c[0] instanceof File) return c[0];
  }
  for (const v of Object.values(body)) {
    if (v instanceof File) return v;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Misc                                                               */
/* ------------------------------------------------------------------ */

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function toInt(v: unknown, fallback = 0): number {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function toFloat(v: unknown, fallback = 0): number {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

export function bytesToHuman(size: number): string {
  if (!size) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(ts: number): string {
  const d = new Date(ts * 1000 + 8 * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** Content-Disposition helper that keeps non-ASCII filenames intact. */
export function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
