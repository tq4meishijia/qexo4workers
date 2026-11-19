/**
 * 全站交互反馈回归测试（v1.7.0）。
 *
 * 覆盖：列表加载态、列表失败态、保存按钮加载态、弹窗防重复提交与失败反馈、
 * 上传进度文案与控件锁定、上传失败反馈；全程收集页面 JS 错误。
 * 前置：自带 harness（mock GitHub :8788 + wrangler dev :8787，fresh D1）。
 * 运行：`node test/feedback.mjs`
 * 产物：`test/out/feedback-report.json`
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { startServers } from "./harness.mjs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
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

console.log("\n全站交互反馈回归\n" + "=".repeat(48));
await initBackend();

// 供上传用例使用的最小 PNG（1x1 透明）
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
fs.mkdirSync("test/out", { recursive: true });
fs.writeFileSync("test/out/feedback-upload.png", PNG);

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => jsErrors.push(String(e)));

/** 延迟后放行；路由可能已被同模式的 fulfill 处理，吞掉「already handled」。 */
async function passThrough(route, delayMs = 0) {
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  await route.continue().catch(() => {});
}

/** 统一 500 失败响应；同样吞掉已被处理的竞态。 */
function failWith(route, msg) {
  return route
    .fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ status: false, msg }),
    })
    .catch(() => {});
}

await step("登录并进入控制台", async () => {
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "admin123");
  await page.click("#login-btn");
  await page.waitForFunction(() => location.hash === "#/dashboard", null, { timeout: 20000 });
  await page.waitForSelector(".stat", { timeout: 20000 });
  return "会话就绪";
});

await step("文章列表：先加载态后数据", async () => {
  await page.route("**/api/posts", (route) => passThrough(route, 900));
  try {
    await page.click('a[href="#/posts"]');
    await page.waitForSelector("#list .empty.is-loading", { timeout: 3000 });
    const snap = await page.evaluate(() => {
      const el = document.querySelector("#list .empty.is-loading");
      return {
        spin: Boolean(el?.querySelector(".spin")),
        text: (el?.textContent || "").trim(),
      };
    });
    assert.ok(snap.spin, "加载态缺少旋转指示器");
    assert.ok(/加载|正在读取/.test(snap.text), `加载文案异常：${snap.text}`);
    await page.waitForSelector("#list table", { timeout: 15000 });
    assert.equal(await page.locator("#list .empty.is-loading").count(), 0, "数据到达后加载态应消失");
    return "加载态 → 列表";
  } finally {
    await page.unroute("**/api/posts");
  }
});

await step("文章列表：失败态与错误提示", async () => {
  await page.route("**/api/posts", (route) => failWith(route, "模拟故障：仓库不可达"));
  try {
    await page.evaluate(() => (location.hash = "#/dashboard"));
    await page.waitForSelector(".stat", { timeout: 10000 });
    await page.click('a[href="#/posts"]');
    await page.waitForSelector("#list .empty:not(.is-loading)", { timeout: 8000 });
    const text = await page.textContent("#list");
    assert.ok(text.includes("加载失败"), `缺少失败态标题：${text.slice(0, 120)}`);
    assert.ok(text.includes("模拟故障"), "失败态未展示错误信息");
    assert.ok(await page.locator(".toast.err").count(), "缺少失败 toast");
    return "错误态 + toast";
  } finally {
    await page.unroute("**/api/posts");
  }
});

