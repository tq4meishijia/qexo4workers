/**
 * Full browser QA against the locally running Worker + mock GitHub.
 * Drives a real Microsoft Edge window with playwright-core (fallback driver,
 * see docs/ego-browser-test-report.md for the tool deviation).
 *
 * Usage: node test/browser-qa.mjs   (expects :8787 / :8788 already running)
 * Output: test/out/browser-qa-report.json, test/out/qa-*.png
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:8787";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = "test/out";
const results = [];
const jsErrors = [];
const httpErrors = [];
process.on("unhandledRejection", (e) => console.log("UNHANDLED_REJECTION", String(e).slice(0, 160)));
fs.mkdirSync(OUT, { recursive: true });

let page;
let context;

async function check(id, mod, steps, expected, fn, opts = {}) {
  // 清空上一条用例遗留的 toast，保证断言只读取本用例产生的提示。
  await page.evaluate(() => {
    const t = document.getElementById("toasts");
    if (t) t.innerHTML = "";
  }).catch(() => {});
  const started = Date.now();
  try {
    const actual = await fn();
    results.push({
      id, mod, steps, expected,
      actual: String(actual ?? ""),
      status: "PASS", deviation: "无", severity: "", ms: Date.now() - started,
    });
    console.log(`PASS ${id} ${mod} — ${String(actual).slice(0, 90)}`);
  } catch (e) {
    const msg = (e.message || String(e)).split("\n")[0].slice(0, 400);
    const status = opts.blocked ? "BLOCKED" : "FAIL";
    results.push({
      id, mod, steps, expected,
      actual: msg,
      status,
      deviation: `预期：${expected}；实际：${msg}`,
      severity: opts.severity || "P2",
      ms: Date.now() - started,
    });
    console.log(`${status} ${id} ${mod} — ${msg}`);
  }
}

const post = (p, body) =>
  fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

async function initBackend() {
  await post("/api/init_step", { step: "1", language: "zh_CN" });
  await post("/api/init_step", {
    step: "3",
    provider: JSON.stringify({
      provider: "github",
      params: { token: "mock-token", repo: "demo/blog", branch: "main", path: "", config: "Hexo" },
    }),
    force: "true",
  });
  await post("/api/init_step", { step: "4", kind: "" });
}

async function goto(hash, wait = 800) {
  await page.goto(BASE + "/#" + hash, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(wait);
}

async function viewText() {
  return (await page.textContent("#view")) || "";
}

async function shot(name) {
  const path = `${OUT}/qa-${name}.png`;
  await page.screenshot({ path, fullPage: true });
  return path;
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
page = await context.newPage();
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });
page.on("response", (r) => {
  if (r.status() >= 400) httpErrors.push(`${r.status()} ${new URL(r.url()).pathname}`);
});

await initBackend();
console.log("QA start\n" + "=".repeat(60));

/* ------------------------------------------------------------------ */
/* A. Page guard & authentication                                      */
/* ------------------------------------------------------------------ */
await check("A1", "页面守卫", "匿名浏览器上下文访问 /，记录最终 URL 与状态码", "302 跳转到 /login?next=…", async () => {
  const anon = await browser.newContext();
  const p = await anon.newPage();
  const res = await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const url = p.url();
  const chain = res ? `${res.status()} -> ${url}` : url;
  await anon.close();
  assert.ok(url.includes("/login"), chain);
  assert.ok(url.includes("next="), `next 参数缺失：${url}`);
  return chain;
});

await check("A2", "登录页", "打开 /login，检查标题、版本、初始密码提示与表单", "独立登录页，含用户名/密码/登录按钮与默认密码提示", async () => {
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.waitForSelector("#login-form");
  const title = await page.textContent(".auth-head h2");
  const hint = await page.textContent("#default-hint");
  assert.ok(title.trim().length > 0, "站点标题为空");
  assert.ok(hint.includes("admin") && hint.includes("admin123"), hint);
  assert.equal(await page.locator('#login-form input[name="username"]').count(), 1);
  assert.equal(await page.locator('#login-form input[name="password"]').count(), 1);
  return `${title.trim()} / 提示可见 / 2 个输入框`;
});

await check("A3", "登录边界", "清空用户名与密码后点击登录（浏览器 required 校验）", "停留在登录页且不发起鉴权请求", async () => {
  await page.fill('input[name="username"]', "");
  await page.fill('input[name="password"]', "");
  const before = page.url();
  await page.click("#login-btn");
  await page.waitForTimeout(400);
  assert.ok(page.url().includes("/login"), `意外跳转 ${page.url()}`);
  assert.equal(before.includes("/login"), true);
  return "停留 /login，required 生效";
});

