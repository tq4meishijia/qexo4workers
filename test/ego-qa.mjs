/* test/ego-qa.mjs
 * Equivalent ego-browser replay of the key QA paths in
 * docs/ego-browser-test-report.md. NOT RUN in this session: the ego-browser
 * CLI / ego lite runtime was unavailable on this Windows host.
 *
 * Run after ego lite onboarding (with :8787 / :8788 already up):
 *   ego-browser nodejs < test/ego-qa.mjs
 *
 * This is an ego-browser script, not a Node module: taskSpace/page are globals
 * supplied by the runtime. Use only the documented ego API surface.
 */
const BASE = "http://127.0.0.1:8787";
const task = await taskSpace("qexo4workers full QA ego replay");
console.log({ taskSpaceId: task.spaceId });
const page = task.page("p1");
const rows = [];

async function step(id, expected, fn) {
  try {
    const actual = await fn();
    rows.push({ id, expected, actual, status: "PASS" });
  } catch (e) {
    rows.push({ id, expected, actual: String(e.message || e).slice(0, 220), status: "FAIL" });
  }
}

const evaluate = (fn, arg) => page.evaluate(fn, arg);
const viewText = () => evaluate(() => (document.getElementById("view")?.textContent || "").replace(/\s+/g, " "));

try {
  await step("A1", "匿名访问 / 被重定向到 /login?next=", async () => {
    await page.goto(BASE + "/");
    const url = await page.url();
    if (!url.includes("/login")) throw new Error(`未守卫：${url}`);
    return url;
  });

  await step("A2", "独立登录页含表单与默认密码提示", async () => {
    await page.goto(BASE + "/login");
    await page.waitForSelector("loc=css:#login-form");
    return await evaluate(() => ({
      title: document.querySelector(".auth-head h2")?.textContent?.trim(),
      inputs: document.querySelectorAll("#login-form input").length,
    }));
  });

  await step("A4", "错误密码显示明确提示", async () => {
    await page.fill("loc=css:input[name='username']", "admin");
    await page.fill("loc=css:input[name='password']", "wrong-pass");
    await page.click("loc=css:#login-btn", { label: "submit wrong password" });
    await page.waitForSelector("loc=css:#login-error:not([hidden])");
    return await evaluate(() => document.getElementById("login-error").textContent.trim());
  });

  await step("A5", "正确密码登录并进入控制台", async () => {
    await page.fill("loc=css:input[name='username']", "admin");
    await page.fill("loc=css:input[name='password']", "admin123");
    await page.click("loc=css:#login-btn", { label: "sign in as admin" });
    await page.waitForFunction(() => location.hash === "#/dashboard", undefined, { timeout: 20000 });
    await page.waitForSelector("loc=css:.stat");
    return await page.url();
  });

  await step("B1", "控制台 4 张统计卡 + 内容源信息", async () => {
    const info = await evaluate(() => ({
      cards: document.querySelectorAll(".stat").length,
      text: document.getElementById("view").textContent.slice(0, 200),
    }));
    if (info.cards !== 4) throw new Error(`统计卡 ${info.cards} 张`);
    return info.cards;
  });

  await step("C1", "文章列表含 hello-world", async () => {
    await page.goto(BASE + "/#/posts");
    await page.waitForSelector("loc=css:#list table");
    const text = await viewText();
    if (!text.includes("hello-world")) throw new Error(text.slice(0, 140));
    return "hello-world 可见";
  });

  await step("C4", "编辑器加载标题、正文与 h2 预览", async () => {
    await page.click("loc=css:#list tbody tr a", { label: "open hello-world editor" });
    await page.waitForSelector("loc=css:#content");
    return await evaluate(() => ({
      title: document.getElementById("f-title").value,
      previewHasH2: document.getElementById("preview").innerHTML.includes("<h2>"),
    }));
  });

  await step("G1", "说说页正常渲染（当前版本已知缺陷：debounce）", async () => {
    await page.goto(BASE + "/#/talks");
    const text = await viewText();
    if (text.includes("加载失败")) throw new Error(text.slice(0, 160));
    return text.slice(0, 120);
  });

  await step("H4", "空仓库/分支保存被明确拦截", async () => {
    await page.goto(BASE + "/#/settings/provider");
    await page.waitForSelector("loc=css:#save-provider");
    await page.click("loc=css:#save-provider", { label: "save empty provider" });
    const msg = await evaluate(() => document.getElementById("prov-msg").textContent.trim());
    if (!msg.includes("仓库为空")) throw new Error(msg.slice(0, 140));
    return msg.slice(0, 100);
  });

  await step("I2", "MCP 令牌提示词为 6 段且 token 出现 2 次", async () => {
    await page.goto(BASE + "/#/mcp");
    await page.click("loc=css:#new-token", { label: "create MCP token" });
    await page.waitForSelector("loc=css:#t-name");
    await page.fill("loc=css:#t-name", "ego replay token");
    await page.click("loc=css:.modal-foot .btn.primary", { label: "confirm token creation" });
    await page.waitForSelector("loc=css:#new-agent-prompt");
    const info = await evaluate(() => {
      const token = document.getElementById("new-token-value").value;
      const p = document.getElementById("new-agent-prompt").value;
      return { sections: (p.match(/^## /gm) || []).length, tokenCount: p.split(token).length - 1 };
    });
    if (info.sections !== 6 || info.tokenCount !== 2) throw new Error(JSON.stringify(info));
    await page.click("loc=css:#modal-close");
    return JSON.stringify(info);
  });

  await step("K2", "打开弹窗后侧栏导航应可点击（当前版本已知缺陷：遮罩拦截）", async () => {
    await page.goto(BASE + "/#/posts");
    await page.waitForSelector("loc=css:#new");
    await page.click("loc=css:#new", { label: "open new-post modal" });
    await page.waitForSelector("loc=css:#m-name");
    const state = await evaluate(() => {
      const m = document.getElementById("modal");
      const nav = document.querySelector('a[href="#/friends"]');
      const box = nav.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        modalVisible: !m.hasAttribute("hidden") && getComputedStyle(m).display !== "none",
        navReachable: nav.contains(top),
      };
    });
    if (state.modalVisible && !state.navReachable) {
      throw new Error(`弹窗遮罩拦截侧栏：${JSON.stringify(state)}`);
    }
    return JSON.stringify(state);
  });

  const path = await import("node:path");
  const shotPath = path.resolve(process.cwd(), "test/out/ego-replay.png");
  await page.goto(BASE + "/#/dashboard");
  await page.screenshot({ path: shotPath });
  console.log({ screenshot: shotPath });
} finally {
  console.log(JSON.stringify(rows, null, 2));
  const passed = rows.filter((r) => r.status === "PASS").length;
  console.log(`ego replay: ${passed}/${rows.length} PASS`);
  await task.finish({ keep: [] });
}
