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

await step("ui: Fine-grained PAT 链接与已保存值回填", async () => {
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
  assert.equal(await page.inputValue("#gh-repo"), "demo/blog");
  assert.equal(await page.inputValue("#gh-branch"), "main");
  assert.equal(await page.inputValue("#gh-repo-manual-input"), "");
  assert.equal(await page.inputValue("#gh-branch-manual-input"), "");
  const repoPlaceholder = (await page.textContent('#gh-repo option[value=""]')) || "";
  assert.ok(repoPlaceholder.includes("请选择") && repoPlaceholder.includes("必填"), repoPlaceholder);
  const branchPlaceholder = (await page.textContent('#gh-branch option[value=""]')) || "";
  assert.ok(branchPlaceholder.includes("请选择") && branchPlaceholder.includes("必填"), branchPlaceholder);
  const saved = (await page.textContent("#gh-saved-info")) || "";
  assert.ok(saved.includes("当前已保存") && saved.includes("已自动回填"), saved);

  // Clearing a picker is still an explicit "not chosen" state: saving must be
  // rejected instead of silently resurrecting the stored value.
  await page.selectOption("#gh-branch", "");
  await page.click("#save-provider");
  const msg = (await page.textContent("#prov-msg")) || "";
  assert.ok(msg.includes("分支为空"), msg);
  assert.ok(!msg.includes("校验通过"), msg);
  await page.selectOption("#gh-branch", "main");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  await page.screenshot({ path: "test/out/ui-settings.png", fullPage: true });
  return "saved values prefilled + empty branch rejected";
});