await step("设置保存：按钮加载态与恢复", async () => {
  await page.evaluate(() => (location.hash = "#/settings/basic"));
  await page.waitForSelector("#save-basic", { timeout: 10000 });
  await page.route("**/api/settings", (route) =>
    passThrough(route, route.request().method() === "POST" ? 800 : 0),
  );
  try {
    await page.click("#save-basic");
    await page.waitForSelector("#save-basic.is-loading", { timeout: 3000 });
    const busy = await page.evaluate(() => {
      const b = document.getElementById("save-basic");
      return { disabled: b.disabled, busy: b.getAttribute("aria-busy"), text: b.textContent.trim(), spin: Boolean(b.querySelector(".spin")) };
    });
    assert.equal(busy.disabled, true, "保存中应禁用按钮");
    assert.equal(busy.busy, "true", "应标记 aria-busy");
    assert.ok(busy.spin, "缺少旋转指示器");
    assert.ok(busy.text.includes("保存中"), `文案异常：${busy.text}`);
    await page.waitForSelector(".toast.ok", { timeout: 10000 });
    const restored = await page.evaluate(() => {
      const b = document.getElementById("save-basic");
      return { disabled: b.disabled, text: b.textContent.trim() };
    });
    assert.equal(restored.disabled, false, "完成后应恢复可用");
    assert.ok(restored.text.includes("保存"), `应恢复原文案：${restored.text}`);
    return "加载态 → 成功恢复";
  } finally {
    await page.unroute("**/api/settings");
  }
});

await step("弹窗创建文章：失败时保持打开、防重复提交、按钮恢复", async () => {
  await page.evaluate(() => (location.hash = "#/posts"));
  await page.waitForSelector("#list table", { timeout: 10000 });
  await page.click("#new");
  await page.waitForSelector("#modal:not([hidden])", { timeout: 5000 });
  await page.fill("#m-name", "fx-feedback");
  let calls = 0;
  await page.route("**/api/new_post", async (route) => {
    calls++;
    await new Promise((r) => setTimeout(r, 300));
    await route
      .fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ status: false, msg: "模拟失败：重名文件" }),
      })
      .catch(() => {});
  });
  try {
    await page.click("#modal-foot .btn.primary");
    await page.waitForSelector("#modal-foot .btn.primary.is-loading", { timeout: 3000 });
    const busy = await page.evaluate(() => {
      const foot = [...document.querySelectorAll("#modal-foot button")];
      return {
        anyDisabled: foot.filter((b) => b.disabled).length,
        total: foot.length,
        busy: foot[1]?.getAttribute("aria-busy"),
      };
    });
    assert.equal(busy.total, 2, "弹窗应有取消/创建两个按钮");
    assert.equal(busy.anyDisabled, 2, "提交期间应锁定全部弹窗按钮");
    assert.equal(busy.busy, "true", "被点按钮应标记 aria-busy");
    // 程序派发的重复点击必须被 JS 守卫拦截
    await page.evaluate(() => {
      const primary = [...document.querySelectorAll("#modal-foot button")].find((b) => b.classList.contains("primary"));
      primary?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForSelector('.toast.err:has-text("模拟失败")', { timeout: 8000 });
    assert.equal(calls, 1, `期望只提交 1 次，实际 ${calls} 次`);
    await page.waitForFunction(
      () => {
        const p = [...document.querySelectorAll("#modal-foot button")].find((b) => b.classList.contains("primary"));
        return p && !p.classList.contains("is-loading");
      },
      null,
      { timeout: 3000 },
    );
    assert.equal(await page.locator("#modal-foot .btn.primary.is-loading").count(), 0, "失败后应退出加载态");
    const modalOpen = await page.evaluate(() => !document.getElementById("modal").hidden);
    assert.equal(modalOpen, true, "失败后弹窗应保持打开以便重试");
    const enabled = await page.evaluate(() => {
      const foot = [...document.querySelectorAll("#modal-foot button")];
      return foot.every((b) => !b.disabled);
    });
    assert.equal(enabled, true, "失败后弹窗按钮应恢复可用");
    return `请求数 ${calls}，弹窗保持`;
  } finally {
    await page.unroute("**/api/new_post");
    await page.evaluate(() => document.getElementById("modal-close")?.click());
  }
});

