/**
 * Isolated Turnstile login integration check.
 *
 *   node test/turnstile.mjs
 *
 * Starts its own Worker + mock with Turnstile enabled. The regular suites stay
 * unchanged because they do not inject TURNSTILE_SECRET / TURNSTILE_HOSTNAMES.
 * The mock is a stand-in for Cloudflare's siteverify endpoint: no real widget
 * secret or network access is required, but the real /api/auth handler runs.
 */

import assert from "node:assert/strict";
import { startServers } from "./harness.mjs";

const SITEKEY = "0x4AAAAAAGBqe3KzCG_zIoD7";
const results = [];
let failures = 0;

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || "" });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failures++;
    results.push({ name, ok: false, detail: e.message });
    console.error(`  ✗ ${name} — ${e.message}`);
  }
}

const servers = await startServers({
  fresh: true,
  extraVars: [
    `TURNSTILE_SITE_KEY:${SITEKEY}`,
    "TURNSTILE_SECRET:test-turnstile-secret",
    "TURNSTILE_HOSTNAMES:localhost,127.0.0.1",
    "TURNSTILE_VERIFY_URL:http://127.0.0.1:8788/turnstile/siteverify",
  ],
});
const base = servers.base;
const mock = servers.mock;

async function post(path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers };
}

async function issue(query = "") {
  const r = await fetch(`${mock}/__turnstile/issue${query}`).then((res) => res.json());
  assert.ok(r.token, JSON.stringify(r));
  return r.token;
}

const login = (extra = {}) => post("/api/auth", { username: "admin", password: "admin123", ...extra });

async function expectDenied(label, extra) {
  const r = await login(extra);
  assert.notEqual(r.status, 429, `${label}: 触发限流，结果不可信`);
  assert.equal(r.data.status, false, `${label}: ${JSON.stringify(r.data)}`);
  return String(r.data.msg || "");
}

console.log("\nTurnstile login integration\n" + "=".repeat(52));

let validToken = "";

await step("配置：/api/me 下发 sitekey 且启用", async () => {
  const me = await fetch(base + "/api/me").then((r) => r.json());
  assert.equal(me.turnstile?.enabled, true, JSON.stringify(me.turnstile));
  assert.equal(me.turnstile.site_key, SITEKEY);
  return `site_key=${me.turnstile.site_key}`;
});

await step("无 token 被拒绝（省略字段不能绕过）", async () => {
  const msg = await expectDenied("no token", {});
  assert.ok(msg.includes("人机验证"), msg);
  return msg;
});

await step("伪造 token 被拒绝", async () => {
  const msg = await expectDenied("forged", { "cf-turnstile-response": "forged-token" });
  assert.ok(msg.includes("人机验证"), msg);
  return msg;
});

await step("合法 token 登录成功", async () => {
  validToken = await issue();
  const r = await login({ "cf-turnstile-response": validToken });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  assert.ok(r.headers.get("set-cookie"), "会话 Cookie 缺失");
  return "session cookie issued";
});

await step("重放同一 token 被拒绝", async () => {
  const msg = await expectDenied("replay", { "cf-turnstile-response": validToken });
  assert.ok(msg.includes("人机验证"), msg);
  return msg;
});

await step("action 不符被拒绝", async () => {
  const token = await issue("?action=signup");
  const msg = await expectDenied("action", { "cf-turnstile-response": token });
  return msg;
});

await step("hostname 不在白名单被拒绝", async () => {
  const token = await issue("?hostname=evil.example.com");
  const msg = await expectDenied("hostname", { "cf-turnstile-response": token });
  return msg;
});

await step("伪造 reCAPTCHA 字段不能绕过 Turnstile", async () => {
  const msg = await expectDenied("recaptcha bypass", { type: "v3", verify: "fake" });
  return msg;
});

await step("错误密码仍被拒绝（原登录逻辑保留）", async () => {
  const token = await issue();
  const r = await post("/api/auth", {
    username: "admin",
    password: "wrong",
    "cf-turnstile-response": token,
  });
  assert.notEqual(r.status, 429, "触发限流，结果不可信");
  assert.equal(r.data.status, false, JSON.stringify(r.data));
  assert.ok(String(r.data.msg).includes("密码"), JSON.stringify(r.data));
  return r.data.msg;
});

console.log("=".repeat(52));
console.log(`${results.length - failures}/${results.length} passed, ${failures} failed`);
await servers.stop();
process.exit(failures ? 1 : 0);
