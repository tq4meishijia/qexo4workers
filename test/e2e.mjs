/**
 * End-to-end acceptance suite.
 *
 * Boots mock GitHub + wrangler dev, walks the full Qexo feature surface
 * (init → auth → content → config → images → social → analytics → backup),
 * then builds the repository the way Pages would and asserts the output.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServers } from "./harness.mjs";

const results = [];
let failures = 0;

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

class Client {
  constructor(base) {
    this.base = base;
    this.cookie = "";
    this.csrf = "";
  }

  async req(p, { method = "GET", body, form, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.csrf && method !== "GET") h["X-CSRF-Token"] = this.csrf;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      h["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + p, { method, headers: h, body: payload });
    for (const c of res.headers.getSetCookie?.() || []) {
      if (c.startsWith("qexo_session=")) this.cookie = c.split(";")[0];
    }
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }

  get(p, headers) {
    return this.req(p, { headers });
  }
  post(p, body, headers) {
    return this.req(p, { method: "POST", body, headers });
  }
  put(p, body) {
    return this.req(p, { method: "PUT", body });
  }
  del(p, body) {
    return this.req(p, { method: "DELETE", body });
  }
}

const servers = await startServers();
const base = servers.base;
const api = new Client(base);
const anon = new Client(base);
let csrf = "";

console.log("\nQexo-Workers acceptance run\n" + "=".repeat(52));

/* ---------------- init ---------------- */

await step("init: 默认管理员已自动创建", async () => {
  const r = await api.get("/api/init/state");
  assert.equal(r.data.users, 1, JSON.stringify(r.data));
  assert.ok(r.data.init >= 4, `init=${r.data.init}`);
  assert.ok(r.data.platforms.includes("Hexo"));
  return `init=${r.data.init}, users=${r.data.users}`;
});