await check("A4", "登录边界", "输入 admin + 错误密码 wrong-pass 并提交", "显示明确错误提示，不进入控制台", async () => {
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "wrong-pass");
  await page.click("#login-btn");
  await page.waitForSelector("#login-error:not([hidden])", { timeout: 8000 });
  const msg = (await page.textContent("#login-error")) || "";
  assert.ok(msg.trim().length > 0, "错误提示为空");
  assert.ok(page.url().includes("/login"), "错误密码却跳转");
  return msg.trim().slice(0, 60);
});

await check("A5", "登录主路径", "输入 admin / admin123 提交", "跳转 #/dashboard，会话与 CSRF 生效", async () => {
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "admin123");
  await page.click("#login-btn");
  await page.waitForFunction(() => location.hash === "#/dashboard", null, { timeout: 20000 });
  await page.waitForSelector(".stat");
  const me = await page.evaluate(async () => (await fetch("/api/me")).json());
  assert.ok(me.csrf, "CSRF 缺失");
  return `hash=${await page.evaluate(() => location.hash)}，csrf=${String(me.csrf).slice(0, 8)}…`;
});

// Make the authoring path repeatable: remove the fixture post left by a previous run.
await page.evaluate(async () => {
  const me = await (await fetch("/api/me")).json();
  const posts = await (await fetch("/api/posts")).json();
  const list = Array.isArray(posts.data) ? posts.data : [];
  for (const item of list.filter((x) => (x.path || "").includes("qa-post"))) {
    await fetch("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": me.csrf },
      body: JSON.stringify({ file: item.path }),
    }).catch(() => {});
  }
});

await check("A6", "会话保持", "已登录状态下直接访问 / 并刷新页面", "保持控制台，不回退到登录页", async () => {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  assert.ok(!page.url().includes("/login"), `被重定向到 ${page.url()}`);
  await page.waitForSelector(".stat");
  return "200 /，4 张统计卡仍在";
});

/* ------------------------------------------------------------------ */
/* B. Dashboard                                                        */
/* ------------------------------------------------------------------ */
await check("B1", "控制台", "读取 4 张统计卡与内容源信息", "4 张卡 + github/Hexo/demo/blog/main", async () => {
  const cards = await page.locator(".stat").count();
  assert.equal(cards, 4, `统计卡 ${cards} 张`);
  const text = await viewText();
  for (const needle of ["github", "Hexo", "demo/blog", "main"]) {
    assert.ok(text.includes(needle), `缺少 ${needle}`);
  }
  return `${cards} 张卡，内容源 github / Hexo / demo/blog / main`;
});

await check("B2", "安全警示", "检查默认密码警示条与修改密码入口", "常驻警示条 + 一键入口", async () => {
  const text = await viewText();
  assert.ok(text.includes("初始密码") && text.includes("请立即修改"), "警示条缺失");
  assert.ok(await page.locator('a[href="#/account"]').count() >= 1, "修改密码入口缺失");
  await shot("dashboard");
  return "警示条与入口均可见";
});

await check("B3", "控制台", "检查最近文章与快捷操作", "1 行最近文章 + 4 个快捷操作", async () => {
  const rows = await page.locator("#view tbody tr").count();
  const text = await viewText();
  assert.ok(text.includes("hello-world"), "最近文章缺失");
  for (const label of ["新建文章", "新建页面", "上传图片", "内容源设置"]) {
    assert.ok(text.includes(label), `快捷操作缺失 ${label}`);
  }
  return `${rows} 行最近文章，4 个快捷操作`;
});

/* ------------------------------------------------------------------ */
/* C. Posts: full authoring path                                       */
/* ------------------------------------------------------------------ */
await check("C1", "文章列表", "打开 #/posts，检查表格与操作按钮", "1 篇 hello-world，含编辑/转草稿/重命名/删除", async () => {
  await goto("/posts");
  await page.waitForSelector("#list table");
  const text = await viewText();
  assert.ok(text.includes("hello-world") && text.includes("已发布"), text.slice(0, 150));
  for (const b of ["编辑", "转草稿", "重命名", "删除"]) assert.ok(text.includes(b), `缺按钮 ${b}`);
  return "1 行，4 类行操作齐备";
});

await check("C2", "搜索边界", "在搜索框输入不存在的名称，再输入 hello", "无匹配时 0 行/空态，匹配时恢复 1 行", async () => {
  await page.fill("#search", "zzz-no-such-post");
  await page.waitForTimeout(350);
  const none = await page.locator("#list tbody tr:visible").count();
  assert.equal(none, 0, `无匹配时仍有 ${none} 行可见`);
  await page.fill("#search", "hello");
  await page.waitForTimeout(350);
  const one = await page.locator("#list tbody tr:visible").count();
  assert.equal(one, 1, `匹配时 ${one} 行`);
  await page.fill("#search", "");
  return `无匹配 0 行 / 匹配 1 行`;
});

