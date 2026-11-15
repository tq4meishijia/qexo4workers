/**
 * Cloudflare Turnstile verification for the login form.
 *
 * The browser only ever obtains a token from the widget; the canonical
 * siteverify call happens here, inside the Worker, before the existing login
 * handler runs. Never call siteverify from client-side code.
 *
 * TURNSTILE_SECRET and TURNSTILE_HOSTNAMES belong to the operator's secret
 * store (wrangler secret / .dev.vars). TURNSTILE_VERIFY_URL is a test-only
 * injection point; production must use the default Cloudflare endpoint.
 */

import type { Env } from "./lib";

export const TURNSTILE_ACTION = "login";
export const DEFAULT_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048;
const TIMEOUT_MS = 10_000;

export interface TurnstileConfig {
  enabled: boolean;
  siteKey: string;
  hostnames: string[];
}

/** Protection is active only when all three operator-supplied values exist. */
export function turnstileConfig(env: Env): TurnstileConfig {
  const siteKey = String(env.TURNSTILE_SITE_KEY || "").trim();
  const secret = String(env.TURNSTILE_SECRET || "").trim();
  const hostnames = String(env.TURNSTILE_HOSTNAMES || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return { enabled: !!(siteKey && secret && hostnames.length), siteKey, hostnames };
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

/**
 * Requires success === true, the expected action and an approved frontend
 * hostname. Any network/parse failure fails closed.
 */
export async function verifyTurnstile(env: Env, token: string, ip?: string): Promise<VerifyResult> {
  const cfg = turnstileConfig(env);
  if (!cfg.enabled) return { ok: false, detail: "turnstile not configured" };
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, detail: "invalid token length" };

  const body = new URLSearchParams({ secret: String(env.TURNSTILE_SECRET || "").trim(), response: token });
  if (ip) body.set("remoteip", ip);

  let data: any;
  try {
    const res = await fetch(String(env.TURNSTILE_VERIFY_URL || DEFAULT_SITEVERIFY_URL).trim(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, detail: `siteverify http ${res.status}` };
    data = await res.json();
  } catch (e) {
    return { ok: false, detail: `siteverify failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (data?.success !== true) return { ok: false, detail: "siteverify rejected token" };
  if (data.action !== TURNSTILE_ACTION) return { ok: false, detail: "unexpected action" };
  const hostname = String(data.hostname || "").toLowerCase();
  if (!cfg.hostnames.includes(hostname)) return { ok: false, detail: "unexpected hostname" };
  return { ok: true, detail: "verified" };
}