await step("guard: 未登录访问 / 跳转 /login", async () => {
  const res = await fetch(base + "/", { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") || "", /\/login\?next=/);
  const login = await fetch(base + "/login");
  assert.equal(login.status, 200);
  const html = await login.text();
  assert.ok(html.includes('id="login-form"'), "standalone login page missing");
});

await step("init: 第 1 步 语言", async () => {
  const r = await api.post("/api/init_step", { step: "1", language: "zh_CN" });
  assert.equal(r.data.status, true);
});

await step("init: 第 3 步 内容源（GitHub 仓库）", async () => {
  const cfg = {
    provider: "github",
    params: { token: "mock-token", repo: "demo/blog", branch: "main", path: "", config: "Hexo" },
  };
  const r = await api.post("/api/init_step", { step: "3", provider: JSON.stringify(cfg), force: "true" });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  return r.data.msg;
});

await step("init: 第 4 步 部署方式", async () => {
  const r = await api.post("/api/init_step", { step: "4", kind: "", webhook: "" });
  assert.equal(r.data.status, true);
  assert.equal(r.data.next_step, 6);
});

/* ---------------- auth ---------------- */

await step("auth: 错误密码被拒绝", async () => {
  const r = await anon.post("/api/auth", { username: "admin", password: "wrong" });
  assert.equal(r.data.status, false);
});

await step("auth: 登录并获取 CSRF", async () => {
  const r = await api.post("/api/auth", { username: "admin", password: "admin123" });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  const me = await api.get("/api/me");
  assert.ok(me.data.user?.username === "admin");
  assert.ok(me.data.csrf);
  assert.equal(me.data.default_admin, true, "default-password flag should be set");
  assert.equal(me.data.version, "1.4.0", "runtime version mismatch");
  assert.equal(me.data.turnstile?.enabled, false, "Turnstile must stay disabled without operator secrets");
  api.csrf = me.data.csrf;
  csrf = me.data.csrf;
  return `session + csrf=${csrf.slice(0, 8)}…`;
});

await step("guard: 登录后访问 / 返回后台", async () => {
  const res = await fetch(base + "/", { headers: { Cookie: api.cookie }, redirect: "manual" });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('id="app"'), "admin shell missing");
  return "200 index.html";
});

await step("auth: 未登录访问被拒绝", async () => {
  const r = await anon.get("/api/posts");
  assert.equal(r.status, 401);
});

await step("auth: 缺少 CSRF 的写操作被拒绝", async () => {
  const r = await api.req("/api/purge", { method: "POST", body: {}, headers: {} });
  // api.csrf is injected by the client; use a fresh request without it.
  const raw = await fetch(base + "/api/purge", {
    method: "POST",
    headers: { Cookie: api.cookie, "Content-Type": "application/json" },
    body: "{}",
  });
  const data = await raw.json();
  assert.equal(raw.status, 403);
  assert.equal(data.status, false);
  assert.ok(r);
});

/* ---------------- github content-source pickers ---------------- */

await step("github: 读取密钥可访问的仓库", async () => {
  const r = await api.post("/api/settings/github/repos", { token: "mock-token" });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  assert.equal(r.data.login, "mock-user");
  assert.ok(r.data.repos.some((x) => x.full_name === "demo/blog" && x.push === true), JSON.stringify(r.data.repos));
  assert.ok(r.data.repos.some((x) => x.full_name === "demo/notes" && x.private === true && x.push === false));
  return `${r.data.repos.length} repos, login=${r.data.login}`;
});

await step("github: 读取仓库分支", async () => {
  const r = await api.post("/api/settings/github/branches", { token: "mock-token", repo: "demo/blog" });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  assert.equal(r.data.default_branch, "main");
  assert.deepEqual(r.data.branches.map((b) => b.name), ["main", "dev"]);
  const notes = await api.post("/api/settings/github/branches", { token: "mock-token", repo: "demo/notes" });
  assert.equal(notes.data.default_branch, "trunk");
  return `demo/blog: ${r.data.branches.length} branches, demo/notes default=${notes.data.default_branch}`;
});

await step("github: 掩码密钥回退到已保存配置", async () => {
  const r = await api.post("/api/settings/github/repos", { token: "ghp_******ok" });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  assert.equal(r.data.login, "mock-user");
  assert.equal(r.data.token_source, "saved");
  return "masked token → saved token";
});

await step("github: 无效密钥与非法仓库返回明确错误", async () => {
  const bad = await api.post("/api/settings/github/repos", { token: "bad-token" });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.ok(/401|密钥无效/.test(bad.data.msg), bad.data.msg);
  const repo = await api.post("/api/settings/github/branches", { token: "mock-token", repo: "not-a-repo" });
  assert.equal(repo.status, 400, JSON.stringify(repo.data));
  assert.ok(repo.data.msg.includes("owner/repo"), repo.data.msg);
  return `${bad.data.msg}；${repo.data.msg}`;
});

await step("github: 空仓库/空分支不被误判或回填", async () => {
  const post = (params) =>
    api.post("/api/settings/provider", {
      provider: JSON.stringify({ provider: "github", params: { config: "Hexo", token: "mock-token", path: "", ...params } }),
      force: "true",
    });
  const emptyRepo = await post({ repo: "", branch: "main" });
  assert.equal(emptyRepo.data.status, false, JSON.stringify(emptyRepo.data));
  assert.ok(emptyRepo.data.msg.includes("仓库为空"), emptyRepo.data.msg);
  const emptyBranch = await post({ repo: "demo/blog", branch: "" });
  assert.equal(emptyBranch.data.status, false, JSON.stringify(emptyBranch.data));
  assert.ok(emptyBranch.data.msg.includes("分支为空"), emptyBranch.data.msg);
  const cfg = await api.get("/api/settings");
  const saved = JSON.parse(cfg.data.raw.PROVIDER);
  assert.equal(saved.params.repo, "demo/blog");
  assert.equal(saved.params.branch, "main");
  return "empty values rejected, saved config unchanged";
});

/* ---------------- dashboard / content ---------------- */

await step("dashboard: 聚合数据", async () => {
  const r = await api.get("/api/dashboard");
  assert.equal(r.data.status, true);
  assert.equal(r.data.provider.repo, "demo/blog");
  assert.equal(r.data.provider.platform, "Hexo");
  return `posts=${r.data.counts.post}, pages=${r.data.counts.page}`;
});

await step("posts: 索引仓库文章", async () => {
  const r = await api.post("/api/posts/refresh", {});
  assert.equal(r.data.counts.posts, 1, JSON.stringify(r.data));
  assert.equal(r.data.counts.pages >= 1, true);
  const list = await api.get("/api/posts");
  assert.equal(list.data.data[0].name, "hello-world");
  return `posts=${r.data.counts.posts}, configs=${r.data.counts.configs}`;
});

let draftPath = "";
let postPath = "";
await step("posts: 新建草稿", async () => {
  const r = await api.post("/api/new_post", { file: "workers-test" });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  draftPath = r.data.path;
  assert.ok(draftPath.includes("_drafts"));
  assert.ok(fs.existsSync(path.join("test/out/repo", draftPath)));
  return draftPath;
});

await step("posts: 保存并发布（front-matter + 正文）", async () => {
  const r = await api.post("/api/save_post", {
    file: "workers-test",
    path: draftPath,
    content: "这是通过 Qexo Workers 写入的正文。\n\n## 小节\n\n- A\n- B\n",
    front_matter: {
      title: "Workers 测试文章",
      date: "2026-11-14 12:00:00",
      tags: ["test", "workers"],
      categories: ["测试"],
      abbrlink: "20002",
    },
    status: "true",
  });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  postPath = r.data.path;
  assert.equal(postPath, "source/_posts/workers-test.md");
  assert.ok(!fs.existsSync(path.join("test/out/repo", draftPath)), "draft should be removed after publish");
  const raw = fs.readFileSync(path.join("test/out/repo", postPath), "utf8");
  assert.ok(raw.startsWith("---"));
  assert.ok(raw.includes("title: Workers 测试文章"));
  assert.ok(raw.includes("## 小节"));
  return postPath;
});

await step("posts: 读回并解析 front-matter", async () => {
  const r = await api.get(`/api/post?path=${encodeURIComponent(postPath)}`);
  assert.equal(r.data.front_matter.title, "Workers 测试文章");
  assert.deepEqual(r.data.front_matter.tags, ["test", "workers"]);
  assert.ok(r.data.content.includes("Qexo Workers"));
});

await step("posts: 转草稿 → 再发布", async () => {
  const un = await api.post("/api/unpublish", { file: postPath });
  assert.equal(un.data.path, "source/_drafts/workers-test.md");
  const pub = await api.post("/api/publish", { file: un.data.path });
  assert.equal(pub.data.path, "source/_posts/workers-test.md");
  return "往返一致";
});

await step("posts: 重命名", async () => {
  const r = await api.post("/api/rename", { file: postPath, new: "source/_posts/workers-renamed.md" });
  assert.equal(r.data.status, true);
  assert.ok(fs.existsSync(path.join("test/out/repo", "source/_posts/workers-renamed.md")));
  assert.ok(!fs.existsSync(path.join("test/out/repo", postPath)));
  postPath = "source/_posts/workers-renamed.md";
});

await step("pages: 列表与读取", async () => {
  const list = await api.get("/api/pages");
  const about = list.data.data.find((p) => p.name === "about/index");
  assert.ok(about, JSON.stringify(list.data.data));
  const r = await api.get(`/api/page?path=${encodeURIComponent(about.path)}`);
  assert.equal(r.data.front_matter.title, "关于本站");
  return about.path;
});

await step("pages: 新建并保存", async () => {
  const created = await api.post("/api/new_page", { file: "contact" });
  assert.equal(created.data.status, true, JSON.stringify(created.data));
  const r = await api.post("/api/save_page", {
    file: created.data.path,
    content: "联系邮箱：hi@example.com\n",
    front_matter: { title: "联系我", date: "2026-11-14 13:00:00" },
  });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  const raw = fs.readFileSync(path.join("test/out/repo", "source/contact.md"), "utf8");
  assert.ok(raw.includes("联系邮箱"));
  return "source/contact.md";
});

/* ---------------- config ---------------- */

await step("configs: 列出并读取 _config.yml", async () => {
  const list = await api.get("/api/configs");
  const cfg = list.data.data.find((c) => c.path === "_config.yml");
  assert.ok(cfg, JSON.stringify(list.data.data.slice(0, 5)));
  const r = await api.get("/api/config?path=_config.yml");
  assert.ok(r.data.content.includes("Hexo Configuration"));
  return `configs=${list.data.data.length}`;
});

await step("configs: 修改站点标题并校验落盘", async () => {
  const current = (await api.get("/api/config?path=_config.yml")).data.content;
  const next = current.replace("title: Qexo Workers Demo", "title: Qexo Workers Demo (edited)");
  const r = await api.post("/api/save_config", { file: "_config.yml", content: next });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  const raw = fs.readFileSync(path.join("test/out/repo/_config.yml"), "utf8");
  assert.ok(raw.includes("Qexo Workers Demo (edited)"));
});

await step("configs: 非法 YAML 被拒绝", async () => {
  const r = await api.post("/api/save_config", { file: "_config.yml", content: "a: [1,2\nb: :" });
  assert.equal(r.data.status, false);
  assert.match(r.data.msg, /YAML/);
});

/* ---------------- images ---------------- */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
let imageUrl = "";
let imageTime = "";

await step("images: 配置 R2 图床", async () => {
  const r = await api.post("/api/settings/image_host", { image_host: JSON.stringify({ type: "R2", params: {} }) });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
});

await step("images: 上传 PNG 到 R2", async () => {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "pixel.png");
  const r = await api.req("/api/upload", { method: "POST", form });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  imageUrl = r.data.url;
  imageTime = r.data.data.time;
  assert.ok(imageUrl.startsWith("/api/images/file/"));
  return imageUrl;
});