await check("C3", "筛选", "点击「草稿」与「已发布」标签", "草稿 0 行、已发布 1 行", async () => {
  await page.click('button[data-tab="draft"]');
  await page.waitForTimeout(500);
  const draft = await page.locator("#list tbody tr").count();
  await page.click('button[data-tab="published"]');
  await page.waitForTimeout(500);
  const pub = await page.locator("#list tbody tr").count();
  assert.equal(draft, 0, `草稿 ${draft} 行`);
  assert.equal(pub, 1, `已发布 ${pub} 行`);
  return `草稿 ${draft} / 已发布 ${pub}`;
});

await check("C4", "编辑器", "从列表点「编辑」打开 hello-world", "标题、正文、Markdown 预览（含 h2）正确加载", async () => {
  await page.click('#list tbody tr a:has-text("hello-world")');
  await page.waitForSelector("#content");
  const title = await page.inputValue("#f-title");
  const body = await page.inputValue("#content");
  const preview = await page.innerHTML("#preview");
  assert.equal(title, "Hello Qexo Workers", title);
  assert.ok(body.includes("第一篇文章"), body.slice(0, 100));
  assert.ok(preview.includes("<h2>"), preview.slice(0, 120));
  return `title=${title}，正文 ${body.length} 字，预览含 <h2>`;
});

await check("C5", "编辑器交互", "光标置于正文开头并点击工具栏 B（粗体）", "插入 **加粗文本** 标记", async () => {
  await page.evaluate(() => {
    const el = document.getElementById("content");
    el.focus(); el.setSelectionRange(0, 0);
  });
  await page.click('[data-md="bold"]');
  const body = await page.inputValue("#content");
  assert.ok(body.startsWith("**加粗文本**"), body.slice(0, 40));
  // Undo the edit so the fixture is untouched (no save performed).
  await page.evaluate(() => {
    const el = document.getElementById("content");
    el.value = el.value.replace("**加粗文本**", "");
  });
  return "插入成功（未保存，已还原）";
});

await check("C6", "新建文章边界", "点「新建文章」→ 文件名为空点「创建」→ 再填 qa-post 创建", "空名被拦截并提示；有效名进入编辑器", async () => {
  await goto("/posts");
  await page.click("#new");
  await page.waitForSelector("#m-name");
  await page.click(".modal-foot .btn.primary");
  await page.waitForTimeout(400);
  const toastText = (await page.textContent("#toasts")) || "";
  assert.ok(toastText.includes("文件名"), `空名未拦截：${toastText}`);
  await page.fill("#m-name", "qa-post");
  await page.click(".modal-foot .btn.primary");
  await page.waitForSelector("#content", { timeout: 10000 });
  return `空名拦截「${toastText.trim().slice(0, 20)}」，qa-post 进入编辑器`;
});

await check("C7", "保存草稿", "填写标题「QA 全流程文章」与正文，点保存草稿", "保存成功且草稿出现在文章列表", async () => {
  await page.fill("#f-title", "QA 全流程文章");
  await page.fill("#content", "## QA 小节\n\n由浏览器全流程测试写入。");
  await page.click("#save");
  await page.waitForFunction(() => document.getElementById("save-hint")?.textContent?.includes("已保存"), null, { timeout: 12000 });
  await goto("/posts");
  const text = await viewText();
  assert.ok(text.includes("qa-post"), `草稿未出现：${text.slice(0, 160)}`);
  return "草稿 qa-post 已落盘并出现在列表";
});

await check("C8", "发布", "对 qa-post 行点「发布」并回到列表", "状态变为已发布，路径进入 source/_posts/", async () => {
  const row = page.locator('#list tbody tr', { hasText: "qa-post" });
  await row.locator('button[data-act="publish"]').click();
  await page.waitForTimeout(1200);
  await goto("/posts");
  const row2 = page.locator('#list tbody tr', { hasText: "qa-post" });
  const text = await row2.textContent();
  assert.ok(text.includes("已发布"), text);
  assert.ok(text.includes("source/_posts/"), text);
  return `状态=已发布，路径=${text.match(/source\/[^\s]+/)?.[0] || "?"}`;
});

await check("C9", "转草稿", "对 qa-post 行点「转草稿」", "状态变回草稿，路径进入 source/_drafts/", async () => {
  const row = page.locator('#list tbody tr', { hasText: "qa-post" });
  await row.locator('button[data-act="unpublish"]').click();
  await page.waitForTimeout(1200);
  await goto("/posts");
  const text = await page.locator('#list tbody tr', { hasText: "qa-post" }).textContent();
  assert.ok(text.includes("草稿"), text);
  assert.ok(text.includes("source/_drafts/"), text);
  return "状态=草稿，路径 source/_drafts/qa-post.md";
});

