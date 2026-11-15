/**
 * UI smoke test: drives the real admin SPA in Microsoft Edge (Chromium)
 * against the locally running Worker. Complements the API-level e2e run.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { startServers } from "./harness.mjs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
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

const servers = await startServers();
const base = servers.base;

async function initBackend() {
  const post = async (p, body) => {
    const res = await fetch(base + p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  await post("/api/init_step", { step: "1", language: "zh_CN" });
  await post("/api/init_step", {
    step: "3",
    provider: JSON.stringify({ provider: "github", params: { token: "mock-token", repo: "demo/blog", branch: "main", path: "", config: "Hexo" } }),
    force: "true",
  });
  await post("/api/init_step", { step: "4", kind: "" });
}

console.log("\nQexo-Workers UI smoke\n" + "=".repeat(52));
await initBackend();

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await step("ui: 登录页渲染（独立页面）", async () => {
  await page.goto(base + "/#/login", { waitUntil: "networkidle" });
  await page.waitForSelector("#login-form");
  assert.equal(new URL(page.url()).pathname, "/login");
  const title = await page.textContent(".auth-head h2");
  assert.ok(title.includes("Qexo") || title.length > 0);
  return `${title.trim()} @ /login`;
});

await step("ui: 通过表单登录", async () => {
  await page.fill('#login-form input[name="username"]', "admin");
  await page.fill('#login-form input[name="password"]', "admin123");
  await page.click("#login-btn");
  await page.waitForFunction(() => location.hash === "#/dashboard", null, { timeout: 15000 });
  await page.waitForSelector(".stat");
  const heading = await page.textContent("#page-title");
  assert.equal(heading.trim(), "控制台");
  return "session + csrf ok";
});

await step("ui: 仪表盘统计卡与内容源信息", async () => {
  const cards = await page.$$(".stat");
  assert.equal(cards.length, 4);
  const body = await page.textContent("#view");
  assert.ok(body.includes("demo/blog"));
  await page.screenshot({ path: "test/out/ui-dashboard.png", fullPage: true });
  return `${cards.length} cards`;
});

await step("ui: 文章列表显示仓库内容", async () => {
  await page.click('a[href="#/posts"]');
  await page.waitForSelector("#list table");
  const text = await page.textContent("#list");
  assert.ok(text.includes("hello-world"), text.slice(0, 200));
  await page.screenshot({ path: "test/out/ui-posts.png", fullPage: true });
  return "hello-world";
});

await step("ui: 编辑器加载正文与预览", async () => {
  await page.click('#list table tbody tr a:has-text("hello-world")');
  await page.waitForSelector("#content");
  const content = await page.inputValue("#content");
  assert.ok(content.includes("第一篇文章"), content.slice(0, 120));
  const preview = await page.innerHTML("#preview");
  assert.ok(preview.includes("<h2>"), preview.slice(0, 160));
  const fm = await page.inputValue("#f-title");
  assert.equal(fm, "Hello Qexo Workers");
  await page.screenshot({ path: "test/out/ui-editor.png", fullPage: true });
  return "front matter + markdown preview";
});

await step("ui: 工具栏插入粗体", async () => {
  await page.evaluate(() => {
    const el = document.getElementById("content");
    el.focus();
    el.setSelectionRange(0, 0);
  });
  await page.click('[data-md="bold"]');
  const content = await page.inputValue("#content");
  assert.ok(content.startsWith("**加粗文本**"), content.slice(0, 40));
  return "snippet inserted";
});

await step("ui: 设置页加载内容源配置", async () => {
  await page.goto(base + "/#/settings/provider");
  await page.waitForSelector("#prov-type");
  const value = await page.inputValue("#prov-type");
  assert.equal(value, "github");
  const platform = await page.inputValue("#prov-platform");
  assert.equal(platform, "Hexo");
  return `${value} / ${platform}`;
});

await step("ui: Fine-grained PAT 链接与空值默认", async () => {
  const href = await page.getAttribute("#gh-pat-link", "href");
  assert.ok(href.startsWith("https://github.com/settings/personal-access-tokens/new?"), href);
  const target = new URL(href);
  assert.equal(target.searchParams.get("contents"), "write", href);
  assert.equal(target.searchParams.get("expires_in"), "90", href);
  assert.equal(target.searchParams.get("name"), "Qexo Workers", href);
  assert.equal(await page.getAttribute("#gh-pat-link", "target"), "_blank");
  const rel = await page.getAttribute("#gh-pat-link", "rel");
  assert.ok((rel || "").includes("noopener"), rel);
  const label = (await page.textContent("#gh-pat-link")) || "";
  assert.ok(label.includes("Fine-grained"), label);
  const why = (await page.textContent(".pat-why")) || "";
  assert.ok(why.includes("只覆盖") && why.includes("私有仓库"), why);
  const summary = (await page.textContent(".scope-help summary")) || "";
  assert.ok(summary.includes("最小权限"), summary);
  await page.click(".scope-help summary");
  assert.equal(await page.evaluate(() => document.querySelector(".scope-help")?.open), true);
  const scope = (await page.textContent(".scope-help")) || "";
  assert.ok(scope.includes("Only select repositories"), scope);
  assert.ok(scope.includes("Webhooks") && scope.includes("Actions"), scope);

  assert.equal(await page.evaluate(() => document.getElementById("gh-repo")?.tagName), "SELECT");
  assert.equal(await page.evaluate(() => document.getElementById("gh-branch")?.tagName), "SELECT");
  assert.equal(await page.inputValue("#gh-repo"), "");
  assert.equal(await page.inputValue("#gh-branch"), "");
  assert.equal(await page.inputValue("#gh-repo-manual-input"), "");
  assert.equal(await page.inputValue("#gh-branch-manual-input"), "");
  const repoPlaceholder = (await page.textContent('#gh-repo option[value=""]')) || "";
  assert.ok(repoPlaceholder.includes("请选择") && repoPlaceholder.includes("必填"), repoPlaceholder);
  const branchPlaceholder = (await page.textContent('#gh-branch option[value=""]')) || "";
  assert.ok(branchPlaceholder.includes("待选择"), branchPlaceholder);
  const saved = (await page.textContent("#gh-saved-info")) || "";
  assert.ok(saved.includes("当前已保存") && saved.includes("默认留空"), saved);

  // Empty state must not be reported as a valid/verified configuration.
  await page.click("#save-provider");
  const msg = (await page.textContent("#prov-msg")) || "";
  assert.ok(msg.includes("仓库为空"), msg);
  assert.ok(!msg.includes("校验通过"), msg);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  await page.screenshot({ path: "test/out/ui-settings.png", fullPage: true });
  return "empty defaults + explicit empty-state message";
});

await step("ui: 仓库/分支需明确选择", async () => {
  await page.waitForFunction(
    () => document.getElementById("gh-repo-status")?.classList.contains("ok"),
    { timeout: 20000 },
  );
  const repos = await page.$$eval("#gh-repo option", (els) => els.map((e) => e.value).filter(Boolean));
  assert.ok(repos.includes("demo/blog"), repos.join(","));
  assert.ok(repos.includes("demo/notes"), repos.join(","));
  assert.equal(await page.inputValue("#gh-repo"), "", "loading options must not select a repo");

  await page.selectOption("#gh-repo", "demo/blog");
  await page.waitForFunction(
    () => document.getElementById("gh-branch-status")?.classList.contains("ok"),
    { timeout: 20000 },
  );
  const branches = await page.$$eval("#gh-branch option", (els) => els.map((e) => e.value).filter(Boolean));
  assert.ok(branches.includes("main"), branches.join(","));
  assert.ok(branches.includes("dev"), branches.join(","));
  assert.equal(await page.inputValue("#gh-branch"), "", "default branch must not be auto-selected");
  await page.selectOption("#gh-branch", "main");

  await page.click("#gh-repos-refresh");
  await page.waitForTimeout(1200);
  await page.waitForFunction(
    () => document.getElementById("gh-repo-status")?.classList.contains("ok"),
    { timeout: 20000 },
  );
  assert.equal(await page.inputValue("#gh-repo"), "demo/blog");
  assert.equal(await page.inputValue("#gh-branch"), "main");
  // Remove the earlier empty-state notice/toast so the screenshot only shows
  // the explicit-selection state.
  await page.evaluate(() => {
    document.getElementById("prov-msg").textContent = "";
  });
  await page.waitForTimeout(3600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  await page.screenshot({ path: "test/out/ui-settings-loaded.png", fullPage: true });
  return `${repos.length} repos, ${branches.length} branches, explicit selection`;
});

await step("ui: 无效密钥显示明确错误", async () => {
  await page.fill("#gh-token", "bad-token");
  await page.click("#gh-check");
  await page.waitForFunction(
    () => document.getElementById("gh-token-status")?.classList.contains("err"),
    { timeout: 20000 },
  );
  const text = (await page.textContent("#gh-token-status")) || "";
  assert.ok(/401|密钥无效/.test(text), text);
  assert.ok((await page.textContent("#gh-repo-status")).includes("读取仓库失败"), "missing repo error");
  // The 400 is the expected outcome of this negative test; do not report it as
  // an uncaught page error in the final check.
  for (let i = errors.length - 1; i >= 0; i--) {
    if (errors[i].includes("400 (Bad Request)")) errors.splice(i, 1);
  }
  return text.trim().slice(0, 40);
});

await step("ui: 图床页与友链页可访问", async () => {
  await page.goto(base + "/#/images");
  await page.waitForSelector("#drop");
  await page.goto(base + "/#/friends");
  await page.waitForTimeout(2000);
  const html = await page.innerHTML("#view");
  if (!html.includes('id="list"')) {
    await page.screenshot({ path: "test/out/debug-nav.png", fullPage: true });
    throw new Error(`friends view not rendered: ${html.slice(0, 400)}`);
  }
  const text = await page.textContent("#list");
  assert.ok(text.includes("添加友链"));
});

await step("ui: MCP 页面生成 Agent 配置提示词", async () => {
  await page.goto(base + "/#/mcp");
  await page.waitForSelector("#new-token");
  const text = await page.textContent("#view");
  assert.ok(text.includes("Streamable HTTP"), text.slice(0, 200));
  assert.ok(text.includes("Agent 提示词结构规范"), "prompt spec missing on page");
  await page.click("#new-token");
  await page.waitForSelector("#t-name");
  await page.fill("#t-name", "UI 测试令牌");
  await page.check("#t-write");
  await page.click(".modal-foot .btn.primary");
  await page.waitForSelector("#new-agent-prompt");
  const token = await page.inputValue("#new-token-value");
  assert.ok(token.startsWith("qx_mcp_"), token.slice(0, 12));
  const prompt = await page.inputValue("#new-agent-prompt");

  assert.ok(prompt.startsWith("# Qexo MCP 接入配置"), prompt.slice(0, 60));
  assert.ok(prompt.includes(token), "token missing from prompt");
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.equal((prompt.match(new RegExp(escaped, "g")) || []).length, 2, "token must appear exactly twice");
  for (const needle of [
    '"type": "http"',
    "mcpServers",
    "stdio-bridge.mjs",
    "confirm: true",
    "已连接 Qexo MCP",
    "qexo_overview",
    "create_post",
    "Insufficient scope",
    "2025-06-18",
  ]) {
    assert.ok(prompt.includes(needle), `missing: ${needle}`);
  }
  assert.equal((prompt.match(/^## /gm) || []).length, 6, "fixed 6 sections");
  await page.click(".modal-foot .btn.primary"); // copy prompt, modal stays open
  assert.equal(await page.isVisible("#new-agent-prompt"), true, "modal closed after copy");
  await page.evaluate(() => {
    const toasts = document.getElementById("toasts");
    if (toasts) toasts.innerHTML = "";
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: "test/out/ui-mcp.png", fullPage: true });
  return `prompt ${prompt.length} chars, ${(prompt.match(/^## /gm) || []).length} sections`;
});

/* ------------------------------------------------------------------ */
/* 面板风格：Cookie 持久化、即时生效、刷新恢复、无效值回退            */
/* ------------------------------------------------------------------ */