await step("images: 通过 Worker 读取对象", async () => {
  const res = await fetch(base + imageUrl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, PNG.length);
});

await step("images: 列表与删除（同步 R2）", async () => {
  const list = await api.get("/api/images");
  assert.equal(list.data.data.length, 1);
  const r = await api.post("/api/delete_img", { image: imageTime, sync: "true" });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  const after = await api.get("/api/images");
  assert.equal(after.data.data.length, 0);
});

/* ---------------- content-source image host ---------------- */

const CS_IMAGE_HOST = "GitHub 内容源";
const MOCK_TOKEN = "mock-token";
const csUploaded = [];

/** The mock rejects unauthenticated reads, so pass the content-source token. */
async function remoteStatus(pathInRepo) {
  const res = await fetch(`${servers.mock}/repos/demo/blog/contents/${pathInRepo}`, {
    headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
  });
  return res.status;
}

async function setImageHost(type, params) {
  const r = await api.post("/api/settings/image_host", { image_host: JSON.stringify({ type, params }) });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
}

async function uploadPng(name) {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), name);
  const r = await api.req("/api/upload", { method: "POST", form });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  // IDs are unique; timestamps can collide when several uploads share a second.
  csUploaded.push(r.data.data.id);
  return r.data;
}

await step("images: 内容源图床是独立类型且预设可枚举", async () => {
  const s = await api.get("/api/settings");
  const names = (s.data.image_hosts || []).map((h) => h.name);
  assert.ok(names.includes(CS_IMAGE_HOST), names.join(","));
  const meta = s.data.image_hosts.find((h) => h.name === CS_IMAGE_HOST);
  const ids = (meta.params.cdn_preset.options || []).map((o) => o.value);
  assert.ok(ids.includes("raw") && ids.includes("jsdelivr"), ids.join(","));
  assert.ok(meta.params.cdn_preset.options[0].template.includes("{repo}"));
  assert.ok(!("token" in meta.params), "该类型不应要求单独填写密钥");
  return `${names.length} 种图床 / ${ids.length} 个 CDN 预设`;
});

