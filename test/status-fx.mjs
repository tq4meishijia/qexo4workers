/**
 * 文章状态切换反馈回归测试（仅发布 / 转草稿两类操作）。
 *
 * 覆盖：加载态 → 成功态、转回草稿、请求失败、连续点击只提交一次、状态未变化。
 * 前置：`node test/ego-serve.mjs` 常驻 :8787（mock GitHub 在 :8788）。
 * 运行：`node test/status-fx.mjs`
 * 产物：`test/out/status-fx-report.json`
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:8787";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const REPO = "test/out/ego-repo";
const OUT = "test/out";
const DRAFT_REL = "source/_drafts/fx-status-draft.md";
const POST_REL = "source/_posts/fx-status-post.md";
const NAME = "fx-status-draft"; // 列表按文件名定位（刷新索引后 title 为空，发布后才写入标题）
const TITLE = "状态反馈测试草稿";

const results = [];
const jsErrors = [];

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail: detail || "" });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
    return detail;
  } catch (e) {
    const msg = (e.message || String(e)).split("\n")[0];
    results.push({ name, ok: false, ms: Date.now() - started, detail: msg });
    console.error(`  ✗ ${name} — ${msg}`);
    return null;
  }
}

function writePost(rel, title) {
  const full = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `---\ntitle: ${title}\ndate: 2026-11-17 12:00:00\n---\n反馈测试正文\n`);
}

async function refreshIndex(page) {
  await page.waitForSelector("#refresh", { timeout: 10000 });
  const resp = page.waitForResponse((r) => r.url().includes("/api/posts/refresh") && r.status() === 200);
  await page.click("#refresh");
  await resp;
  await page.waitForSelector(`tr.post-row:has-text("${NAME}")`, { timeout: 15000 });
}

async function clearFx(page, ms = 1900) {
  await page.waitForTimeout(ms);
}

fs.mkdirSync(OUT, { recursive: true });
// 测试文件写进隔离仓库（ego-serve 的 mock 目录），再让后台刷新索引收进列表。
writePost(DRAFT_REL, TITLE);
writePost(POST_REL, "状态反馈测试已发布");

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => jsErrors.push(String(e)));

console.log("\n状态切换反馈回归\n" + "=".repeat(48));

await step("登录并进入文章页", async () => {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "admin123");
  await page.click("#login-btn");
  await page.waitForFunction(() => location.hash === "#/dashboard", null, { timeout: 20000 });
  // 等控制台统计渲染完，避免它的异步完成覆盖随后的文章页渲染
  await page.waitForSelector(".stat", { timeout: 20000 });
  await page.evaluate(() => {
    location.hash = "#/posts";
  });
  await page.waitForSelector("#list", { timeout: 15000 });
  await page.waitForSelector("tr.post-row", { timeout: 15000 });
  return "会话与列表就绪";
});

await step("刷新索引收进测试文章", async () => {
  await refreshIndex(page);
  return "草稿与已发布各一篇";
});

await step("发布：先加载态，后成功态", async () => {
  // 延迟 1200ms，让加载态可被稳定观察（本地响应通常在 100ms 内）
  await page.route("**/api/publish", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  const row = page.locator(`tr.post-row:has-text("${NAME}")`).first();
  await row.locator('button[data-act="publish"]').click();

  await page.waitForSelector("tr.post-row .btn.is-loading", { timeout: 3000 });
  // 一次取样读取按钮与状态列，避免多次往返把加载态读晚
  const snap = await page.evaluate((name) => {
    const tr = [...document.querySelectorAll("tr.post-row")].find((row) => row.textContent.includes(name));
    const btn = tr?.querySelector(".btn.is-loading");
    const cell = tr?.querySelector(".status-cell");
    return {
      loading: Boolean(btn),
      disabled: btn ? btn.disabled : null,
      busy: btn ? btn.getAttribute("aria-busy") : null,
      spin: Boolean(btn && btn.querySelector(".spin")),
      status: (cell?.textContent || "").trim(),
    };
  }, NAME);
  assert.equal(snap.loading, true, "缺少加载态按钮");
  assert.equal(snap.disabled, true, "加载态按钮应禁用");
  assert.equal(snap.busy, "true", "加载态按钮应标记 aria-busy");
  assert.equal(snap.spin, true, "缺少旋转指示器");
  assert.ok(snap.status.includes("发布中"), `状态列应为「发布中」，实际：${snap.status}`);

  await page.waitForSelector("tr.row-flash.ok", { timeout: 15000 });
  const okTag = await page.locator("tr.row-flash.ok .status-cell").first().innerText();
  assert.ok(okTag.includes("已发布"), `成功后状态列应为「已发布」，实际：${okTag}`);
  assert.ok(await page.locator("tr.row-flash.ok .tag.just-changed").count(), "状态标签缺少入场动画类");
  assert.ok(await page.locator(".toast.ok").count(), "缺少成功提示");
  await page.unroute("**/api/publish");
  return "加载 → 已发布";
});