await step("ui: 风格库集中配置与默认回退", async () => {
  await page.goto(base + "/#/settings/appearance", { waitUntil: "networkidle" });
  await page.waitForSelector("#style-grid");
  // 只清除风格 Cookie，保留登录会话 Cookie
  await page.evaluate(() => {
    document.cookie = "qexo_ui_style=; Path=/; Max-Age=0; SameSite=Lax";
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#style-grid");
  const info = await page.evaluate(() => ({
    count: window.QexoStyles.list().length,
    defaultId: window.QexoStyles.DEFAULT_ID,
    current: window.QexoStyles.current(),
    domStyle: document.documentElement.getAttribute("data-style"),
    problems: window.QexoStyles.verify(),
    cookie: document.cookie,
    verifyText: document.getElementById("style-verify")?.textContent || "",
  }));
  assert.ok(info.count >= 6, `主题数量不足: ${info.count}`);
  assert.equal(info.problems.length, 0, info.problems.join("; "));
  assert.equal(info.current, info.defaultId);
  assert.equal(info.domStyle, info.defaultId);
  assert.ok(!info.cookie.includes("qexo_ui_style="), "Cookie 缺失时不应自动写入");
  assert.ok(info.verifyText.includes("配置自检通过"), info.verifyText);
  return `${info.count} 套主题，默认 ${info.defaultId}`;
});

await step("ui: 一键切换即时生效并写入 Cookie", async () => {
  const before = await page.evaluate(() => ({
    border: getComputedStyle(document.querySelector(".card")).borderTopColor,
    token: getComputedStyle(document.documentElement).getPropertyValue("--border-soft").trim(),
  }));
  await page.click('.style-card[data-style-id="corporate"]');
  await page.waitForTimeout(300); // 等绘制类补间结束，再读计算样式
  const after = await page.evaluate(() => ({
    id: window.QexoStyles.current(),
    domStyle: document.documentElement.getAttribute("data-style"),
    bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
    border: getComputedStyle(document.querySelector(".card")).borderTopColor,
    token: getComputedStyle(document.documentElement).getPropertyValue("--border-soft").trim(),
    active: document.querySelector(".style-card.is-active")?.dataset.styleId,
    cookie: document.cookie,
  }));
  assert.equal(after.id, "corporate");
  assert.equal(after.domStyle, "corporate");
  assert.equal(after.bg, "#f8fafc");
  assert.equal(after.active, "corporate");
  assert.notEqual(after.token, before.token, "token 未换档");
  assert.notEqual(after.border, before.border, "卡片实际绘制色未变化");
  assert.ok(after.cookie.includes("qexo_ui_style=corporate"), after.cookie);
  const jar = await page.context().cookies(base);
  const ck = jar.find((c) => c.name === "qexo_ui_style");
  assert.ok(ck, "风格 Cookie 未写入浏览器");
  assert.equal(ck.path, "/", ck.path);
  assert.equal(ck.sameSite, "Lax", ck.sameSite);
  assert.ok(ck.expires > Date.now() / 1000, "Cookie 应为持久化而非会话级");
  return `即时生效 + Cookie(path=${ck.path}, sameSite=${ck.sameSite})`;
});

await step("ui: 刷新后自动恢复上次选择（首屏无闪）", async () => {
  // 在 document_start 观察 data-style 的第一次赋值，验证它由 head 同步脚本完成
  // document_start 时 documentElement 可能还不存在，观察 document 本身并开 subtree
  await page.addInitScript(() => {
    window.__firstAppliedStyle = null;
    new MutationObserver(() => {
      const el = document.documentElement;
      if (window.__firstAppliedStyle === null && el && el.hasAttribute("data-style")) {
        window.__firstAppliedStyle = el.getAttribute("data-style");
      }
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-style"] });
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#style-grid");
  const restored = await page.evaluate(() => ({
    first: window.__firstAppliedStyle,
    id: window.QexoStyles.current(),
    checked: document.querySelector(".style-input:checked")?.value,
    active: document.querySelector(".style-card.is-active")?.dataset.styleId,
  }));
  assert.equal(restored.first, "corporate", "首屏首次写入的风格不是已保存值");
  assert.equal(restored.id, "corporate");
  assert.equal(restored.checked, "corporate");
  assert.equal(restored.active, "corporate");
  return "首屏还原 corporate，控件状态一致";
});

await step("ui: Cookie 无效值回退默认并清理脏值", async () => {
  await page.evaluate(() => {
    document.cookie = "qexo_ui_style=__not_a_theme__; Path=/; Max-Age=31536000; SameSite=Lax";
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#style-grid");
  const fb = await page.evaluate(() => ({
    defaultId: window.QexoStyles.DEFAULT_ID,
    id: window.QexoStyles.current(),
    cookie: document.cookie,
    bad: window.QexoStyles.apply("__another_bad_id__", { persist: false }),
  }));
  assert.equal(fb.id, fb.defaultId);
  assert.equal(fb.bad, fb.defaultId, "apply 非法 id 未回退");
  assert.ok(!fb.cookie.includes("qexo_ui_style="), "无效 Cookie 应被清除");
  return `脏 Cookie 与非法 id 均回退 ${fb.defaultId}`;
});

await step("ui: 无 JS 运行时错误", async () => {
  const filtered = errors.filter((e) => !/favicon|fonts\.googleapis|ERR_/i.test(e));
  assert.equal(filtered.length, 0, filtered.join("\n"));
  return `${errors.length} console messages`;
});

const passed = results.filter((r) => r.ok).length;
fs.mkdirSync("test/out", { recursive: true });
fs.writeFileSync("test/out/ui-report.json", JSON.stringify({ passed, total: results.length, failures, results }, null, 2));
console.log("=".repeat(52));
console.log(`${passed}/${results.length} passed, ${failures} failed`);
await browser.close();
await servers.stop();
process.exit(failures ? 1 : 0);