await step("ui: 仓库/分支回填与刷新保持", async () => {
  await page.waitForFunction(
    () => document.getElementById("gh-repo-status")?.classList.contains("ok"),
    { timeout: 20000 },
  );
  await page.waitForFunction(
    () => document.getElementById("gh-branch-status")?.classList.contains("ok"),
    { timeout: 20000 },
  );
  const repos = await page.$$eval("#gh-repo option", (els) => els.map((e) => e.value).filter(Boolean));
  assert.ok(repos.includes("demo/blog"), repos.join(","));
  assert.ok(repos.includes("demo/notes"), repos.join(","));
  assert.equal(await page.inputValue("#gh-repo"), "demo/blog", "repo list must keep the saved selection");

  const branches = await page.$$eval("#gh-branch option", (els) => els.map((e) => e.value).filter(Boolean));
  assert.ok(branches.includes("main"), branches.join(","));
  assert.ok(branches.includes("dev"), branches.join(","));
  assert.equal(await page.inputValue("#gh-branch"), "main", "branch list must keep the saved selection");

  await page.click("#gh-repos-refresh");
  await page.waitForTimeout(1200);
  await page.waitForFunction(
    () => document.getElementById("gh-repo-status")?.classList.contains("ok"),
    { timeout: 20000 },
  );
  assert.equal(await page.inputValue("#gh-repo"), "demo/blog");
  assert.equal(await page.inputValue("#gh-branch"), "main");

  // A different repository has a different branch set: the old branch must not
  // be carried over silently.
  await page.selectOption("#gh-repo", "demo/notes");
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("#gh-branch option")).some((o) => o.value === "trunk"),
    { timeout: 20000 },
  );
  assert.equal(await page.inputValue("#gh-branch"), "", "repo switch must clear the branch");
  await page.selectOption("#gh-repo", "demo/blog");
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("#gh-branch option")).some((o) => o.value === "dev"),
    { timeout: 20000 },
  );
  await page.selectOption("#gh-branch", "main");

  // Remove the earlier empty-state notice/toast so the screenshot only shows
  // the explicit-selection state.
  await page.evaluate(() => {
    document.getElementById("prov-msg").textContent = "";
  });
  await page.waitForTimeout(3600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  await page.screenshot({ path: "test/out/ui-settings-loaded.png", fullPage: true });
  return `${repos.length} repos, ${branches.length} branches, prefilled + refresh-safe`;
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

await step("ui: 内容源图床下拉/自定义前缀/优先级预览", async () => {
  await page.goto(base + "/#/settings/image");
  await page.waitForSelector("#img-type");
  const types = await page.$$eval("#img-type option", (els) => els.map((e) => e.value));
  assert.ok(types.includes("GitHub 内容源"), types.join(","));

  await page.selectOption("#img-type", "GitHub 内容源");
  await page.waitForSelector("#img-cdn-preset");
  assert.equal(await page.inputValue("#img-dir"), "img-qexo");
  assert.equal(await page.inputValue("#img-cdn-preset"), "raw");
  const presets = await page.$$eval("#img-cdn-preset option", (els) => els.map((e) => e.value));
  assert.ok(presets.includes("jsdelivr"), presets.join(","));
  const preview0 = (await page.textContent("#img-cdn-preview")) || "";
  assert.ok(preview0.includes("raw.githubusercontent.com") && preview0.includes("img-qexo"), preview0);
  assert.ok(preview0.includes("demo/blog") && preview0.includes("main"), preview0);

  await page.selectOption("#img-cdn-preset", "jsdelivr");
  let preview = (await page.textContent("#img-cdn-preview")) || "";
  assert.ok(preview.includes("cdn.jsdelivr.net/gh/demo/blog@main"), preview);

  await page.fill("#img-cdn-custom", "https://img.example.com/{repo}/{branch}");
  preview = (await page.textContent("#img-cdn-preview")) || "";
  assert.ok(preview.includes("https://img.example.com/demo/blog/main/img-qexo"), preview);
  assert.ok((await page.textContent("#img-cdn-status")).includes("已生效"));

  await page.fill("#img-cdn-custom", "not a url");
  preview = (await page.textContent("#img-cdn-preview")) || "";
  assert.ok(preview.includes("cdn.jsdelivr.net"), `${preview} — 非法输入应回退到下拉预设`);
  assert.ok((await page.textContent("#img-cdn-status")).includes("不合法"));

  await page.fill("#img-cdn-custom", "https://img.example.com/{repo}/{branch}");
  await page.fill("#img-dir", "my-images");
  await page.click("#save-image");
  await page.waitForTimeout(400);
  await page.goto(base + "/#/settings/image");
  await page.waitForSelector("#img-cdn-preset");
  assert.equal(await page.inputValue("#img-dir"), "my-images");
  assert.equal(await page.inputValue("#img-cdn-preset"), "jsdelivr");
  assert.equal(await page.inputValue("#img-cdn-custom"), "https://img.example.com/{repo}/{branch}");

  await page.selectOption("#img-type", "关闭");
  await page.click("#save-image");
  await page.waitForTimeout(300);
  return `${presets.length} 个预设 · 自定义优先级与回填已验证`;
});

await step("ui: 安全页 Turnstile 开关与页内启用说明", async () => {
  await page.goto(base + "/#/settings/security");
  await page.waitForSelector("#ts-enabled");
  assert.equal(await page.isChecked("#ts-enabled"), false, "默认应为关闭");
  assert.ok(((await page.textContent("#ts-tag")) || "").includes("已关闭"));
  const summary = (await page.textContent("#ts-summary")) || "";
  assert.ok(summary.includes("前置条件") && summary.includes("未生效"), summary);

  await page.click("#ts-howto");
  await page.waitForSelector("#modal:not([hidden])");
  const modalText = (await page.textContent("#modal-body")) || "";
  assert.ok(modalText.includes("前置条件") && modalText.includes("wrangler secret put"), modalText.slice(0, 200));
  const links = await page.$$eval("#modal-body a", (els) => els.length);
  assert.equal(links, 0, "说明浮层不应包含外链");
  await page.click("#modal-foot button");
  await page.waitForFunction(() => document.getElementById("modal")?.hidden === true, null, { timeout: 10000 });
  assert.equal(await page.isChecked("#ts-enabled"), false, "关闭弹窗后开关状态应保持");

  await page.click("#ts-enabled");
  await page.waitForFunction(
    () => (document.getElementById("ts-status")?.textContent || "").includes("前置条件"),
    null,
    { timeout: 10000 },
  );
  assert.ok(((await page.textContent("#ts-tag")) || "").includes("已开启"), "开启后徽标未更新");
  assert.equal(await page.isChecked("#ts-enabled"), true);

  await page.click("#ts-enabled");
  await page.waitForFunction(
    () => (document.getElementById("ts-tag")?.textContent || "").includes("已关闭"),
    null,
    { timeout: 10000 },
  );
  return "默认可见 / 页内说明无外链 / 即时反馈 / 关闭保持状态";
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

await step("ui: 按钮组件规范与状态反馈", async () => {
  await page.goto(base + "/#/settings/provider", { waitUntil: "networkidle" });
  await page.waitForSelector("#save-provider");
  const spec = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById("save-provider"));
    const menu = document.getElementById("menu-toggle");
    return {
      height: cs.height, gap: cs.columnGap, pad: cs.paddingLeft, radius: cs.borderRadius,
      heights: [...new Set([...document.querySelectorAll(".btn")]
        .filter((e) => e.getClientRects().length > 0)
        .map((e) => Math.round(e.getBoundingClientRect().height)))].sort((a, b) => a - b),
      dur: cs.transitionDuration,
      easeCount: new Set(cs.transitionTimingFunction.match(/(?:cubic-bezier\([^)]*\)|ease(?:-in|-out|-in-out)?|linear)/g) || []).size,
      props: cs.transitionProperty, restBg: cs.backgroundColor,
      menuSvg: !!menu.querySelector("svg"), menuText: menu.textContent.trim(),
    };
  });
  assert.equal(spec.height, "36px", "基准按钮高度");
  assert.equal(spec.gap, "8px", "图标与文字间距");
  assert.equal(spec.pad, "14px", "水平内边距");
  assert.ok(spec.heights.every((h) => h === 36 || h === 28), `按钮高度集合 ${spec.heights}`);
  assert.ok(spec.dur.includes("0.14s") && spec.dur.includes("0.09s"), spec.dur);
  assert.equal(spec.easeCount, 1, "应只使用一条缓动曲线");
  assert.ok(!spec.props.split(",").map((s) => s.trim()).includes("all"), "禁止 transition: all");
  assert.equal(spec.menuSvg, true, "菜单按钮应使用线性图标");
  assert.equal(spec.menuText, "", "菜单按钮不应残留字符图标");

  // 键盘聚焦：2px 强调色轮廓
  await page.keyboard.press("Tab");
  await page.locator("#save-provider").focus();
  const focus = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById("save-provider"));
    return { w: cs.outlineWidth, c: cs.outlineColor };
  });
  assert.equal(focus.w, "2px", focus.c);

  // 按下：1px 下沉
  const box = await page.locator("#save-provider").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(160);
  const active = await page.evaluate(() => getComputedStyle(document.getElementById("save-provider")).transform);
  await page.mouse.up();
  assert.ok(active.includes("matrix(1, 0, 0, 1, 0, 1)"), active);

  // 禁用：无位移、悬停不改变背景
  await page.evaluate(() => { document.getElementById("save-provider").disabled = true; });
  await page.hover("#save-provider");
  await page.waitForTimeout(180);
  const disabled = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById("save-provider"));
    return { tf: cs.transform, bg: cs.backgroundColor, op: cs.opacity };
  });
  await page.evaluate(() => { document.getElementById("save-provider").disabled = false; });
  assert.equal(disabled.tf, "none");
  assert.equal(disabled.bg, spec.restBg, "禁用态悬停不应改变背景");
  assert.equal(disabled.op, "0.5");

  // 圆角随主题换档
  const radii = {};
  for (const id of ["midnight", "eink"]) {
    await page.evaluate((x) => window.QexoStyles.apply(x), id);
    await page.waitForTimeout(240);
    radii[id] = await page.evaluate(() => getComputedStyle(document.getElementById("save-provider")).borderRadius);
  }
  await page.evaluate(() => window.QexoStyles.apply("midnight"));
  assert.equal(radii.midnight, "8px", radii.midnight);
  assert.equal(radii.eink, "0px", radii.eink);
  return `36/28px · 8px/0px 主题圆角 · 140/90ms 单一缓动 · 焦点/按下/禁用已覆盖`;
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