await step("images: 默认 raw 前缀与 img-qexo 上传目录", async () => {
  await setImageHost(CS_IMAGE_HOST, {});
  const saved = await api.get("/api/settings");
  const stored = JSON.parse(saved.data.settings.IMG_HOST);
  assert.equal(stored.type, CS_IMAGE_HOST);
  assert.ok(!("token" in (stored.params || {})), "图床配置不应另存密钥");
  const r = await uploadPng("default.png");
  // The mock requires `Bearer mock-token`; a successful upload proves the
  // content-source credential was reused instead of an empty form token.
  assert.ok(r.url.startsWith("https://raw.githubusercontent.com/demo/blog/main/img-qexo/"), r.url);
  const key = r.url.split("/img-qexo/")[1];
  assert.ok(key, r.url);
  assert.equal(await remoteStatus(`img-qexo/${key}`), 200, "远程文件未写入内容源仓库");
  return r.url;
});

await step("images: 下拉预设覆盖默认前缀", async () => {
  await setImageHost(CS_IMAGE_HOST, { cdn_preset: "jsdelivr" });
  const r = await uploadPng("preset.png");
  assert.ok(r.url.startsWith("https://cdn.jsdelivr.net/gh/demo/blog@main/img-qexo/"), r.url);
  return r.url;
});

await step("images: 合法自定义前缀优先级最高", async () => {
  await setImageHost(CS_IMAGE_HOST, {
    cdn_preset: "jsdelivr",
    cdn_custom: "https://img.example.com/{repo}/{branch}/",
  });
  const r = await uploadPng("custom.png");
  assert.ok(r.url.startsWith("https://img.example.com/demo/blog/main/img-qexo/"), r.url);
  return r.url;
});

await step("images: 非法自定义前缀回退到下拉预设", async () => {
  await setImageHost(CS_IMAGE_HOST, { cdn_preset: "jsdelivr", cdn_custom: "javascript:alert(1)" });
  const r = await uploadPng("fallback.png");
  assert.ok(r.url.startsWith("https://cdn.jsdelivr.net/gh/demo/blog@main/img-qexo/"), r.url);
  return r.url;
});

await step("images: 上传目录可覆盖且删除同步生效", async () => {
  await setImageHost(CS_IMAGE_HOST, { path: "custom-images", cdn_preset: "raw" });
  const r = await uploadPng("folder.png");
  assert.ok(r.url.includes("/custom-images/images/"), r.url);
  const key = r.url.split("/demo/blog/main/")[1];
  assert.ok(key, r.url);
  assert.equal(await remoteStatus(key), 200);
  const imageId = r.data.id;
  const del = await api.post("/api/delete_img", { image: imageId, sync: "true" });
  assert.equal(del.data.status, true, JSON.stringify(del.data));
  assert.ok(!String(del.data.msg || "").includes("远程删除失败"), JSON.stringify(del.data));
  assert.equal(await remoteStatus(key), 404, `同步删除未生效: ${JSON.stringify(del.data)}`);
  const idx = csUploaded.indexOf(imageId);
  if (idx >= 0) csUploaded.splice(idx, 1);
  return key;
});

