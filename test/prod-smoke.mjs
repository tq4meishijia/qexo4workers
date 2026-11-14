/**
 * Production smoke test against a deployed Worker.
 *
 *   node test/prod-smoke.mjs https://qexo-workers.<sub>.workers.dev
 *
 * Initializes a fresh deployment (if needed), then exercises auth, content
 * read path, friends, talks, analytics and MCP against the real Cloudflare
 * runtime. Writes are limited to DB-backed features; the Git repo is a public
 * demo used read-only.
 */

import fs from "node:fs";
import crypto from "node:crypto";

const BASE = (process.argv[2] || "https://qexo-workers.tq4meishijia.workers.dev").replace(/\/+$/, "");
const CRED_FILE = "test/out/deploy-credentials.txt";
const results = [];
let failures = 0;
let skipped = 0;

async function skipStep(name, reason) {
  skipped++;
  results.push({ name, skipped: true, detail: reason });
  console.log(`  · ${name} — skipped: ${reason}`);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail: detail || "" });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
    return detail;
  } catch (e) {
    failures++;
    results.push({ name, ok: false, ms: Date.now() - started, detail: e.message });
    console.error(`  ✗ ${name} — ${e.message}`);
    return null;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

class Client {
  constructor(base) {
    this.base = base;
    this.cookie = "";
    this.csrf = "";
  }
  async req(path, { method = "GET", body, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.csrf && method !== "GET") h["X-CSRF-Token"] = this.csrf;
    let payload;
    if (body !== undefined) {
      h["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + path, { method, headers: h, body: payload });
    for (const c of res.headers.getSetCookie?.() || []) {
      if (c.startsWith("qexo_session=")) this.cookie = c.split(";")[0];
    }
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json().catch(() => null) : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  get(p, headers) {
    return this.req(p, { headers });
  }
  post(p, body, headers) {
    return this.req(p, { method: "POST", body, headers });
  }
  del(p, body) {
    return this.req(p, { method: "DELETE", body });
  }
}

console.log(`\nQexo production smoke → ${BASE}\n${"=".repeat(56)}`);

const client = new Client(BASE);

await step("页面守卫：未登录访问 / 跳转 /login", async () => {
  const res = await fetch(BASE + "/", { redirect: "manual" });
  assert(res.status === 302, `expected 302, got ${res.status}`);
  const location = res.headers.get("location") || "";
  assert(location.includes("/login?next="), location);
  const login = await fetch(BASE + "/login");
  assert(login.status === 200, `login page HTTP ${login.status}`);
  const html = await login.text();
  assert(html.includes('id="login-form"'), "standalone login page missing");
  const css = await fetch(BASE + "/style.css");
  assert(css.status === 200, "style.css not served");
  return `302 → ${new URL(location).pathname}, login ${html.length} bytes`;
});

let password = "";
let username = "admin";
if (fs.existsSync(CRED_FILE)) {
  const text = fs.readFileSync(CRED_FILE, "utf8");
  username = /username=(.+)/.exec(text)?.[1]?.trim() || "admin";
  password = /password=(.+)/.exec(text)?.[1]?.trim() || "";
}

let initState = null;
await step("读取初始化状态", async () => {
  const r = await client.get("/api/init/state");
  assert(r.data?.status === true, JSON.stringify(r.data));
  initState = r.data;
  return `init=${r.data.init}, users=${r.data.users}`;
});

if (initState && initState.init < 6) {
  if (!password) {
    username = "admin";
    password = "admin123";
  }

  await step("初始化：语言", async () => {
    const r = await client.post("/api/init_step", { step: "1", language: "zh_CN" });
    assert(r.data?.status === true, JSON.stringify(r.data));
  });

  await step("初始化：内容源（公开示例仓库，只读）", async () => {
    const cfg = {
      provider: "github",
      params: { token: "", repo: "hexojs/hexo-starter", branch: "master", path: "", config: "Hexo" },
    };
    const r = await client.post("/api/init_step", { step: "3", provider: JSON.stringify(cfg), force: "true" });
    assert(r.data?.status === true, JSON.stringify(r.data));
  });

  await step("初始化：完成", async () => {
    const r = await client.post("/api/init_step", { step: "4", kind: "" });
    assert(r.data?.status === true, JSON.stringify(r.data));
    assert(r.data.next_step === 6, JSON.stringify(r.data));
    fs.mkdirSync("test/out", { recursive: true });
    fs.writeFileSync(CRED_FILE, `url=${BASE}\nusername=${username}\npassword=${password}\n`);
  });
} else {
  console.log("  · 已完成初始化，跳过向导");
  if (!password) {
    username = "admin";
    password = "admin123";
  }
}

await step("登录并获取 CSRF", async () => {
  if (!password) throw new Error("no credentials available for login");
  const r = await client.post("/api/auth", { username, password });
  assert(r.data?.status === true, JSON.stringify(r.data));
  const me = await client.get("/api/me");
  assert(me.data?.user?.username === username, "me mismatch");
  assert(me.data.default_admin === true, "default-password warning flag missing");
  assert(me.data.version === "1.0.0", `unexpected runtime version: ${me.data.version}`);
  client.csrf = me.data.csrf;
  assert(client.csrf, "missing csrf");
  return `session ok, version=${me.data.version}`;
});

await step("页面守卫：登录后可访问 /", async () => {
  const res = await fetch(BASE + "/", { headers: { Cookie: client.cookie }, redirect: "manual" });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const html = await res.text();
  assert(html.includes('id="app"'), "admin shell missing");
  return "200 index.html";
});

await step("控制台聚合", async () => {
  const r = await client.get("/api/dashboard");
  assert(r.data?.status === true, JSON.stringify(r.data));
  assert(typeof r.data.provider.repo === "string" && r.data.provider.repo.includes("/"), JSON.stringify(r.data.provider));
  assert(r.data.provider.platform === "Hexo", JSON.stringify(r.data.provider));
  return `repo=${r.data.provider.repo}, posts=${r.data.counts.post}, pages=${r.data.counts.page}`;
});

// Cloudflare egress IPs share GitHub's anonymous quota (60/h per IP), which is
// effectively always exhausted. Content reads therefore require a real token.
const settings = await client.get("/api/settings");
const providerCfg = JSON.parse(settings.data?.raw?.PROVIDER || "{}");
const hasToken = !!providerCfg?.params?.token;

if (hasToken) {
  await step("内容索引：读取仓库", async () => {
    const r = await client.post("/api/posts/refresh", {});
    assert(r.data?.status === true, JSON.stringify(r.data));
    assert(r.data.counts.posts >= 1, `posts=${r.data.counts.posts}`);
    const list = await client.get("/api/posts");
    const names = list.data.data.map((p) => p.name);
    assert(names.includes("hello-world"), names.join(","));
    return `${r.data.counts.posts} posts, ${r.data.counts.configs} configs`;
  });

  await step("读取文章与配置", async () => {
    const post = await client.get("/api/post?path=" + encodeURIComponent("source/_posts/hello-world.md"));
    assert(post.data?.status === true, JSON.stringify(post.data));
    assert(post.data.front_matter.title, "missing title");
    const cfg = await client.get("/api/config?path=_config.yml");
    assert(cfg.data.content.includes("Hexo"), "config content unexpected");
    return post.data.front_matter.title;
  });
} else {
  await skipStep("内容索引：读取仓库", "未配置 GitHub Token（Cloudflare 出口触发匿名限流）");
  await skipStep("读取文章与配置", "未配置 GitHub Token");
}

await step("内容源：未登录不可枚举仓库", async () => {
  const anon = new Client(BASE);
  const r = await anon.post("/api/settings/github/repos", { token: "whatever" });
  assert(r.status === 401, `expected 401, got ${r.status}`);
});

await step("内容源：密钥检测接口可用", async () => {
  const r = await client.post("/api/settings/github/repos", {});
  if (r.status === 400) {
    assert(/密钥/.test(r.data?.msg || ""), JSON.stringify(r.data));
    return "未配置密钥 → 明确提示";
  }
  assert(r.status === 200 && r.data?.status === true, JSON.stringify(r.data));
  return `已配置密钥 → ${r.data.repos.length} 个仓库`;
});

await step("友链：写入 → 公开读取 → 删除", async () => {
  const add = await client.post("/api/friends", {
    name: "Prod Smoke",
    url: "https://example.com",
    image: "",
    description: "deployment check",
    status: "显示",
  });
  assert(add.data?.status === true, JSON.stringify(add.data));
  const time = add.data.time;
  const pub = await fetch(BASE + "/pub/friends").then((r) => r.json());
  assert(pub.data.some((f) => f.name === "Prod Smoke"), JSON.stringify(pub));
  const del = await client.del("/api/friends", { time });
  assert(del.data?.status === true, JSON.stringify(del.data));
  return "CRUD ok";
});

await step("说说：发布 → 公开分页 → 删除", async () => {
  const add = await client.post("/api/talks", { content: "线上冒烟测试", tags: '["prod"]', values: "{}" });
  assert(add.data?.status === true, JSON.stringify(add.data));
  const id = add.data.id;
  const pub = await fetch(BASE + "/pub/talks?page=1&limit=5").then((r) => r.json());
  assert(pub.data.some((t) => t.id === id), JSON.stringify(pub));
  const del = await client.del("/api/talks", { id });
  assert(del.data?.status === true, JSON.stringify(del.data));
  return "CRUD ok";
});

await step("统计：开启并累计 PV/UV", async () => {
  const host = new URL(BASE).hostname;
  let r = await client.post("/api/settings", { group: "statistic", allow: "是", domains: host });
  assert(r.data?.status === true, JSON.stringify(r.data));
  const stat = await fetch(BASE + "/pub/statistic", { headers: { Referer: `${BASE}/hello` } }).then((x) => x.json());
  assert(stat.status === true, JSON.stringify(stat));
  assert(stat.site_pv >= 1 && stat.page_pv >= 1, JSON.stringify(stat));
  return `pv=${stat.site_pv}, uv=${stat.site_uv}`;
});

let mcpToken = "";
await step("MCP：创建令牌并握手", async () => {
  const created = await client.post("/api/mcp/tokens", { name: "prod-smoke", scopes: ["read"] });
  assert(created.data?.status === true, JSON.stringify(created.data));
  mcpToken = created.data.token;
  assert(mcpToken.startsWith("qx_mcp_"), "bad token prefix");
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "prod", version: "1" } },
    }),
  });
  const data = await res.json();
  assert(data.result?.serverInfo?.name === "qexo-workers", JSON.stringify(data));
  return `protocol=${data.result.protocolVersion}`;
});