await step("转草稿：成功态回到草稿", async () => {
  await clearFx(page);
  const row = page.locator(`tr.post-row:has-text("${NAME}")`).first();
  await row.locator('button[data-act="unpublish"]').click();
  await page.waitForSelector("tr.row-flash.ok", { timeout: 15000 });
  const tag = await page.locator("tr.row-flash.ok .status-cell").first().innerText();
  assert.ok(tag.includes("草稿"), `转回后状态列应为「草稿」，实际：${tag}`);
  assert.ok(await page.locator("tr.row-flash.ok .tag.just-changed").count());
  return "已发布 → 草稿";
});

await step("请求失败：行内失败态 + 错误提示 + 可重试", async () => {
  await clearFx(page);
  await page.route("**/api/publish", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ status: false, msg: "模拟失败：仓库不可写" }),
    }),
  );
  const row = page.locator(`tr.post-row:has-text("${NAME}")`).first();
  await row.locator('button[data-act="publish"]').click();

  await page.waitForSelector("tr.row-flash.err", { timeout: 8000 });
  assert.ok(await page.locator(".btn.is-error").count(), "失败按钮缺少错误态");
  const tag = await page.locator("tr.row-flash.err .tag.err").first().innerText();
  assert.ok(tag.includes("失败"), `状态列应为「失败」，实际：${tag}`);
  assert.ok(await page.locator(".toast.err").count(), "缺少失败提示");
  const retry = page.locator(`tr.post-row:has-text("${NAME}") button[data-act="publish"]`);
  assert.equal(await retry.isDisabled(), false, "失败后按钮应恢复可点击");
  await page.unroute("**/api/publish");
  await clearFx(page, 3800);
  return "失败态回退并可重试";
});

await step("连续点击：只提交一次", async () => {
  let calls = 0;
  await page.route("**/api/publish", async (route) => {
    calls++;
    await new Promise((r) => setTimeout(r, 500));
    await route.continue();
  });
  const btn = page.locator(`tr.post-row:has-text("${NAME}") button[data-act="publish"]`).first();
  await btn.click();
  // 模拟用户手快：在 pending 期间再次派发点击（此时按钮已 disabled）
  await page.evaluate(() => {
    const b = document.querySelector('tr.post-row button[data-act="publish"]');
    b?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector("tr.row-flash.ok", { timeout: 15000 });
  assert.equal(calls, 1, `期望只提交 1 次，实际 ${calls} 次`);
  await page.unroute("**/api/publish");
  return `请求数 ${calls}`;
});

await step("状态未变化：中性提示，不播放迁移", async () => {
  await clearFx(page);
  await page.route("**/api/unpublish", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: true,
        msg: "文章已是草稿状态，索引已同步",
        already: true,
        path: "source/_drafts/fx-status-draft.md",
      }),
    }),
  );
  const row = page.locator(`tr.post-row:has-text("${NAME}")`).first();
  await row.locator('button[data-act="unpublish"]').click();
  await page.waitForSelector('tr.post-row .status-cell:has-text("未变化")', { timeout: 8000 });
  assert.equal(await page.locator("tr.row-flash.ok").count(), 0, "未变化不应播放成功高亮");
  const tag = await page.locator('tr.post-row .status-cell:has-text("未变化")').first().innerText();
  assert.ok(tag.includes("草稿"), `未变化提示应保留当前状态，实际：${tag}`);
  await page.unroute("**/api/unpublish");
  await clearFx(page);
  return "中性「未变化」标签";
});

await step("其他操作不受影响（重命名仍可用）", async () => {
  const row = page.locator(`tr.post-row:has-text("${NAME}")`).first();
  const rename = row.locator('button[data-act="rename"]');
  assert.equal(await rename.isDisabled(), false, "非状态操作不应被禁用");
  await rename.click();
  await page.waitForSelector("#modal.show, #modal[open]", { timeout: 5000 }).catch(() => {});
  const hasModal = await page.evaluate(() => {
    const m = document.getElementById("modal");
    return Boolean(m && getComputedStyle(m).display !== "none" && m.textContent.includes("重命名"));
  });
  assert.ok(hasModal, "重命名弹窗未打开");
  await page.keyboard.press("Escape");
  return "重命名入口可用且未被状态反馈影响";
});

await step("清理测试文件", async () => {
  for (const rel of [
    DRAFT_REL,
    POST_REL,
    "source/_posts/fx-status-draft.md",
    "source/_drafts/fx-status-draft.md",
  ]) {
    fs.rmSync(path.join(REPO, rel), { force: true });
  }
  const resp = page.waitForResponse((r) => r.url().includes("/api/posts/refresh") && r.status() === 200);
  await page.click("#refresh");
  await resp;
  return "已删除 fx-status-*";
});

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(
  `${OUT}/status-fx-report.json`,
  JSON.stringify({ generated_at: new Date().toISOString(), total: results.length, passed, jsErrors, results }, null, 2),
);

console.log("=".repeat(48));
console.log(`${passed}/${results.length} passed, ${results.length - passed} failed${jsErrors.length ? `, jsErrors=${jsErrors.length}` : ""}`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