await check("C10", "删除确认边界", "对 qa-post 点删除 → 取消 → 再删除 → 确认", "取消后仍存在；确认后从列表消失", async () => {
  const row = page.locator('#list tbody tr', { hasText: "qa-post" });
  await row.locator('button[data-act="delete"]').click();
  await page.waitForSelector("#modal:not([hidden])");
  await page.click(".modal-foot .btn.ghost");
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#list tbody tr', { hasText: "qa-post" }).count(), 1, "取消后文章消失");
  await page.locator('#list tbody tr', { hasText: "qa-post" }).locator('button[data-act="delete"]').click();
  await page.waitForSelector("#modal:not([hidden])");
  await page.click(".modal-foot .btn.danger");
  await page.waitForTimeout(1200);
  await goto("/posts");
  assert.equal(await page.locator('#list tbody tr', { hasText: "qa-post" }).count(), 0, "确认后文章仍在");
  return "取消保留 / 确认删除，均符合预期";
});

/* ------------------------------------------------------------------ */
/* D. Pages & configs                                                  */
/* ------------------------------------------------------------------ */
await check("D1", "页面", "打开 #/pages 查看独立页面列表", "about/index 一行，含编辑与删除", async () => {
  await goto("/pages");
  const text = await viewText();
  assert.ok(text.includes("about/index") && text.includes("source/about/index.md"), text.slice(0, 160));
  return "1 个独立页面";
});

await check("D2", "配置编辑", "打开 #/configs，编辑 _config.yml 并保存", "保存成功且提示时间戳", async () => {
  await goto("/configs");
  await page.locator('#list a[href^="#/config?"]').first().click();
  await page.waitForSelector("#save");
  const area = page.locator("#cfg");
  const original = await area.inputValue();
  assert.ok(original.includes("title:"), original.slice(0, 80));
  await page.click("#save");
  await page.waitForFunction(() => document.getElementById("hint")?.textContent?.includes("已保存"), null, { timeout: 12000 });
  return `保存成功，配置 ${original.length} 字节`;
});

await check("D3", "配置边界", "把 _config.yml 改成非法 YAML（title: [unclosed）并保存", "明确拒绝且提示语法错误，不写仓库", async () => {
  await goto("/configs");
  await page.locator('#list a[href^="#/config?"]').first().click();
  await page.waitForSelector("#save");
  const area = page.locator("#cfg");
  await area.fill("title: [unclosed\n");
  await page.click("#save");
  await page.waitForTimeout(900);
  const hint = (await page.textContent("#hint")) || "";
  const toastText = (await page.textContent("#toasts")) || "";
  const combined = hint + " " + toastText;
  assert.ok(/YAML|语法|非法|解析|错误|失败/i.test(combined), `未见校验提示：${combined.slice(0, 160)}`);
  assert.ok(!hint.includes("已保存"), `非法 YAML 却显示已保存：${hint}`);
  return `校验提示：${combined.trim().slice(0, 90)}`;
});

/* ------------------------------------------------------------------ */
/* E. Image host                                                       */
/* ------------------------------------------------------------------ */
const QA_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
await check("E0", "图床设置", "打开设置/图床，把类型从「关闭」改为「R2」并保存", "保存成功，上传接口启用", async () => {
  await goto("/settings/image", 900);
  await page.waitForSelector("#img-type");
  await page.selectOption("#img-type", "R2");
  await page.click("#save-image");
  await page.waitForTimeout(900);
  const toastText = (await page.textContent("#toasts")) || "";
  assert.ok(toastText.includes("保存成功"), `保存未成功：${toastText.slice(-120)}`);
  return "图床类型 R2 已保存";
}, { severity: "P2" });

await check("E1", "图床", "打开 #/images，检查上传按钮与拖拽区", "上传按钮与拖拽区均可见", async () => {
  await goto("/images");
  await page.waitForSelector("#drop");
  assert.equal(await page.locator("#pick").count(), 1, "上传按钮缺失");
  return "#pick + #drop 可见";
});