await step("图床配置：保存 GitHub 内容源类型", async () => {
  await page.evaluate(() => (location.hash = "#/settings/image"));
  await page.waitForSelector("#img-type", { timeout: 10000 });
  try {
    await page.selectOption("#img-type", { label: "GitHub 内容源" }, { timeout: 8000 });
  } catch (e) {
    // 诊断：失败时转储页面状态，区分元素缺失 / 遮挡 / 渲染竞态
    const diag = await page.evaluate(() => ({
      hash: location.hash,
      modalHidden: document.getElementById("modal")?.hidden,
      selectOuter: document.getElementById("img-type")?.outerHTML.slice(0, 400) || null,
      optionLabels: [...(document.getElementById("img-type")?.options || [])].map((o) => o.label),
      topElement: document.elementFromPoint(300, 300)?.className || null,
    }));
    console.error("诊断:", JSON.stringify(diag, null, 2));
    throw e;
  }
  await page.click("#save-image");
  await page.waitForSelector('.toast.ok:has-text("保存成功")', { timeout: 10000 });
  return "IMG_HOST = GitHub 内容源";
});

await step("图床上传：进度文案 + 按钮锁定 + 成功", async () => {
  await page.evaluate(() => (location.hash = "#/images"));
  await page.waitForSelector("#grid .image-card, #grid .empty", { timeout: 10000 });
  await page.route("**/api/upload", (route) => passThrough(route, 700));
  try {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#pick")]);
    await chooser.setFiles("test/out/feedback-upload.png");
    await page.waitForFunction(() => {
      const d = document.getElementById("drop");
      return d && d.textContent.includes("正在上传");
    }, null, { timeout: 3000 });
    const busy = await page.evaluate(() => {
      const pick = document.getElementById("pick");
      const drop = document.getElementById("drop");
      return { disabled: pick.disabled, loading: pick.classList.contains("is-loading"), drop: drop.textContent.trim() };
    });
    assert.equal(busy.disabled, true, "上传期间应禁用上传按钮");
    assert.ok(busy.loading, "上传按钮缺少加载态");
    assert.ok(/正在上传 1\/1/.test(busy.drop), `进度文案异常：${busy.drop}`);
    await page.waitForSelector('.toast.ok:has-text("上传成功")', { timeout: 15000 });
    await page.waitForSelector("#grid .image-card", { timeout: 15000 });
    const restored = await page.evaluate(() => ({
      disabled: document.getElementById("pick").disabled,
      drop: document.getElementById("drop").textContent.trim(),
    }));
    assert.equal(restored.disabled, false, "上传完成后应恢复按钮");
    assert.ok(restored.drop.includes("拖拽"), `dropzone 文案应还原：${restored.drop}`);
    return busy.drop;
  } finally {
    await page.unroute("**/api/upload");
  }
});

await step("图床上传：失败反馈与控件恢复", async () => {
  await page.route("**/api/upload", (route) => failWith(route, "模拟失败：存储不可写"));
  try {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#pick")]);
    await chooser.setFiles("test/out/feedback-upload.png");
    await page.waitForSelector(".toast.err", { timeout: 10000 });
    const errText = await page.locator(".toast.err").last().innerText();
    assert.ok(errText.includes("模拟失败"), `失败提示未包含原因：${errText}`);
    const restored = await page.evaluate(() => ({
      disabled: document.getElementById("pick").disabled,
      drop: document.getElementById("drop").textContent.trim(),
    }));
    assert.equal(restored.disabled, false, "失败后应恢复上传按钮");
    assert.ok(restored.drop.includes("拖拽"), `失败后 dropzone 文案应还原：${restored.drop}`);
    return "失败 toast + 恢复";
  } finally {
    await page.unroute("**/api/upload");
  }
});

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(
  "test/out/feedback-report.json",
  JSON.stringify({ generated_at: new Date().toISOString(), total: results.length, passed, jsErrors, results }, null, 2),
);

console.log("=".repeat(48));
console.log(`${passed}/${results.length} passed, ${results.length - passed} failed${jsErrors.length ? `, jsErrors=${jsErrors.length}` : ""}`);
await browser.close();
await servers.stop();
process.exit(passed === results.length && jsErrors.length === 0 ? 0 : 1);
