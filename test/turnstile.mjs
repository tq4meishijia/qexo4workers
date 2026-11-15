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

let cookie = "";
let csrf = "";

async function authedGet(path) {
  const res = await fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
  return res.json();
}

async function authedPost(path, body) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function expectDenied(label, extra) {
  const r = await login(extra);
  assert.notEqual(r.status, 429, `${label}: 触发限流，结果不可信`);
  assert.equal(r.data.status, false, `${label}: ${JSON.stringify(r.data)}`);
  return String(r.data.msg || "");
}

console.log("\nTurnstile login integration\n" + "=".repeat(52));

let validToken = "";

await step("默认：开关关闭，登录走原有路径", async () => {
  const me = await authedGet("/api/me");
  assert.equal(me.turnstile?.enabled, false, JSON.stringify(me.turnstile));
  const r = await login({});
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  cookie = r.headers.get("set-cookie")?.split(";")[0] || "";
  const meAfter = await authedGet("/api/me");
  csrf = meAfter.csrf || "";
  assert.ok(cookie && csrf, "会话或 CSRF 缺失");
  return "默认关闭时无需 Turnstile token";
});

await step("开启开关后立即生效（前置条件已齐备）", async () => {
  const on = await authedPost("/api/settings/turnstile", { enabled: "是" });
  assert.equal(on.data.status, true, JSON.stringify(on.data));
  assert.equal(on.data.turnstile.switch_on, true);
  assert.equal(on.data.turnstile.configured, true);
  assert.equal(on.data.turnstile.effective, true, JSON.stringify(on.data.turnstile));
  assert.ok(on.data.msg.includes("立即生效"), on.data.msg);
  const me = await authedGet("/api/me");
  assert.equal(me.turnstile.enabled, true);
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

await step("关闭开关后立即恢复原有登录路径", async () => {
  const off = await authedPost("/api/settings/turnstile", { enabled: "否" });
  assert.equal(off.data.status, true, JSON.stringify(off.data));
  assert.equal(off.data.turnstile.switch_on, false);
  assert.equal(off.data.turnstile.configured, true, "环境变量仍应齐备");
  assert.equal(off.data.turnstile.effective, false);
  const me = await authedGet("/api/me");
  assert.equal(me.turnstile.enabled, false);
  return "前置条件齐备但开关关闭时不生效";
});

console.log("=".repeat(52));
console.log(`${results.length - failures}/${results.length} passed, ${failures} failed`);
await servers.stop();
process.exit(failures ? 1 : 0);