await step("images: 清理内容源图床测试记录并恢复原图床", async () => {
  for (const t of csUploaded) await api.post("/api/delete_img", { image: t, sync: "true" });
  const list = await api.get("/api/images");
  assert.equal(list.data.data.length, 0, JSON.stringify(list.data.data));
  await setImageHost("R2", {});
  return `${csUploaded.length} 条记录已清理`;
});

/* ---------------- friends & talks ---------------- */

await step("friends: 添加 → 公开列表", async () => {
  const r = await api.post("/api/friends", {
    name: "Example Blog",
    url: "https://example.com",
    image: "https://example.com/avatar.png",
    description: "示例站点",
    status: "显示",
  });
  assert.equal(r.data.status, true);
  const pub = await anon.get("/pub/friends");
  assert.equal(pub.data.status, true);
  assert.equal(pub.data.data.length, 1);
  assert.equal(pub.data.data[0].name, "Example Blog");
});

await step("friends: 编辑与清理隐藏", async () => {
  const list = await api.get("/api/friends");
  const time = list.data.data[0].time;
  const r = await api.put("/api/friends", {
    time,
    name: "Example Blog 2",
    url: "https://example.com",
    image: "",
    description: "desc",
    status: "隐藏",
  });
  assert.equal(r.data.status, true);
  const pub = await anon.get("/pub/friends");
  assert.equal(pub.data.data.length, 0, "hidden friend must not appear publicly");
  const clean = await api.post("/api/friends/clean", {});
  assert.match(clean.data.msg, /成功清理/);
});

let talkId = "";
await step("talks: 发布 → 公开分页 → 点赞", async () => {
  const r = await api.post("/api/talks", {
    content: "第一条说说，来自 Workers。",
    tags: '["日常","测试"]',
    values: '{"mood":"ok"}',
  });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  talkId = r.data.id;
  const pub = await anon.get("/pub/talks?page=1&limit=5");
  assert.equal(pub.data.count, 1);
  assert.equal(pub.data.data[0].id, talkId);
  assert.equal(pub.data.data[0].like, 0);
  const like = await anon.post("/pub/like_talk", { id: talkId });
  assert.equal(like.data.action, true);
  const again = await anon.get("/pub/talks");
  assert.equal(again.data.data[0].like, 1);
  assert.equal(again.data.data[0].liked, true);
  const unlike = await anon.post("/pub/like_talk", { id: talkId });
  assert.equal(unlike.data.action, false);
});

/* ---------------- settings / analytics ---------------- */

await step("settings: 基本信息与安全（含 API 密钥）", async () => {
  let r = await api.post("/api/settings", {
    group: "basic",
    name: "Qexo Demo",
    split: " · ",
    logo: "https://example.com/logo.png",
    icon: "https://example.com/icon.png",
    logo_dark: "",
    language: "zh_CN",
  });
  assert.equal(r.data.status, true);
  r = await api.post("/api/settings", {
    group: "security",
    allow_friend: "是",
    friend_recaptcha: "关闭",
    recaptcha_token: "",
    apikey: "secret-token",
  });
  assert.equal(r.data.status, true);
  const s = await api.get("/api/settings");
  assert.equal(s.data.settings.QEXO_NAME, "Qexo Demo");
  assert.equal(s.data.settings.WEBHOOK_APIKEY, "******");
});

await step("settings: Turnstile 开关默认关闭且状态清晰", async () => {
  const s = await api.get("/api/settings");
  const t = s.data.turnstile;
  assert.equal(t.switch_on, false);
  assert.equal(t.configured, false);
  assert.equal(t.effective, false);
  assert.ok(t.missing.includes("TURNSTILE_SECRET"), JSON.stringify(t.missing));
  assert.ok(t.missing.includes("TURNSTILE_HOSTNAMES"), JSON.stringify(t.missing));
  assert.equal(t.site_key, "0x4AAAAAAGBqe3KzCG_zIoD7");
  assert.equal(s.data.settings.TURNSTILE_ENABLED ?? "否", "否");
  return `missing=${t.missing.join(",")}`;
});

await step("settings: Turnstile 开关切换即时回显与前置条件提示", async () => {
  const on = await api.post("/api/settings/turnstile", { enabled: "是" });
  assert.equal(on.data.status, true, JSON.stringify(on.data));
  assert.equal(on.data.turnstile.switch_on, true);
  assert.equal(on.data.turnstile.effective, false, "前置条件未满足时不应生效");
  assert.ok(on.data.msg.includes("前置条件"), on.data.msg);
  const mid = await api.get("/api/settings");
  assert.equal(mid.data.turnstile.switch_on, true, "开关状态未即时回显");
  const off = await api.post("/api/settings/turnstile", { enabled: "否" });
  assert.equal(off.data.status, true, JSON.stringify(off.data));
  assert.equal(off.data.turnstile.switch_on, false);
  assert.ok(off.data.msg.includes("已关闭"), off.data.msg);
  return "开启/关闭即时回显，前置条件缺失时不生效";
});