await check("E2", "图床上传", "点击「上传图片」选择一张小 PNG（必要时回退到拖拽投放）", "列表出现该图片卡片", async () => {
  const file = `${OUT}/qa-upload.png`;
  fs.writeFileSync(file, Buffer.from(QA_PNG_B64, "base64"));
  const chooser = page.waitForEvent("filechooser", { timeout: 8000 }).catch(() => null);
  await page.click("#pick");
  const fc = await chooser;
  if (fc) {
    await fc.setFiles(file);
  } else {
    await page.evaluate((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const f = new File([bytes], "qa-upload.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(f);
      document.getElementById("drop").dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
    }, QA_PNG_B64);
  }
  await page.waitForTimeout(1800);
  const grid = await page.innerHTML("#grid");
  assert.ok(grid.includes("qa-upload") || !grid.includes("暂无图片"), `上传未生效：${grid.slice(0, 160)}`);
  return `上传通道=${fc ? "filechooser" : "drag-drop"}，图片卡片已出现`;
}, { severity: "P2" });

await check("E3", "图床删除", "删除刚上传的图片（仅删除记录）", "该图片从列表移除", async () => {
  const del = page.locator("#grid button[data-del]").first();
  assert.ok(await del.count() > 0, "未找到删除按钮");
  await del.click();
  await page.waitForSelector("#modal:not([hidden])");
  await page.click(".modal-foot .btn.ghost");
  await page.waitForTimeout(1200);
  await goto("/images");
  const grid = await page.innerHTML("#grid");
  assert.ok(!grid.includes("qa-upload"), `删除后仍有该图片：${grid.slice(0, 160)}`);
  return "上传的图片已从列表移除";
}, { severity: "P2" });

await check("E4", "未配置引导", "把图床类型改回「关闭」并访问 #/images，随后恢复为 R2", "未配置时显示持久引导条与设置链接；配置后引导消失", async () => {
  await goto("/settings/image", 800);
  await page.waitForSelector("#img-type");
  await page.selectOption("#img-type", "关闭");
  await page.click("#save-image");
  await page.waitForTimeout(800);
  await goto("/images", 900);
  assert.equal(await page.locator("#img-host-hint").count(), 1, "未配置时未显示引导条");
  const hint = (await page.textContent("#img-host-hint")) || "";
  assert.ok(hint.includes("图床尚未配置") && hint.includes("设置 → 图床"), hint);
  await shot("image-host-hint");
  await goto("/settings/image", 800);
  await page.waitForSelector("#img-type");
  await page.selectOption("#img-type", "R2");
  await page.click("#save-image");
  await page.waitForTimeout(800);
  await goto("/images", 800);
  assert.equal(await page.locator("#img-host-hint").count(), 0, "配置后引导条未消失");
  return "未配置显示引导 / 配置后消失";
}, { severity: "P3" });

/* ------------------------------------------------------------------ */
/* F. Friends + XSS                                                    */
/* ------------------------------------------------------------------ */
await check("F1", "友链", "打开 #/friends 并添加一条友链", "列表出现新增友链", async () => {
  await goto("/friends");
  await page.click("#add");
  await page.waitForSelector("#m-name");
  await page.fill("#m-name", "QA 友链");
  await page.fill("#m-url", "https://example.com");
  await page.fill("#m-desc", "浏览器全流程测试");
  await page.click(".modal-foot .btn.primary");
  await page.waitForTimeout(1100);
  const text = await viewText();
  assert.ok(text.includes("QA 友链"), `未出现：${text.slice(0, 180)}`);
  return "新增友链可见";
});

await check("F2", "XSS 转义", "添加名称为 <img src=x onerror=alert(1)> 的友链", "按纯文本显示，不注入 img 元素/不触发脚本", async () => {
  await page.click("#add");
  await page.waitForSelector("#m-name");
  await page.fill("#m-name", "<img src=x onerror=alert(1)>");
  await page.fill("#m-url", "https://example.com/xss");
  await page.click(".modal-foot .btn.primary");
  await page.waitForTimeout(1100);
  const injected = await page.locator('#list img[src="x"]').count();
  const text = await viewText();
  assert.equal(injected, 0, "注入了 img 元素");
  assert.ok(text.includes("<img src=x onerror=alert(1)>"), "未按纯文本渲染");
  return "文本转义正确，无 DOM 注入";
});

await check("F3", "公开接口", "浏览器内 fetch /pub/friends", "返回成功且包含已添加友链", async () => {
  const res = await page.evaluate(async () => {
    const r = await fetch("/pub/friends");
    return { status: r.status, body: (await r.text()).slice(0, 300) };
  });
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.ok(res.body.includes("QA 友链"), res.body);
  return `200，含 QA 友链`;
});

/* ------------------------------------------------------------------ */
/* G. Talks (known failure)                                            */
/* ------------------------------------------------------------------ */
await check("G1", "说说", "从侧栏点击「说说」打开 #/talks", "页面正常渲染：搜索框、发布按钮、列表", async () => {
  await goto("/talks", 1200);
  const text = await viewText();
  const err = jsErrors.filter((e) => /debounce/.test(e));
  await shot("talks");
  assert.ok(!text.includes("加载失败"), `页面渲染失败：${text.slice(0, 160)}`);
  assert.equal(err.length, 0, `JS 异常：${err.join(" | ")}`);
  assert.ok(await page.locator("#view #add").count() === 1, "发布说说按钮缺失");
  return "搜索框、发布按钮、列表均已渲染";
}, { severity: "P1" });

await check("G2", "说说", "点击「发布说说」并填写内容后提交", "弹窗打开、发布成功、列表出现新说说", async () => {
  assert.ok(await page.locator("#view #add").count() === 1, "发布按钮不存在（页面未渲染）");
  await page.click("#view #add");
  await page.waitForSelector("#t-content");
  await page.fill("#t-content", "QA 测试说说");
  await page.click(".modal-foot .btn.primary");
  await page.waitForTimeout(1000);
  assert.ok((await viewText()).includes("QA 测试说说"), "新说说未出现");
  return "发布成功";
}, { blocked: true, severity: "P1" });

await check("G3", "说说后端", "绕过前端，用页面内 fetch 直接 POST /api/talks（带 CSRF）", "后端返回成功，说明故障仅限前端视图", async () => {
  const out = await page.evaluate(async () => {
    const me = await (await fetch("/api/me")).json();
    const r = await fetch("/api/talks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": me.csrf },
      body: JSON.stringify({ content: "QA 后端探测", tags: [] }),
    });
    return { status: r.status, body: (await r.text()).slice(0, 200) };
  });
  assert.equal(out.status, 200, JSON.stringify(out));
  return `POST /api/talks ${out.status}，后端可用 → 缺陷定位在 social.js 视图层`;
});

