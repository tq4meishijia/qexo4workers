/* Shell, authentication, initialization wizard and dashboard. */

import { api, esc, fmtDate, icon, openModal, refreshMe, renderRoute, route, setTitle, startRouter, state, t, toast } from "./core.js";
import { bindProviderFields, collectProviderParams, providerFieldsHtml } from "./provider-form.js";
import "./content.js";
import "./social.js";
import "./settings.js";
import "./mcp.js";

const NAV = [
  { group: "内容", items: [
    { href: "#/dashboard", icon: "dashboard", label: "控制台" },
    { href: "#/posts", icon: "posts", label: "文章" },
    { href: "#/pages", icon: "pages", label: "页面" },
    { href: "#/configs", icon: "configs", label: "配置" },
  ]},
  { group: "媒体与互动", items: [
    { href: "#/images", icon: "images", label: "图床" },
    { href: "#/friends", icon: "friends", label: "友链" },
    { href: "#/talks", icon: "talks", label: "说说" },
  ]},
  { group: "系统", items: [
    { href: "#/settings", icon: "settings", label: "设置" },
    { href: "#/mcp", icon: "plug", label: "MCP 接入" },
    { href: "#/account", icon: "user", label: "账户" },
  ]},
];

function buildNav() {
  const nav = document.getElementById("nav");
  nav.innerHTML = NAV.map((g) => `
    <div class="nav-group">${g.group}</div>
    ${g.items.map((i) => `<a class="nav-item" href="${i.href}">${icon(i.icon)}<span>${i.label}</span></a>`).join("")}
  `).join("");
}

/* ------------------------------------------------------------------ */
/* init                                                              */
/* ------------------------------------------------------------------ */

function providerPanel(platforms, providers, cfg = {}) {
  const provider = cfg.provider || "github";
  const meta = (providers || []).find((p) => p.name === provider) || providers?.[0];
  return `
    <div class="row">
      <label class="field"><span>仓库类型</span>
        <select id="prov-type">${(providers || []).map((p) => `<option value="${p.name}" ${p.name === provider ? "selected" : ""}>${p.name}</option>`).join("")}</select>
      </label>
      <label class="field"><span>博客平台</span>
        <select id="prov-platform">${(platforms || []).map((p) => `<option ${p === (cfg.params?.config || "Hexo") ? "selected" : ""}>${p}</option>`).join("")}</select>
      </label>
    </div>
    <div id="prov-fields">${providerFieldsHtml(meta, cfg.params || {})}</div>`;
}

function bindProviderPanel(providers) {
  const type = document.getElementById("prov-type");
  if (!type) return;
  const metaOf = () => providers.find((p) => p.name === type.value);
  let dispose = bindProviderFields(metaOf());
  type.onchange = () => {
    dispose();
    document.getElementById("prov-fields").innerHTML = providerFieldsHtml(metaOf(), {});
    dispose = bindProviderFields(metaOf());
  };
}

function collectProvider() {
  const params = { config: document.getElementById("prov-platform").value, ...collectProviderParams() };
  return { provider: document.getElementById("prov-type").value, params };
}