await step("settings: 旧版表单接口（set_abbrlink / set_cdn）", async () => {
  // Qexo sent application/x-www-form-urlencoded here.
  const form = new URLSearchParams({ alg: "crc32", rep: "hex" });
  const r = await api.req("/api/set_abbrlink", {
    method: "POST",
    form,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  const s = await api.get("/api/settings");
  assert.equal(s.data.settings.ABBRLINK_ALG, "crc32");
  assert.equal(s.data.settings.ABBRLINK_REP, "hex");
});

await step("public API: token 鉴权", async () => {
  const okRes = await anon.get("/pub/get_posts?token=secret-token");
  assert.equal(okRes.data.status, true);
  assert.equal(okRes.data.posts.length >= 2, true);
  const bad = await anon.get("/pub/get_posts?token=wrong");
  assert.equal(bad.data.status, false);
  const cfg = await anon.get("/pub/get_configs?token=secret-token");
  assert.equal(cfg.data.status, true);
});

await step("statistics: 域名白名单 + PV/UV 累加", async () => {
  let r = await api.post("/api/settings", { group: "statistic", allow: "是", domains: "blog.example.com" });
  assert.equal(r.data.status, true);
  const first = await anon.get("/pub/statistic", { Referer: "https://blog.example.com/hello" });
  assert.equal(first.data.status, true, JSON.stringify(first.data));
  assert.equal(first.data.page_pv, 1);
  assert.equal(first.data.site_pv, 1);
  const second = await anon.get("/pub/statistic", { Referer: "https://blog.example.com/hello" });
  assert.equal(second.data.page_pv, 2);
  assert.equal(second.data.site_pv, 2);
  assert.equal(second.data.site_uv, 1);
  const denied = await anon.get("/pub/statistic", { Referer: "https://evil.example.net/x" });
  assert.equal(denied.status, 403);
  return `pv=${second.data.site_pv}, uv=${second.data.site_uv}`;
});

await step("webhook: token 触发缓存清理", async () => {
  const good = await anon.post("/api/webhook?token=secret-token", {});
  assert.equal(good.data.status, true);
  const bad = await anon.post("/api/webhook?token=nope", {});
  assert.equal(bad.data.status, false);
});

/* ---------------- backup / build ---------------- */

await step("export: 导出 JSON 备份", async () => {
  const r = await api.get("/api/export");
  assert.ok(Array.isArray(r.data.settings));
  assert.ok(r.data.settings.find((s) => s.name === "QEXO_NAME")?.content === "Qexo Demo");
  assert.ok(r.data.friends.length === 0);
  assert.ok(r.data.talks.length === 1);
  return `settings=${r.data.settings.length}, talks=${r.data.talks.length}`;
});

await step("build: 用仓库内容生成静态站点（Pages 构建等价物）", async () => {
  execFileSync(process.execPath, ["test/build-site.mjs"], { stdio: "pipe" });
  const build = JSON.parse(fs.readFileSync("test/out/public/build.json", "utf8"));
  const titles = build.posts.map((p) => p.title);
  assert.ok(titles.includes("Workers 测试文章"), JSON.stringify(titles));
  assert.ok(titles.includes("Hello Qexo Workers"));
  const html = fs.readFileSync("test/out/public/posts/workers-renamed.html", "utf8");
  assert.ok(html.includes("这是通过 Qexo Workers 写入的正文"));
  assert.ok(html.includes("<h2>小节</h2>"));
  assert.ok(fs.existsSync("test/out/public/about/index.html"));
  return `${build.posts.length} posts rendered`;
});

await step("build: 站点标题取自修改后的 _config.yml", async () => {
  const html = fs.readFileSync("test/out/public/index.html", "utf8");
  assert.ok(html.includes("Qexo Workers Demo (edited)"), html.slice(0, 300));
});

await step("posts: 删除后构建结果同步消失", async () => {
  const r = await api.post("/api/delete", { file: postPath });
  assert.equal(r.data.status, true);
  execFileSync(process.execPath, ["test/build-site.mjs"], { stdio: "pipe" });
  const build = JSON.parse(fs.readFileSync("test/out/public/build.json", "utf8"));
  assert.ok(!build.posts.some((p) => p.title === "Workers 测试文章"));
  assert.ok(fs.existsSync("test/out/public/posts/hello-world.html"));
});

/* ---------------- MCP ---------------- */

async function mcpRequest(payload, token) {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
}

async function mcpTool(name, args, token) {
  const res = await mcpRequest({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name, arguments: args } }, token);
  return res.data?.result;
}

let mcpReadToken = "";
let mcpWriteToken = "";

await step("mcp: 创建只读令牌", async () => {
  const r = await api.post("/api/mcp/tokens", { name: "e2e-read", scopes: ["read"] });
  assert.equal(r.data.status, true, JSON.stringify(r.data));
  assert.ok(r.data.token.startsWith("qx_mcp_"));
  mcpReadToken = r.data.token;
  return `${r.data.record.name} / ${r.data.record.scopes.join("+")}`;
});

await step("mcp: initialize 握手与能力声明", async () => {
  const r = await mcpRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1.0" } },
    },
    mcpReadToken,
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.result.protocolVersion, "2025-06-18");
  assert.equal(r.data.result.serverInfo.name, "qexo-workers");
  assert.ok(r.data.result.capabilities.tools);
  assert.ok(r.headers.get("mcp-protocol-version"));
  return r.data.result.serverInfo.version;
});