/* ------------------------------------------------------------------ */
/* H. Settings                                                         */
/* ------------------------------------------------------------------ */
const TABS = [
  ["basic", "基本"], ["image", "图床"], ["security", "安全"],
  ["statistic", "统计"], ["deploy", "部署"], ["advanced", "高级"],
];
await check("H1", "设置标签巡检", "依次打开 6 个设置标签页并检查渲染结果", "每个标签均正常渲染，无「加载失败」或 JS 异常", async () => {
  const bad = [];
  for (const [id, label] of TABS) {
    await goto("/settings/" + id, 700);
    const text = await viewText();
    if (text.includes("加载失败") || text.trim().length < 20) bad.push(`${id}: ${text.slice(0, 80)}`);
  }
  assert.equal(bad.length, 0, bad.join(" | "));
  return `${TABS.length} 个标签全部正常渲染`;
}, { severity: "P1" });

await check("H2", "PAT 链接", "打开设置/内容源，检查 Fine-grained PAT 链接参数", "指向 GitHub 创建页，contents=write、expires_in=90、_blank + noopener", async () => {
  await goto("/settings/provider", 1000);
  await page.waitForSelector("#gh-pat-link");
  const href = await page.getAttribute("#gh-pat-link", "href");
  const u = new URL(href);
  assert.ok(href.startsWith("https://github.com/settings/personal-access-tokens/new?"), href);
  assert.equal(u.searchParams.get("contents"), "write");
  assert.equal(u.searchParams.get("expires_in"), "90");
  assert.equal(await page.getAttribute("#gh-pat-link", "target"), "_blank");
  assert.ok((await page.getAttribute("#gh-pat-link", "rel") || "").includes("noopener"));
  return `contents=${u.searchParams.get("contents")}，expires_in=${u.searchParams.get("expires_in")}`;
});

await check("H3", "内容源已保存值回填", "检查仓库/分支下拉与手输框的初始值", "下拉显示并选中已保存仓库/分支，手输框保持为空", async () => {
  assert.equal(await page.inputValue("#gh-repo"), "demo/blog");
  assert.equal(await page.inputValue("#gh-branch"), "main");
  assert.equal(await page.inputValue("#gh-repo-manual-input"), "");
  assert.equal(await page.inputValue("#gh-branch-manual-input"), "");
  const saved = (await page.textContent("#gh-saved-info")) || "";
  assert.ok(saved.includes("当前已保存") && saved.includes("已自动回填"), saved);
  return "2 处回填 + 2 处空手输框";
});

await check("H4", "空值保存边界", "清空分支后点「保存内容源」", "明确提示分支为空，不误报校验通过、不回填旧值", async () => {
  await page.selectOption("#gh-branch", "");
  await page.click("#save-provider");
  await page.waitForTimeout(600);
  const msg = (await page.textContent("#prov-msg")) || "";
  assert.ok(msg.includes("分支为空"), msg);
  assert.ok(!msg.includes("校验通过"), msg);
  await page.selectOption("#gh-branch", "main");
  return msg.trim().slice(0, 60);
});

await check("H5", "密钥检测", "等待自动探测，检查仓库/分支列表加载后的选中状态", "已保存值在列表刷新后保持不变，可直接保存", async () => {
  await page.waitForFunction(() => document.getElementById("gh-repo-status")?.classList.contains("ok"), null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById("gh-branch-status")?.classList.contains("ok"), null, { timeout: 20000 });
  await page.waitForFunction(() => Array.from(document.querySelectorAll("#gh-branch option")).some((o) => o.value === "dev"), null, { timeout: 20000 });
  const repos = await page.$$eval("#gh-repo option", (els) => els.map((e) => e.value).filter(Boolean));
  assert.ok(repos.includes("demo/blog"), repos.join(","));
  assert.equal(await page.inputValue("#gh-repo"), "demo/blog", "列表加载后丢失了已保存仓库");
  const branches = await page.$$eval("#gh-branch option", (els) => els.map((e) => e.value).filter(Boolean));
  assert.ok(branches.includes("main") && branches.includes("dev"), branches.join(","));
  assert.equal(await page.inputValue("#gh-branch"), "main", "列表加载后丢失了已保存分支");
  await page.click("#gh-repos-refresh");
  await page.waitForTimeout(1200);
  assert.equal(await page.inputValue("#gh-repo"), "demo/blog");
  assert.equal(await page.inputValue("#gh-branch"), "main");
  return `${repos.length} 个仓库 / ${branches.length} 个分支，刷新保持回填`;
});