await step("MCP：tools/list 与 tools/call", async () => {
  const call = async (payload) => {
    const res = await fetch(BASE + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mcpToken}`,
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify(payload),
    });
    return res.json();
  };
  const tools = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert(tools.result.tools.length >= 18, tools.result.tools.length);
  // qexo_overview only touches D1, so it is independent of GitHub's anonymous
  // rate limit (Cloudflare egress IPs share a very small quota).
  const overview = await call({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "qexo_overview", arguments: {} },
  });
  assert(overview.result.isError === false, JSON.stringify(overview.result));
  const parsed = JSON.parse(overview.result.content[0].text);
  assert(
    typeof parsed.provider.repo === "string" && parsed.provider.repo.includes("/"),
    JSON.stringify(parsed.provider),
  );
  assert(parsed.counts.post >= 1, JSON.stringify(parsed.counts));
  return `${tools.result.tools.length} tools, posts=${parsed.counts.post} via MCP`;
});

await step("MCP：吊销令牌后 401", async () => {
  const list = await client.get("/api/mcp");
  const token = list.data.tokens.find((t) => t.name === "prod-smoke");
  assert(token, "token not found");
  const rev = await client.del("/api/mcp/tokens", { id: token.id });
  assert(rev.data?.status === true, JSON.stringify(rev.data));
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${mcpToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  });
  assert(res.status === 401, `expected 401, got ${res.status}`);
  return "revoked";
});

const passed = results.filter((r) => r.ok).length;
fs.mkdirSync("test/out", { recursive: true });
fs.writeFileSync(
  "test/out/prod-report.json",
  JSON.stringify({ base: BASE, generated_at: new Date().toISOString(), passed, skipped, total: results.length, failures, results }, null, 2),
);
console.log("=".repeat(56));
console.log(`${passed}/${results.length - skipped} passed, ${skipped} skipped, ${failures} failed`);
if (password) console.log(`credentials: ${username} (stored in ${CRED_FILE})`);
process.exit(failures ? 1 : 0);