await step("mcp: initialized 通知返回 202", async () => {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${mcpReadToken}`,
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

await step("mcp: tools/list 暴露工具目录", async () => {
  const r = await mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, mcpReadToken);
  const names = r.data.result.tools.map((t) => t.name);
  assert.ok(names.length >= 15, String(names.length));
  for (const expected of ["list_posts", "get_post", "create_post", "update_post", "save_config", "upload_image"]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  return `${names.length} tools`;
});

await step("mcp: 只读令牌调用写工具被拒绝", async () => {
  const result = await mcpTool("create_post", { name: "should-fail", content: "x" }, mcpReadToken);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Insufficient scope/);
});

await step("mcp: 读取文章（get_post）", async () => {
  const result = await mcpTool("get_post", { path: "source/_posts/hello-world.md" }, mcpReadToken);
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Hello Qexo Workers/);
  assert.equal(result.structuredContent.front_matter.title, "Hello Qexo Workers");
});

await step("mcp: resources/list 与 resources/read", async () => {
  const list = await mcpRequest({ jsonrpc: "2.0", id: 3, method: "resources/list" }, mcpReadToken);
  const uris = list.data.result.resources.map((r) => r.uri);
  assert.ok(uris.includes("qexo://status"));
  const read = await mcpRequest(
    { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "qexo://config/_config.yml" } },
    mcpReadToken,
  );
  assert.match(read.data.result.contents[0].text, /Hexo Configuration/);
  return `${uris.length} resources`;
});

await step("mcp: 写令牌创建文章并落盘", async () => {
  const created = await api.post("/api/mcp/tokens", { name: "e2e-write", scopes: ["read", "write"] });
  mcpWriteToken = created.data.token;
  const result = await mcpTool(
    "create_post",
    {
      name: "mcp-written",
      content: "## 由 MCP 写入\n\n这条内容由 AI agent 通过 tools/call 创建。\n",
      front_matter: { title: "MCP 写入的文章", tags: ["mcp", "agent"] },
      publish: true,
    },
    mcpWriteToken,
  );
  assert.equal(result.isError, false, result.content[0].text);
  const file = path.join("test/out/repo", "source/_posts/mcp-written.md");
  assert.ok(fs.existsSync(file));
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(raw.includes("title: MCP 写入的文章"));
  assert.ok(raw.includes("由 MCP 写入"));
  return "source/_posts/mcp-written.md";
});

await step("mcp: 写令牌更新文章 front-matter", async () => {
  const result = await mcpTool(
    "update_post",
    { path: "source/_posts/mcp-written.md", front_matter: { tags: ["mcp", "agent", "updated"] } },
    mcpWriteToken,
  );
  assert.equal(result.isError, false, result.content[0].text);
  const raw = fs.readFileSync(path.join("test/out/repo", "source/_posts/mcp-written.md"), "utf8");
  assert.ok(raw.includes("updated"));
});

await step("mcp: stdio 桥接完成握手", async () => {
  const { spawn } = await import("node:child_process");
  const bridge = spawn(process.execPath, ["mcp/stdio-bridge.mjs"], {
    env: { ...process.env, QEXO_MCP_URL: base + "/mcp", QEXO_MCP_TOKEN: mcpReadToken },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const line = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("bridge timeout")), 15000);
      bridge.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const idx = buffer.indexOf("\n");
        if (idx >= 0) {
          clearTimeout(timer);
          resolve(buffer.slice(0, idx));
        }
      });
      bridge.stderr.on("data", (chunk) => console.error("bridge:", chunk.toString().trim()));
      bridge.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridge", version: "1" } },
        }) + "\n",
      );
    });
    const message = JSON.parse(line);
    assert.equal(message.result.serverInfo.name, "qexo-workers");
    return "stdio → HTTP ok";
  } finally {
    bridge.kill();
  }
});

await step("mcp: 无效令牌 401 / 未知方法 -32601", async () => {
  const bad = await mcpRequest({ jsonrpc: "2.0", id: 5, method: "tools/list" }, "qx_mcp_invalid");
  assert.equal(bad.status, 401);
  const unknown = await mcpRequest({ jsonrpc: "2.0", id: 6, method: "does/not/exist" }, mcpReadToken);
  assert.equal(unknown.data.error.code, -32601);
});

await step("mcp: 令牌列表不含明文", async () => {
  const r = await api.get("/api/mcp");
  assert.equal(r.data.status, true);
  assert.ok(r.data.tokens.length >= 2);
  assert.ok(r.data.tokens.every((t) => t.hash === undefined));
  assert.ok(r.data.tools.length >= 15);
  return `${r.data.tokens.length} tokens, endpoint=${r.data.endpoint}`;
});

await step("mcp: Agent 配置提示词符合结构规范", async () => {
  const { buildAgentPrompt, PROMPT_SECTIONS, PROMPT_SPEC } = await import("../src/ui/js/mcp-prompt.js");
  const catalog = await api.get("/api/mcp");
  const tools = catalog.data.tools;
  const token = "qx_mcp_PROMPTTEST";
  const prompt = buildAgentPrompt({
    token,
    endpoint: catalog.data.endpoint,
    scopes: ["read", "write"],
    tools,
    protocols: catalog.data.protocols,
    appVersion: "1.4.0",
  });
  assert.ok(prompt.startsWith("# Qexo MCP 接入配置"), prompt.slice(0, 60));
  let cursor = -1;
  for (const section of PROMPT_SECTIONS) {
    const at = prompt.indexOf(`## ${section}`);
    assert.ok(at > cursor, `section order broken: ${section}`);
    cursor = at;
  }
  for (const needle of [
    token,
    catalog.data.endpoint,
    '"type": "http"',
    "mcpServers",
    "stdio-bridge.mjs",
    "confirm: true",
    "Insufficient scope",
    "已连接 Qexo MCP",
    "2025-06-18",
    "```json",
    "```bash",
  ]) {
    assert.ok(prompt.includes(needle), `missing: ${needle}`);
  }
  for (const tool of tools) assert.ok(prompt.includes(tool.name), `missing tool: ${tool.name}`);
  assert.equal((prompt.match(/qx_mcp_PROMPTTEST/g) || []).length, 2, "token must appear exactly twice");
  assert.equal(PROMPT_SPEC.version, "1.0");
  assert.equal(PROMPT_SPEC.required.length, 11);
  return `${PROMPT_SECTIONS.length} sections, ${tools.length} tools, ${prompt.length} chars`;
});