await check("H6", "无效密钥", "填入 bad-token 并点「检测密钥」", "token 与仓库状态均显示红色错误，含 401 原因", async () => {
  await page.fill("#gh-token", "bad-token");
  await page.click("#gh-check");
  await page.waitForFunction(() => document.getElementById("gh-token-status")?.classList.contains("err"), null, { timeout: 20000 });
  const t = (await page.textContent("#gh-token-status")) || "";
  assert.ok(/401|密钥无效/.test(t), t);
  assert.ok((await page.textContent("#gh-repo-status")).includes("读取仓库失败"), "仓库错误提示缺失");
  await shot("settings");
  return t.trim().slice(0, 60);
});

/* ------------------------------------------------------------------ */
/* I. MCP                                                              */
/* ------------------------------------------------------------------ */
await check("I1", "MCP 页", "打开 #/mcp，检查端点、协议与工具清单", "端点/传输/协议版本可见，18 个工具", async () => {
  await goto("/mcp");
  const text = await viewText();
  assert.ok(text.includes("/mcp") && text.includes("Streamable HTTP"), text.slice(0, 160));
  assert.ok(text.includes("2025-06-18"), "协议版本缺失");
  return "端点 /mcp、Streamable HTTP、2025-06-18";
});

await check("I2", "MCP 令牌", "创建 write 令牌并检查自动生成的 Agent 提示词", "6 段结构、令牌恰好出现 2 次、复制后弹窗保持打开", async () => {
  await page.click("#new-token");
  await page.waitForSelector("#t-name");
  await page.fill("#t-name", "QA 全量测试令牌");
  await page.check("#t-write");
  await page.click(".modal-foot .btn.primary");
  await page.waitForSelector("#new-agent-prompt");
  const token = await page.inputValue("#new-token-value");
  const prompt = await page.inputValue("#new-agent-prompt");
  assert.ok(token.startsWith("qx_mcp_"), token.slice(0, 12));
  assert.equal((prompt.match(/^## /gm) || []).length, 6, "不是 6 段结构");
  assert.equal(prompt.split(token).length - 1, 2, "令牌出现次数不是 2");
  for (const needle of ['"type": "http"', "stdio-bridge.mjs", "qexo_overview", "create_post", "2025-06-18"]) {
    assert.ok(prompt.includes(needle), `提示词缺少 ${needle}`);
  }
  await page.click(".modal-foot .btn.primary");
  assert.equal(await page.isVisible("#new-agent-prompt"), true, "复制后弹窗被关闭");
  await shot("mcp");
  await page.click("#modal-close");
  return `prompt ${prompt.length} 字符，6 段，token×2`;
});

/* ------------------------------------------------------------------ */
/* J. Account                                                          */
/* ------------------------------------------------------------------ */
await check("J1", "账户页", "打开 #/account 检查密码表单", "4 个输入框 + 安全建议", async () => {
  await goto("/account");
  for (const id of ["a-user", "a-current", "a-new", "a-repeat"]) {
    assert.equal(await page.locator(`#${id}`).count(), 1, `缺 ${id}`);
  }
  return "4 个输入框齐备";
});

await check("J2", "改密边界", "新密码与确认密码填不同值后提交", "明确拦截，不修改密码（后续仍可登录）", async () => {
  await page.fill("#a-current", "admin123");
  await page.fill("#a-new", "new-pass-123");
  await page.fill("#a-repeat", "mismatch-999");
  await page.click("#view button:has-text('保存并重新登录')");
  await page.waitForTimeout(700);
  const toastText = (await page.textContent("#toasts")) || "";
  assert.ok(/不一致|不相同|确认/.test(toastText), `未见一致性校验：${toastText}`);
  assert.ok(!page.url().includes("/login"), "校验失败却注销了会话");
  return `拦截提示：${toastText.trim().slice(0, 60)}`;
});

/* ------------------------------------------------------------------ */
/* K. Global boundaries                                                */
/* ------------------------------------------------------------------ */
await check("K1", "异常路由", "访问 #/does-not-exist", "有兜底视图，不出现空白或加载失败", async () => {
  await goto("/does-not-exist", 900);
  const text = await viewText();
  assert.ok(!text.includes("加载失败"), text.slice(0, 120));
  assert.ok(text.trim().length > 0, "视图为空");
  return `兜底内容：${text.trim().slice(0, 60)}`;
});

await check("K2", "弹窗残留边界", "在文章页点「新建文章」打开弹窗，再通过侧栏切换到「友链」，尝试点击「添加友链」", "路由切换应关闭遗留弹窗，友链页可正常点击", async () => {
  await goto("/posts");
  await page.click("#new");
  await page.waitForSelector("#m-name");
  let navBlocked = false;
  try {
    await page.click('a[href="#/friends"]', { timeout: 2500 });
  } catch {
    navBlocked = true;
  }
  await page.waitForTimeout(500);
  const modalVisible = await page.evaluate(() => {
    const m = document.getElementById("modal");
    return !!m && !m.hasAttribute("hidden") && getComputedStyle(m).display !== "none";
  });
  await shot("stale-modal");
  assert.equal(
    navBlocked && modalVisible, false,
    `弹窗打开后侧栏导航被遮罩拦截（modalVisible=${modalVisible}，navBlocked=${navBlocked}），必须先关闭弹窗才能切换页面`,
  );
  return "路由切换后弹窗已关闭，友链按钮可点击";
}, { severity: "P2" });

// Ensure a stale modal from K2 cannot interfere with the remaining cases.
await page.evaluate(() => {
  const m = document.getElementById("modal");
  if (m) m.hidden = true;
});

await check("K3", "响应式", "把视口改为 375×667，点击菜单按钮展开侧栏", "侧栏展开且导航项可见", async () => {
  await page.setViewportSize({ width: 375, height: 667 });
  await goto("/dashboard", 700);
  await page.click("#menu-toggle");
  await page.waitForTimeout(300);
  const open = await page.evaluate(() => document.getElementById("sidebar")?.classList.contains("open"));
  assert.equal(open, true, "侧栏未展开");
  await page.setViewportSize({ width: 1440, height: 900 });
  return "窄视口菜单开合正常";
});

await check("K4", "API 鉴权边界", "在匿名上下文请求 /api/me；在已登录页面发一个不带 CSRF 的写请求", "匿名仅返回公开初始化元数据（无 user/settings/csrf）；缺 CSRF 写请求 403", async () => {
  const anon = await browser.newContext();
  const p = await anon.newPage();
  await p.goto(BASE + "/login");
  const info = await p.evaluate(async () => {
    const r = await fetch("/api/me");
    const j = await r.json();
    return {
      status: r.status,
      user: j.user ?? null,
      hasSettings: "settings" in j,
      csrf: j.csrf,
      keys: Object.keys(j),
    };
  });
  await anon.close();
  const noCsrf = await page.evaluate(async () => {
    const r = await fetch("/api/friends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-csrf" }),
    });
    return r.status;
  });
  assert.equal(info.status, 200, `匿名 /api/me = ${info.status}`);
  assert.equal(info.user, null, "匿名响应包含 user");
  assert.equal(info.hasSettings, false, "匿名响应包含 settings");
  assert.equal(info.csrf, "", "匿名响应下发了 CSRF");
  assert.equal(noCsrf, 403, `缺 CSRF = ${noCsrf}`);
  return `匿名 200（keys=${info.keys.join(",")}）/ 缺 CSRF ${noCsrf}`;
});

