/**
 * Cloudflare Turnstile verification for the login form.
 *
 * The browser only ever obtains a token from the widget; the canonical
 * siteverify call happens here, inside the Worker, before the existing login
 * handler runs. Never call siteverify from client-side code.
 *
 * Configuration has two sources: the operator's secret store (wrangler secret
 * / .dev.vars) and the values typed into "Settings -> Security" (stored in D1).
 * Environment values win when both exist, so an existing secret-store setup is
 * never weakened by adding the web form. The resolved secret stays server-side
 * and is never returned by any settings endpoint.
 *
 * TURNSTILE_VERIFY_URL is a test-only injection point; production must use the
 * default Cloudflare endpoint.
 */

import type { Env } from "./lib";
import { Store } from "./store";

export const TURNSTILE_ACTION = "login";
export const TURNSTILE_SWITCH_KEY = "TURNSTILE_ENABLED";
export const TURNSTILE_KEYS = {
  siteKey: "TURNSTILE_SITE_KEY",
  secret: "TURNSTILE_SECRET",
  hostnames: "TURNSTILE_HOSTNAMES",
} as const;
export const DEFAULT_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048;
const TIMEOUT_MS = 10_000;

export type ConfigSource = "env" | "stored" | "";

export interface TurnstileRuntime {
  configured: boolean;
  siteKey: string;
  /** Private: used only for the server-side siteverify call. */
  secret: string;
  hostnames: string[];
  missing: string[];
  sources: { siteKey: ConfigSource; secret: ConfigSource; hostnames: ConfigSource };
}

export interface TurnstileConfig extends TurnstileRuntime {
  /** Value of the admin switch in D1. */
  switchOn: boolean;
  /** Actually enforced: prerequisites met AND switch on. */
  enabled: boolean;
}

/** Environment values take priority; D1 values are the web-form fallback. */
export async function turnstileRuntime(env: Env, store: Store): Promise<TurnstileRuntime> {
  const envValues = {
    siteKey: String(env.TURNSTILE_SITE_KEY || "").trim(),
    secret: String(env.TURNSTILE_SECRET || "").trim(),
    hostnames: String(env.TURNSTILE_HOSTNAMES || "").trim(),
  };
  const storedValues = {
    siteKey: (await store.get(TURNSTILE_KEYS.siteKey, "")).trim(),
    secret: (await store.get(TURNSTILE_KEYS.secret, "")).trim(),
    hostnames: (await store.get(TURNSTILE_KEYS.hostnames, "")).trim(),
  };
  const pick = (name: "siteKey" | "secret" | "hostnames") =>
    envValues[name]
      ? { value: envValues[name], source: "env" as ConfigSource }
      : storedValues[name]
        ? { value: storedValues[name], source: "stored" as ConfigSource }
        : { value: "", source: "" as ConfigSource };

  const site = pick("siteKey");
  const secret = pick("secret");
  const rawHosts = pick("hostnames");
  const hostnames = rawHosts.value
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const missing: string[] = [];
  if (!site.value) missing.push(TURNSTILE_KEYS.siteKey);
  if (!secret.value) missing.push(TURNSTILE_KEYS.secret);
  if (!hostnames.length) missing.push(TURNSTILE_KEYS.hostnames);
  return {
    configured: missing.length === 0,
    siteKey: site.value,
    secret: secret.value,
    hostnames,
    missing,
    sources: { siteKey: site.source, secret: secret.source, hostnames: rawHosts.source },
  };
}

/** Store.set refreshes the isolate cache, so switching takes effect at once. */
export async function turnstileState(env: Env, store: Store): Promise<TurnstileConfig> {
  const base = await turnstileRuntime(env, store);
  const switchOn = (await store.get(TURNSTILE_SWITCH_KEY, "否")) === "是";
  return { ...base, switchOn, enabled: base.configured && switchOn };
}

/** Shape exposed to the settings page: flags and names, never secret values. */
export function turnstilePublicState(state: TurnstileConfig) {
  return {
    switch_on: state.switchOn,
    configured: state.configured,
    effective: state.enabled,
    missing: state.missing,
    site_key: state.siteKey,
    hostnames: state.hostnames,
    secret_set: !!state.secret,
    sources: state.sources,
  };
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

/**
 * Requires success === true, the expected action and an approved frontend
 * hostname. Any network/parse failure fails closed.
 */
export async function verifyTurnstile(env: Env, store: Store, token: string, ip?: string): Promise<VerifyResult> {
  const cfg = await turnstileRuntime(env, store);
  if (!cfg.configured) return { ok: false, detail: "turnstile not configured" };
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, detail: "invalid token length" };

  const body = new URLSearchParams({ secret: cfg.secret, response: token });
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