await step("mcp: 只读令牌提示词明确作用域限制", async () => {
  const { buildAgentPrompt } = await import("../src/ui/js/mcp-prompt.js");
  const catalog = await api.get("/api/mcp");
  const token = "qx_mcp_READONLY";
  const prompt = buildAgentPrompt({
    token,
    endpoint: catalog.data.endpoint,
    scopes: ["read"],
    tools: catalog.data.tools,
    protocols: catalog.data.protocols,
  });
  assert.ok(prompt.includes("仅可调用下列只读工具"), prompt.slice(0, 200));
  assert.ok(prompt.includes("Insufficient scope"));
  assert.ok(!prompt.includes("可调用全部工具"));
  assert.ok(prompt.includes("create_post"), "write tools must still be listed");
  assert.equal((prompt.match(/qx_mcp_READONLY/g) || []).length, 2);
  return "read-only scope stated, write tools documented";
});

/* ---------------- quota ---------------- */

await step("quota: 统计 VCS API 调用量", async () => {
  const res = await fetch(servers.mock + "/__stats");
  const stats = await res.json();
  const avg = (stats.requests / Math.max(1, results.length)).toFixed(2);
  return `VCS 调用 ${stats.requests} 次 / ${results.length} 个用例，均值 ${avg}`;
});

/* ---------------- report ---------------- */

const passed = results.filter((r) => r.ok).length;
const report = {
  generated_at: new Date().toISOString(),
  base,
  total: results.length,
  passed,
  failed: failures,
  results,
};
fs.mkdirSync("test/out", { recursive: true });
fs.writeFileSync("test/out/report.json", JSON.stringify(report, null, 2));

console.log("=".repeat(52));
console.log(`${passed}/${results.length} passed, ${failures} failed`);
await servers.stop();
process.exit(failures ? 1 : 0);