async function renderInit(view) {
  const meta = await api("/api/init/state");
  let step = meta.init < 3 ? 1 : meta.init < 4 ? 2 : meta.init < 5 ? 3 : 4;
  const steps = ["语言", "管理员", "内容源", "部署"];

  const draw = () => {
    view.innerHTML = `
      <div class="auth">
        <div class="auth-card" style="max-width:600px">
          <div class="auth-head">
            <span class="brand-mark">Q</span>
            <div><h2>初始化 Qexo</h2><p>第 ${step} 步，共 4 步 · ${steps[step - 1]}</p></div>
          </div>
          <div class="steps">${steps.map((_, i) => `<div class="step ${i < step - 1 ? "done" : ""}"></div>`).join("")}</div>
          <div id="init-body"></div>
        </div>
      </div>`;
    const body = document.getElementById("init-body");

    if (step === 1) {
      body.innerHTML = `
        <label class="field"><span>界面语言</span>
          <select id="lang">${meta.languages.map((l) => `<option value="${l.code}">${esc(l.name)}</option>`).join("")}</select>
        </label>
        <button class="btn primary" id="next">下一步</button>`;
      document.getElementById("next").onclick = async () => {
        await api("/api/init_step", { method: "POST", body: { step: "1", language: document.getElementById("lang").value } });
        step = 2;
        draw();
      };
    }

    if (step === 2) {
      body.innerHTML = `
        <label class="field"><span>管理员用户名</span><input id="u" autocomplete="username" /></label>
        <label class="field"><span>密码（至少 6 位）</span><input id="p" type="password" autocomplete="new-password" /></label>
        <label class="field"><span>确认密码</span><input id="p2" type="password" autocomplete="new-password" /></label>
        <label class="field"><span>API 密钥（可选，用于 /pub 接口）</span><input id="k" placeholder="留空自动生成" /></label>
        <button class="btn primary" id="next">创建管理员</button>`;
      document.getElementById("next").onclick = async () => {
        try {
          await api("/api/init_step", {
            method: "POST",
            body: { step: "2", username: document.getElementById("u").value, password: document.getElementById("p").value, repassword: document.getElementById("p2").value, apikey: document.getElementById("k").value },
          });
          step = 3;
          draw();
        } catch (e) { toast(e.message, "err"); }
      };
    }

    if (step === 3) {
      body.innerHTML = `
        ${providerPanel(meta.platforms, meta.providers)}
        <label class="field" style="display:flex;gap:8px;align-items:center">
          <input type="checkbox" id="force" style="width:auto" /><span style="margin:0">跳过 Hexo 结构校验</span>
        </label>
        <button class="btn primary" id="next">保存并继续</button>`;
      bindProviderPanel(meta.providers);
      document.getElementById("next").onclick = async () => {
        try {
          const cfg = collectProvider();
          if (cfg.provider === "github" && !cfg.params.repo) {
            toast("GitHub 仓库为空：请从下拉中选择或手动填写（未写入任何配置）", "err");
            return;
          }
          if (cfg.provider === "github" && !cfg.params.branch) {
            toast("项目分支为空：请先选择仓库，再从下拉中选择分支（未写入任何配置）", "err");
            return;
          }
          await api("/api/init_step", { method: "POST", body: { step: "3", provider: JSON.stringify(cfg), force: document.getElementById("force").checked ? "true" : "false" } });
          step = 4;
          draw();
        } catch (e) { toast(e.message, "err"); }
      };
    }

    if (step === 4) {
      body.innerHTML = `
        <p class="hint mb">选择内容提交后如何触发站点构建。使用 Cloudflare Pages 的 Git 集成时可留空，推送到仓库即自动构建。</p>
        <label class="field"><span>部署方式</span>
          <select id="kind">
            <option value="">不自动触发</option>
            <option value="pages">Cloudflare Pages Deploy Hook</option>
            <option value="vercel">Vercel Deploy Hook</option>
            <option value="github-actions">GitHub Actions workflow_dispatch</option>
            <option value="custom">自定义 WebHook</option>
          </select>
        </label>
        <div id="deploy-fields"></div>
        <button class="btn primary" id="next">完成初始化</button>`;
      const kind = document.getElementById("kind");
      const fields = document.getElementById("deploy-fields");
      const renderDeploy = () => {
        const v = kind.value;
        fields.innerHTML = v === "github-actions"
          ? `<div class="row"><label class="field"><span>仓库</span><input id="d-repo" placeholder="user/repo" /></label>
             <label class="field"><span>工作流文件</span><input id="d-workflow" placeholder="deploy.yml" /></label></div>
             <label class="field"><span>分支</span><input id="d-ref" value="main" /></label>
             <label class="field"><span>GitHub Token</span><input id="d-token" type="password" /></label>`
          : v
            ? `<label class="field"><span>WebHook 地址</span><input id="d-hook" placeholder="https://..." /></label>`
            : "";
      };
      kind.onchange = renderDeploy;
      renderDeploy();
      document.getElementById("next").onclick = async () => {
        try {
          await api("/api/init_step", {
            method: "POST",
            body: {
              step: "4", kind: kind.value,
              webhook: document.getElementById("d-hook")?.value || "",
              token: document.getElementById("d-token")?.value || "",
              repo: document.getElementById("d-repo")?.value || "",
              workflow: document.getElementById("d-workflow")?.value || "",
              ref: document.getElementById("d-ref")?.value || "main",
            },
          });
          await refreshMe();
          toast("初始化完成", "ok");
          location.hash = "#/dashboard";
          location.reload();
        } catch (e) { toast(e.message, "err"); }
      };
    }
  };
  draw();
}

/* ------------------------------------------------------------------ */
/* dashboard                                                          */
/* ------------------------------------------------------------------ */