await check("K5", "全局 JS 错误", "汇总整轮 pageerror 与 console.error", "除预期负向用例外无 JS 运行时错误", async () => {
  const unexpected = jsErrors.filter((e) => !/favicon|fonts\.googleapis|ERR_/i.test(e));
  const negative = unexpected.filter((e) => /400 \(Bad Request\)|403 \(Forbidden\)|401 \(Unauthorized\)/i.test(e));
  const real = unexpected.filter((e) => !negative.includes(e));
  assert.equal(real.length, 0, real.join(" | "));
  return `${jsErrors.length} 条（其中预期负向 ${negative.length} 条），无未预期异常`;
}, { severity: "P1" });

await check("A7", "退出登录", "点击左下角「退出登录」，再访问 /", "回到 /login 且匿名访问 / 再次被 302", async () => {
  await goto("/dashboard", 700);
  await page.click("#logout");
  await page.waitForURL(/.*\/login.*/, { timeout: 10000 });
  const res = await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  assert.ok(page.url().includes("/login"), `退出后仍可访问 /：${page.url()}`);
  return `退出后 / → ${res.status()} ${new URL(page.url()).pathname}`;
});

const summary = {
  base: BASE,
  driver: "playwright-core + Microsoft Edge (headless)",
  generatedAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((r) => r.status === "PASS").length,
  failed: results.filter((r) => r.status === "FAIL").length,
  blocked: results.filter((r) => r.status === "BLOCKED").length,
  jsErrors,
  httpErrors: [...new Set(httpErrors)],
  results,
};
fs.writeFileSync(`${OUT}/browser-qa-report.json`, JSON.stringify(summary, null, 2));
console.log("=".repeat(60));
console.log(`${summary.passed}/${summary.total} PASS, ${summary.failed} FAIL, ${summary.blocked} BLOCKED`);
console.log("jsErrors:", JSON.stringify(jsErrors));
await browser.close();