async function renderDashboard({ view }) {
  setTitle("控制台", [{ text: "首页" }, { text: "控制台" }]);
  const data = await api("/api/dashboard");
  const pill = document.getElementById("provider-pill");
  pill.textContent = data.provider.repo ? `${data.provider.platform || "Git"} · ${data.provider.repo}` : "未配置内容源";
  const cards = [
    { label: "已发布文章", value: data.counts.post, icon: "posts", href: "#/posts" },
    { label: "草稿", value: data.counts.draft, icon: "pages", href: "#/posts?tab=draft" },
    { label: "独立页面", value: data.counts.page, icon: "pages", href: "#/pages" },
    { label: "图片", value: data.image_count, icon: "images", href: "#/images" },
  ];
  view.innerHTML = `
    ${
      data.default_password
        ? `<div class="card" style="border-color:rgba(245,158,11,.45);background:rgba(245,158,11,.07);margin-bottom:16px">
            <div class="flex" style="justify-content:space-between">
              <div><strong style="color:#fde68a">当前仍在使用初始密码 admin123</strong>
                <div class="hint" style="margin-top:4px">该密码是公开的默认值，任何访问者都可能登录。请立即修改。</div></div>
              <a class="btn sm" href="#/account">修改密码</a>
            </div>
          </div>`
        : ""
    }
    <div class="grid cols-4">
      ${cards.map((c) => `
        <a class="card stat" href="${c.href}" style="text-decoration:none;color:inherit">
          <div class="stat-ico">${icon(c.icon)}</div>
          <div><div class="value">${c.value ?? 0}</div><div class="label">${c.label}</div></div>
        </a>`).join("")}
    </div>

    <div class="grid cols-3 mt">
      <div class="card" style="grid-column:span 2">
        <div class="card-head"><div><h3>最近文章</h3><div class="sub">按发布时间排序</div></div>
          <a class="btn sm" href="#/posts">全部文章</a></div>
        ${data.recent?.length ? `<div class="table-wrap"><table><thead><tr><th>标题</th><th>路径</th><th>时间</th></tr></thead><tbody>
          ${data.recent.map((r) => `<tr><td><a href="#/editor?path=${encodeURIComponent(r.path)}&type=post">${esc(r.title || r.name)}</a></td>
          <td class="mono" style="color:var(--muted)">${esc(r.path)}</td><td>${fmtDate(r.date)}</td></tr>`).join("")}
        </tbody></table></div>` : `<div class="empty"><strong>还没有文章</strong><a href="#/posts">去创建第一篇</a></div>`}
      </div>
      <div class="card">
        <div class="card-head"><h3>快捷操作</h3></div>
        <div class="grid" style="gap:8px">
          <a class="btn" href="#/posts?new=1">${icon("plus")} 新建文章</a>
          <a class="btn" href="#/pages?new=1">${icon("plus")} 新建页面</a>
          <a class="btn" href="#/images">${icon("upload")} 上传图片</a>
          <a class="btn" href="#/settings/provider">${icon("settings")} 内容源设置</a>
        </div>
        <div class="hr"></div>
        <dl class="kv">
          <dt>内容源</dt><dd>${esc(data.provider.name || "未配置")}</dd>
          <dt>平台</dt><dd>${esc(data.provider.platform || "—")}</dd>
          <dt>仓库</dt><dd>${esc(data.provider.repo || "—")}</dd>
          <dt>分支</dt><dd>${esc(data.provider.branch || "—")}</dd>
          <dt>上次登录</dt><dd>${esc(data.last_login || "—")}</dd>
        </dl>
      </div>
    </div>

    <div class="grid cols-3 mt">
      <div class="card"><div class="card-head"><h3>互动</h3></div>
        <dl class="kv"><dt>友链</dt><dd>${data.friends}</dd><dt>说说</dt><dd>${data.talks}</dd><dt>通知</dt><dd>${data.notifications}</dd></dl>
      </div>
      <div class="card"><div class="card-head"><h3>访问统计</h3></div>
        <dl class="kv"><dt>站点 PV</dt><dd>${data.statistic.pv}</dd><dt>站点 UV</dt><dd>${data.statistic.uv}</dd></dl>
        <p class="hint mt">统计接口：<code>/pub/statistic</code>，需在设置中开启并配置域名白名单。</p>
      </div>
      <div class="card"><div class="card-head"><h3>运行环境</h3></div>
        <dl class="kv"><dt>运行时</dt><dd>Cloudflare Workers</dd><dt>存储</dt><dd>D1（R2 可选）</dd><dt>版本</dt><dd>${esc(state.settings?.version || "")}</dd></dl>
        <p class="hint mt">CPU 时间预算 10ms/请求，本页所有数据来自单次 D1 查询聚合。</p>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

export async function boot() {
  buildNav();
  document.getElementById("menu-toggle").onclick = () => document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("modal-close").onclick = () => (document.getElementById("modal").hidden = true);
  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") document.getElementById("modal").hidden = true;
  });
  document.getElementById("logout").onclick = async () => {
    await api("/api/logout", { method: "POST", body: {} }).catch(() => null);
    state.me = null;
    location.replace("/login");
  };

  let me;
  try {
    me = await api("/api/me");
  } catch {
    me = { init: 2, user: null };
  }

  // Page-level guard: every admin route lives under "/", so an unauthenticated
  // visitor is sent to the standalone login page and returned afterwards.
  if (!me.user) {
    const next = location.pathname + location.search + location.hash;
    location.replace(`/login?next=${encodeURIComponent(next)}`);
    return;
  }

  state.settings = me;
  state.me = me.user || null;
  state.csrf = me.csrf || "";
  state.lang = me.language || "zh_CN";
  document.getElementById("brand-name").textContent = me.site?.name || "Qexo";
  document.getElementById("version").textContent = `v${me.version || ""}`;
  document.getElementById("provider-pill").textContent = me.init >= 6 ? "已连接内容源" : "未初始化";

  document.getElementById("boot").hidden = true;
  document.getElementById("app").hidden = false;

  route("/dashboard", renderDashboard);
  route("/init", async ({ view }) => renderInit(view));

  if (me.init < 6) {
    location.hash = "#/init";
  } else if (!location.hash || location.hash === "#/login") {
    location.hash = "#/dashboard";
  }
  startRouter();
}

boot();
