/* Settings views: provider, general, image host, security, analytics,
   deploy, advanced, account. */

import { api, confirmDialog, esc, icon, openModal, route, setTitle, state, toast } from "./core.js";
import { bindProviderFields, collectProviderParams, providerFieldsHtml } from "./provider-form.js";

let CACHE = null;

async function loadSettings(force = false) {
  if (CACHE && !force) return CACHE;
  const res = await api("/api/settings");
  CACHE = res;
  return res;
}

const TABS = [
  { id: "provider", label: "内容源" },
  { id: "basic", label: "基本" },
  { id: "image", label: "图床" },
  { id: "security", label: "安全" },
  { id: "statistic", label: "统计" },
  { id: "deploy", label: "部署" },
  { id: "advanced", label: "高级" },
];

function field(label, id, value, opts = {}) {
  const type = opts.type || "text";
  return `<label class="field"><span>${esc(label)}</span>
    <input id="${id}" type="${type}" value="${esc(value ?? "")}" placeholder="${esc(opts.placeholder || "")}" ${opts.readonly ? "readonly" : ""} />
    ${opts.hint ? `<small>${esc(opts.hint)}</small>` : ""}</label>`;
}

function select(label, id, options, value) {
  return `<label class="field"><span>${esc(label)}</span><select id="${id}">
    ${options.map((o) => `<option value="${esc(o.value ?? o)}" ${String(o.value ?? o) === String(value) ? "selected" : ""}>${esc(o.label ?? o)}</option>`).join("")}
  </select></label>`;
}

function paramsFields(defs, params = {}, prefix = "p") {
  if (!defs) return "";
  return Object.entries(defs).map(([k, d]) => `
    <label class="field"><span>${esc(d.description || k)}</span>
      <input data-${prefix}="${esc(k)}" value="${esc(params[k] ?? "")}" placeholder="${esc(d.placeholder || "")}" />
    </label>`).join("");
}

function collectParams(prefix = "p") {
  const out = {};
  document.querySelectorAll(`[data-${prefix}]`).forEach((el) => {
    const v = el.value.trim();
    if (v) out[el.dataset[prefix]] = v;
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* provider                                                           */
/* ------------------------------------------------------------------ */

function providerTab(s) {
  const cfg = JSON.parse(s.raw.PROVIDER || '{"provider":"","params":{}}');
  const provider = cfg.provider || "github";
  const meta = s.providers.find((p) => p.name === provider);
  return `
    <div class="card">
      <div class="card-head"><div><h3>内容源（Provider）</h3><div class="sub">决定文章读写到哪个 Git 仓库或对象存储</div></div>
        <span class="tag ${cfg.provider ? "ok" : "warn"}">${cfg.provider || "未配置"}</span></div>
      <div class="row">
        ${select("仓库类型", "prov-type", s.providers.map((p) => ({ value: p.name, label: p.name })), provider)}
        ${select("博客平台", "prov-platform", s.platforms, cfg.params?.config || "Hexo")}
      </div>
      <div id="prov-fields">${providerFieldsHtml(meta, cfg.params || {})}</div>
      <label class="field" style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="force" style="width:auto" /><span style="margin:0">跳过 Hexo 结构校验</span>
      </label>
      <div class="flex">
        <button class="btn primary" id="save-provider">保存内容源</button>
        <button class="btn" id="verify-provider">校验当前配置</button>
      </div>
      <div id="prov-msg" class="hint mt"></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Hexo 仓库要求</h3></div>
      <dl class="kv">
        <dt>必备文件</dt><dd><code>_config.yml</code>、<code>package.json</code>、<code>source/</code>、<code>themes/</code></dd>
        <dt>不应包含</dt><dd><code>index.html</code>（说明指向了构建产物而非源码）</dd>
        <dt>Token 权限</dt><dd>Contents: Read &amp; write（必需）、Metadata: Read（自动附带）；Webhooks / Actions 仅在启用对应功能时添加</dd>
        <dt>路径</dt><dd>若博客位于仓库子目录，在「博客路径」中填写，例如 <code>blog</code></dd>
      </dl>
    </div>`;
}

function providerEmptyError(type, params) {
  if (type !== "github") return "";
  if (!params.repo) return "GitHub 仓库为空：请从下拉中选择或手动填写后再保存（未写入任何配置）";
  if (!params.branch) return "项目分支为空：请从下拉中选择或手动填写后再保存（未写入任何配置）";
  return "";
}

function bindProviderTab(s) {
  const type = document.getElementById("prov-type");
  let dispose = bindProviderFields(s.providers.find((p) => p.name === type.value));
  type.onchange = () => {
    const meta = s.providers.find((p) => p.name === type.value);
    dispose();
    document.getElementById("prov-fields").innerHTML = providerFieldsHtml(meta, {});
    dispose = bindProviderFields(meta);
  };
  document.getElementById("save-provider").onclick = async () => {
    const params = { config: document.getElementById("prov-platform").value, ...collectProviderParams() };
    const empty = providerEmptyError(type.value, params);
    if (empty) {
      toast(empty, "err");
      document.getElementById("prov-msg").textContent = empty;
      return;
    }
    const cfg = { provider: type.value, params };
    try {
      const res = await api("/api/settings/provider", {
        method: "POST",
        body: { provider: JSON.stringify(cfg), force: document.getElementById("force").checked ? "true" : "false" },
      });
      document.getElementById("prov-msg").textContent = res.msg || "";
      toast("保存成功", "ok");
      await loadSettings(true);
    } catch (e) {
      toast(e.message, "err");
      document.getElementById("prov-msg").textContent = e.message;
    }
  };
  document.getElementById("verify-provider").onclick = async () => {
    const empty = providerEmptyError(type.value, collectProviderParams());
    if (empty) {
      const msg = "表单中仓库/分支为空，未执行校验；请先明确选择后再点「校验当前配置」";
      toast(msg, "warn");
      document.getElementById("prov-msg").textContent = msg;
      return;
    }
    try {
      const res = await api("/api/settings/verify_provider", { method: "POST", body: {} });
      document.getElementById("prov-msg").textContent = JSON.stringify(res, null, 2);
      toast(res.status === 1 ? "校验通过" : "校验未通过", res.status === 1 ? "ok" : "warn");
    } catch (e) {
      toast(e.message, "err");
    }
  };
}

/* ------------------------------------------------------------------ */
/* basic                                                              */
/* ------------------------------------------------------------------ */

function basicTab(s) {
  const v = s.settings;
  return `<div class="card">
    <div class="card-head"><h3>站点信息</h3></div>
    <div class="row">
      ${field("站点名称", "b-name", v.QEXO_NAME)}
      ${field("分隔符", "b-split", v.QEXO_SPLIT)}
    </div>
    <div class="row">
      ${field("Logo 地址", "b-logo", v.QEXO_LOGO)}
      ${field("暗色 Logo", "b-logo-dark", v.QEXO_LOGO_DARK)}
    </div>
    <div class="row">
      ${field("站点图标", "b-icon", v.QEXO_ICON)}
      ${select("界面语言", "b-lang", s.languages.map((l) => ({ value: l.code, label: l.name })), v.LANGUAGE)}
    </div>
    <button class="btn primary" id="save-basic">保存</button>
  </div>
  <div class="card">
    <div class="card-head"><h3>当前状态</h3></div>
    <dl class="kv">
      <dt>版本</dt><dd>${esc(s.version)}</dd>
      <dt>初始化</dt><dd>${esc(s.raw.INIT)} / 6</dd>
      <dt>静态资源前缀</dt><dd class="mono">${esc(v.CDN_PREV)}</dd>
    </dl>
  </div>`;
}

function bindBasicTab() {
  document.getElementById("save-basic").onclick = async () => {
    try {
      await api("/api/settings", {
        method: "POST",
        body: {
          group: "basic",
          name: document.getElementById("b-name").value,
          split: document.getElementById("b-split").value,
          logo: document.getElementById("b-logo").value,
          logo_dark: document.getElementById("b-logo-dark").value,
          icon: document.getElementById("b-icon").value,
          language: document.getElementById("b-lang").value,
        },
      });
      toast("保存成功", "ok");
      await loadSettings(true);
    } catch (e) {
      toast(e.message, "err");
    }
  };
}

/* ------------------------------------------------------------------ */
/* image host                                                         */
/* ------------------------------------------------------------------ */

function imageTab(s) {
  let cfg = { type: "关闭", params: {} };
  try {
    cfg = JSON.parse(s.settings.IMG_HOST || "{}");
  } catch {
    /* ignore */
  }
  const meta = s.image_hosts.find((h) => h.name === cfg.type);
  return `<div class="card">
    <div class="card-head"><div><h3>图床</h3><div class="sub">上传接口：<code>/api/upload</code>，记录保存在 D1</div></div></div>
    ${select("图床类型", "img-type", [{ value: "关闭", label: "关闭" }, ...s.image_hosts.map((h) => ({ value: h.name, label: h.name }))], cfg.type)}
    <div id="img-fields">${paramsFields(meta?.params, cfg.params || {}, "i")}</div>
    <button class="btn primary" id="save-image">保存</button>
    <p class="hint mt">R2 为 Workers 原生方案：文件写入绑定桶，默认通过 <code>/api/images/file/*</code> 提供访问。GitHub 图床会把图片提交到仓库；S3 兼容 AWS SigV4，可用于 R2 / 阿里云 OSS / MinIO。</p>
  </div>`;
}

function bindImageTab(s) {
  const type = document.getElementById("img-type");
  type.onchange = () => {
    const meta = s.image_hosts.find((h) => h.name === type.value);
    document.getElementById("img-fields").innerHTML = paramsFields(meta?.params, {}, "i");
  };
  document.getElementById("save-image").onclick = async () => {
    try {
      await api("/api/settings/image_host", {
        method: "POST",
        body: { image_host: JSON.stringify({ type: type.value, params: collectParams("i") }) },
      });
      toast("保存成功", "ok");
      await loadSettings(true);
    } catch (e) {
      toast(e.message, "err");
    }
  };
}

/* ------------------------------------------------------------------ */
/* security                                                           */
/* ------------------------------------------------------------------ */

function securityTab(s) {
  const v = s.settings;
  return `<div class="card">
    <div class="card-head"><h3>登录与接口安全</h3></div>
    <div class="row">
      ${select("允许友链申请", "sec-allow", [{ value: "是", label: "是" }, { value: "否", label: "否" }], v.ALLOW_FRIEND)}
      ${select("友链验证码", "sec-friend-captcha", [{ value: "关闭", label: "关闭" }, { value: "v2", label: "reCAPTCHA v2" }, { value: "v3", label: "reCAPTCHA v3" }], v.FRIEND_RECAPTCHA)}
    </div>
    ${field("友链 reCAPTCHA 密钥", "sec-friend-token", v.RECAPTCHA_TOKEN)}
    <div class="hr"></div>
    <div class="row">
      ${field("登录 reCAPTCHA v3 站点密钥", "sec-v3-site", v.LOGIN_RECAPTCHA_SITE_TOKEN)}
      ${field("登录 reCAPTCHA v3 服务端密钥", "sec-v3-server", v.LOGIN_RECAPTCHA_SERVER_TOKEN, { type: "password" })}
    </div>
    <div class="row">
      ${field("登录 reCAPTCHA v2 站点密钥", "sec-v2-site", v.LOGIN_RECAPTCHAV2_SITE_TOKEN)}
      ${field("登录 reCAPTCHA v2 服务端密钥", "sec-v2-server", v.LOGIN_RECAPTCHAV2_SERVER_TOKEN, { type: "password" })}
    </div>
    <div class="hr"></div>
    ${field("API 密钥（/pub 接口 token）", "sec-apikey", "", {
      type: "password",
      hint: "已设置时显示为空；留空保持不变。密钥仅以 SHA-256 存储，无法回显。",
    })}
    <button class="btn primary" id="save-security">保存</button>
  </div>`;
}

function bindSecurityTab() {
  document.getElementById("save-security").onclick = async () => {
    try {
      await api("/api/settings", {
        method: "POST",
        body: {
          group: "security",
          allow_friend: document.getElementById("sec-allow").value,
          friend_recaptcha: document.getElementById("sec-friend-captcha").value,
          recaptcha_token: document.getElementById("sec-friend-token").value,
          login_site_token: document.getElementById("sec-v3-site").value,
          login_server_token: document.getElementById("sec-v3-server").value,
          login_site_token_v2: document.getElementById("sec-v2-site").value,
          login_server_token_v2: document.getElementById("sec-v2-server").value,
          apikey: document.getElementById("sec-apikey").value,
        },
      });
      toast("保存成功", "ok");
      await loadSettings(true);
    } catch (e) {
      toast(e.message, "err");
    }
  };
}

/* ------------------------------------------------------------------ */
/* statistics                                                         */
/* ------------------------------------------------------------------ */

function statisticTab(s) {
  const v = s.settings;
  return `<div class="card">
    <div class="card-head"><h3>访问统计</h3></div>
    <div class="row">
      ${select("开启统计", "st-allow", [{ value: "是", label: "是" }, { value: "否", label: "否" }], v.STATISTIC_ALLOW)}
      ${field("允许的域名（逗号分隔）", "st-domains", v.STATISTIC_DOMAINS, { placeholder: "blog.example.com,www.example.com" })}
    </div>
    <button class="btn primary" id="save-stat">保存</button>
    <p class="hint mt">主题侧调用 <code>GET /pub/statistic</code>，通过 Referer 校验域名；返回 <code>site_pv / page_pv / site_uv</code>。</p>
    <div class="hr"></div>
    <div id="stat-summary" class="hint">加载中…</div>
  </div>`;
}

function bindStatisticTab() {
  document.getElementById("save-stat").onclick = async () => {
    try {
      await api("/api/settings", {
        method: "POST",
        body: {
          group: "statistic",
          allow: document.getElementById("st-allow").value,
          domains: document.getElementById("st-domains").value,
        },
      });
      toast("保存成功", "ok");
      await loadSettings(true);
    } catch (e) {
      toast(e.message, "err");
    }
  };
  api("/api/statistic/summary").then((res) => {
    const el = document.getElementById("stat-summary");
    if (!el) return;
    el.innerHTML = `<div class="grid cols-3"><div><div class="value" style="font-size:20px">${res.site_pv}</div><div class="label">站点 PV</div></div>
      <div><div class="value" style="font-size:20px">${res.site_uv}</div><div class="label">站点 UV</div></div>
      <div><div class="value" style="font-size:20px">${res.top?.length || 0}</div><div class="label">已记录页面</div></div></div>`;
  });
}

/* ------------------------------------------------------------------ */
/* deploy                                                             */
/* ------------------------------------------------------------------ */

function deployTab(s) {
  const v = s.settings;
  return `<div class="card">
    <div class="card-head"><div><h3>自动部署</h3><div class="sub">保存内容后触发站点重新构建</div></div></div>
    ${select("部署方式", "dp-kind", [
      { value: "", label: "不自动触发（依赖 Git 集成）" },
      { value: "pages", label: "Cloudflare Pages Deploy Hook" },
      { value: "vercel", label: "Vercel Deploy Hook" },
      { value: "github-actions", label: "GitHub Actions workflow_dispatch" },
      { value: "custom", label: "自定义 WebHook" },
    ], v.DEPLOY_KIND)}
    ${field("Deploy Hook / WebHook 地址", "dp-hook", v.DEPLOY_WEBHOOK, { placeholder: "https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/..." })}
    <div class="row">
      ${field("仓库（Actions 模式）", "dp-repo", v.DEPLOY_REPO, { placeholder: "user/blog" })}
      ${field("工作流文件", "dp-workflow", v.DEPLOY_WORKFLOW, { placeholder: "deploy.yml" })}
    </div>
    <div class="row">
      ${field("分支", "dp-ref", v.DEPLOY_REF, { placeholder: "main" })}
      ${field("GitHub Token（Actions 模式）", "dp-token", "", { type: "password", hint: "留空保持不变" })}
    </div>
    <div class="flex"><button class="btn primary" id="save-deploy">保存</button>
      <button class="btn" id="test-deploy">测试触发</button></div>
    <p class="hint mt">使用 Cloudflare Pages 的 Git 集成时，推送到 GitHub 即自动构建，无需 Deploy Hook；Hook 适合解耦构建与部署。</p>
  </div>
  <div class="card">
    <div class="card-head"><h3>最近触发记录</h3></div>
    <div id="deploy-logs" class="hint">加载中…</div>
  </div>`;
}

function bindDeployTab() {
  document.getElementById("save-deploy").onclick = async () => {
    try {
      await api("/api/settings", {
        method: "POST",
        body: {
          group: "deploy",
          kind: document.getElementById("dp-kind").value,
          webhook: document.getElementById("dp-hook").value,
          repo: document.getElementById("dp-repo").value,
          workflow: document.getElementById("dp-workflow").value,
          ref: document.getElementById("dp-ref").value,
          token: document.getElementById("dp-token").value,
        },
      });
      toast("保存成功", "ok");
      await loadSettings(true);
    } catch (e) {
      toast(e.message, "err");
    }
  };
  document.getElementById("test-deploy").onclick = async () => {
    try {
      const res = await api("/api/deploy/test", { method: "POST", body: {} });
      toast(res.msg || "已触发", "ok");
    } catch (e) {
      toast(e.message, "err");
    }
  };
  api("/api/deploy/logs").then((res) => {
    const el = document.getElementById("deploy-logs");
    if (!el) return;
    el.innerHTML = res.data?.length
      ? `<table><tbody>${res.data.map((l) => `<tr><td>${esc(l.time_text)}</td><td>${esc(l.target)}</td>
          <td>${l.status ? '<span class="tag ok">成功</span>' : '<span class="tag err">失败</span>'}</td>
          <td class="hint">${esc(l.message)}</td></tr>`).join("")}</tbody></table>`
      : "暂无记录";
  });
}

/* ------------------------------------------------------------------ */
/* advanced                                                           */
/* ------------------------------------------------------------------ */

function advancedTab(s) {
  const v = s.settings;
  const customs = s.custom || [];
  return `
  <div class="grid cols-2">
    <div class="card">
      <div class="card-head"><h3>短链接 / 摘要</h3></div>
      <div class="row">
        ${select("abbrlink 算法", "ad-alg", [{ value: "crc16", label: "CRC16" }, { value: "crc32", label: "CRC32" }], v.ABBRLINK_ALG)}
        ${select("输出格式", "ad-rep", [{ value: "dec", label: "十进制" }, { value: "hex", label: "十六进制" }], v.ABBRLINK_REP)}
      </div>
      ${field("自动摘要配置（JSON）", "ad-excerpt", v.AUTO_EXCERPT_CONFIG)}
      <button class="btn primary sm" id="save-adv1">保存</button>
    </div>
    <div class="card">
      <div class="card-head"><h3>静态资源 CDN</h3></div>
      ${field("CDN 前缀", "ad-cdn", v.CDN_PREV, { hint: "支持 {version} 占位符" })}
      <button class="btn primary sm" id="save-adv2">保存</button>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>文章 / 页面侧边栏</h3></div>
    <div class="row">
      <label class="field"><span>文章侧边栏（JSON 数组）</span><textarea id="ad-post-side" rows="4" class="mono">${esc(v.POST_SIDEBAR)}</textarea></label>
      <label class="field"><span>页面侧边栏（JSON 数组）</span><textarea id="ad-page-side" rows="4" class="mono">${esc(v.PAGE_SIDEBAR)}</textarea></label>
    </div>
    <button class="btn primary sm" id="save-side">保存侧边栏</button>
  </div>

  <div class="card">
    <div class="card-head"><div><h3>消息推送（OnePush）</h3><div class="sub">支持 telegram / serverchan / bark / custom</div></div></div>
    <label class="field"><span>配置 JSON</span><textarea id="ad-onepush" rows="3" class="mono">${esc(v.ONEPUSH)}</textarea></label>
    <div class="flex"><button class="btn primary sm" id="save-onepush">保存</button>
      <button class="btn sm" id="test-onepush">发送测试消息</button></div>
  </div>

  <div class="card">
    <div class="card-head"><div><h3>自定义字段</h3><div class="sub">供主题通过 <code>/pub/get_custom</code> 读取</div></div>
      <button class="btn sm" id="add-custom">${icon("plus")} 新增字段</button></div>
    ${customs.length ? `<div class="table-wrap"><table><thead><tr><th>字段名</th><th>内容</th><th style="text-align:right">操作</th></tr></thead>
      <tbody>${customs.map((c) => `<tr><td class="mono">${esc(c.name)}</td><td>${esc(String(c.content).slice(0, 80))}</td>
      <td class="actions"><button class="btn sm" data-edit-custom="${esc(c.name)}">编辑</button>
      <button class="btn sm danger" data-del-custom="${esc(c.name)}">删除</button></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty"><strong>暂无自定义字段</strong>例如 ICP 备案号、站点公告</div>`}
  </div>

  <div class="card">
    <div class="card-head"><h3>备份与维护</h3></div>
    <div class="flex">
      <a class="btn" href="/api/export">下载 JSON 备份</a>
      <button class="btn" id="import-btn">导入备份</button>
      <button class="btn" id="purge">清除缓存</button>
      <button class="btn" id="fix">自动修复配置</button>
      <button class="btn" id="check-update">检查更新</button>
    </div>
    <div class="hr"></div>
    <div class="grid cols-2">
      <label class="field"><span>原始配置（JSON，谨慎编辑）</span>
        <textarea id="raw-settings" rows="10" class="mono">${esc(JSON.stringify(s.raw, null, 2))}</textarea></label>
      <div>
        <p class="hint">直接编辑左侧 JSON 可批量修改底层 settings 表。保存后立即生效。</p>
        <button class="btn primary sm" id="save-raw">保存原始配置</button>
        <div id="update-result" class="hint mt"></div>
      </div>
    </div>
  </div>`;
}

function bindAdvancedTab(s) {
  const save = async (group, body) => {
    try {
      await api("/api/settings", { method: "POST", body: { group, ...body } });
      toast("保存成功", "ok");
      await loadSettings(true);
    } catch (e) {
      toast(e.message, "err");
    }
  };
  document.getElementById("save-adv1").onclick = () =>
    save("abbrlink", { alg: document.getElementById("ad-alg").value, rep: document.getElementById("ad-rep").value });
  document.getElementById("ad-excerpt").addEventListener("change", () =>
    save("excerpt", { config: document.getElementById("ad-excerpt").value }),
  );
  document.getElementById("save-adv2").onclick = () => save("cdn", { cdn: document.getElementById("ad-cdn").value });
  document.getElementById("save-side").onclick = async () => {
    try {
      await api("/api/settings", { method: "POST", body: { group: "sidebar", type: "post", content: document.getElementById("ad-post-side").value } });
      await api("/api/settings", { method: "POST", body: { group: "sidebar", type: "page", content: document.getElementById("ad-page-side").value } });
      toast("保存成功", "ok");
    } catch (e) {
      toast(e.message, "err");
    }
  };
  document.getElementById("save-onepush").onclick = () =>
    save("onepush", { onepush: document.getElementById("ad-onepush").value });
  document.getElementById("test-onepush").onclick = async () => {
    try {
      const res = await api("/api/test_onepush", { method: "POST", body: { onepush: document.getElementById("ad-onepush").value } });
      toast(res.msg || "已发送", "ok");
    } catch (e) {
      toast(e.message, "err");
    }
  };

  document.getElementById("add-custom").onclick = () =>
    openModal({
      title: "新增自定义字段",
      body: `<label class="field"><span>字段名</span><input id="c-name" placeholder="ICP" /></label>
             <label class="field"><span>内容</span><textarea id="c-content" rows="4"></textarea></label>`,
      buttons: [
        { label: "取消", cls: "ghost" },
        {
          label: "保存",
          cls: "primary",
          onClick: async () => {
            try {
              await api("/api/custom", { method: "POST", body: { name: document.getElementById("c-name").value, content: document.getElementById("c-content").value } });
              toast("保存成功", "ok");
              await loadSettings(true);
              routeSettingsRefresh();
            } catch (e) {
              toast(e.message, "err");
              return false;
            }
          },
        },
      ],
    });
  document.querySelectorAll("[data-edit-custom]").forEach((btn) => {
    btn.onclick = () => {
      const item = (s.custom || []).find((c) => c.name === btn.dataset.editCustom);
      openModal({
        title: `编辑 ${item.name}`,
        body: `<label class="field"><span>内容</span><textarea id="c-content" rows="5">${esc(item.content)}</textarea></label>`,
        buttons: [
          { label: "取消", cls: "ghost" },
          {
            label: "保存",
            cls: "primary",
            onClick: async () => {
              await api("/api/custom", { method: "POST", body: { name: item.name, content: document.getElementById("c-content").value } });
              toast("保存成功", "ok");
              await loadSettings(true);
              routeSettingsRefresh();
            },
          },
        ],
      });
    };
  });
  document.querySelectorAll("[data-del-custom]").forEach((btn) => {
    btn.onclick = async () => {
      if (!(await confirmDialog(`确定删除字段 ${btn.dataset.delCustom} 吗？`))) return;
      await api("/api/custom", { method: "DELETE", body: { name: btn.dataset.delCustom } });
      toast("删除成功", "ok");
      await loadSettings(true);
      routeSettingsRefresh();
    };
  });

  document.getElementById("import-btn").onclick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const res = await api("/api/import", { method: "POST", body: data });
        toast(res.msg || "导入完成", "ok");
        await loadSettings(true);
      } catch (e) {
        toast(e.message, "err");
      }
    };
    input.click();
  };
  document.getElementById("purge").onclick = async () => {
    if (!(await confirmDialog("确定清除所有缓存吗？"))) return;
    await api("/api/purge", { method: "POST", body: {} });
    toast("缓存已清除", "ok");
  };
  document.getElementById("fix").onclick = async () => {
    const res = await api("/api/fix", { method: "POST", body: {} });
    toast(res.msg, "ok");
    await loadSettings(true);
  };
  document.getElementById("check-update").onclick = async () => {
    const box = document.getElementById("update-result");
    try {
      const res = await api("/api/update/check");
      box.innerHTML = res.hasNew
        ? `发现上游新版本 <strong>${esc(res.latest)}</strong>（当前 ${esc(res.current)}）· <a href="${esc(res.url)}" target="_blank">查看</a>`
        : `已是最新版本（当前 ${esc(res.current)}，上游 ${esc(res.latest || "unknown")}）`;
    } catch (e) {
      box.textContent = e.message;
    }
  };
  document.getElementById("save-raw").onclick = async () => {
    try {
      const parsed = JSON.parse(document.getElementById("raw-settings").value);
      const settings = Object.entries(parsed).map(([name, content]) => ({ name, content: String(content) }));
      await api("/api/import", { method: "POST", body: { settings } });
      toast("保存成功", "ok");
      await loadSettings(true);
    } catch (e) {
      toast(e.message, "err");
    }
  };
}

function routeSettingsRefresh() {
  const tab = (location.hash.split("/")[2] || "basic").split("?")[0];
  location.hash = `#/settings/${tab}`;
  setTimeout(() => window.dispatchEvent(new HashChangeEvent("hashchange")), 10);
}

/* ------------------------------------------------------------------ */
/* account                                                            */
/* ------------------------------------------------------------------ */

async function renderAccount({ view }) {
  setTitle("账户", [{ text: "系统" }, { text: "账户" }]);
  view.innerHTML = `
    <div class="card" style="max-width:640px">
      <div class="card-head"><h3>账号与密码</h3></div>
      <label class="field"><span>用户名</span><input id="a-user" value="${esc(state.me?.username || "")}" /></label>
      <label class="field"><span>当前密码</span><input id="a-current" type="password" autocomplete="current-password" /></label>
      <div class="row">
        <label class="field"><span>新密码</span><input id="a-new" type="password" autocomplete="new-password" /></label>
        <label class="field"><span>确认新密码</span><input id="a-repeat" type="password" autocomplete="new-password" /></label>
      </div>
      <button class="btn primary" id="save-account">保存并重新登录</button>
      <p class="hint mt">修改后会注销所有会话。密码使用 PBKDF2-SHA256（100,000 次迭代）存储。</p>
    </div>
    <div class="card" style="max-width:640px">
      <div class="card-head"><h3>安全建议</h3></div>
      <ul class="hint" style="line-height:1.9;padding-left:18px">
        <li>GitHub Token 使用 fine-grained 权限，仅授权内容仓库。</li>
        <li>开启 reCAPTCHA 可降低暴力破解风险。</li>
        <li>生产环境建议通过 <code>wrangler secret put SESSION_SECRET</code> 固定会话密钥。</li>
      </ul>
    </div>`;
  document.getElementById("save-account").onclick = async () => {
    try {
      await api("/api/settings/user", {
        method: "POST",
        body: {
          username: document.getElementById("a-user").value,
          password: document.getElementById("a-current").value,
          newpassword: document.getElementById("a-new").value,
          repassword: document.getElementById("a-repeat").value,
        },
      });
      toast("已保存，请重新登录", "ok");
      location.hash = "#/login";
      location.reload();
    } catch (e) {
      toast(e.message, "err");
    }
  };
}

/* ------------------------------------------------------------------ */
/* router                                                             */
/* ------------------------------------------------------------------ */

async function renderSettings({ view, parts }) {
  const tab = parts[1] || "basic";
  setTitle("设置", [{ text: "系统" }, { text: "设置" }]);
  const s = await loadSettings(true);
  view.innerHTML = `
    <div class="tabs">${TABS.map((x) => `<a class="tab ${x.id === tab ? "active" : ""}" href="#/settings/${x.id}">${x.label}</a>`).join("")}</div>
    <div id="panel"></div>`;
  const panel = document.getElementById("panel");
  if (tab === "provider") {
    panel.innerHTML = providerTab(s);
    bindProviderTab(s);
  } else if (tab === "basic") {
    panel.innerHTML = basicTab(s);
    bindBasicTab();
  } else if (tab === "image") {
    panel.innerHTML = imageTab(s);
    bindImageTab(s);
  } else if (tab === "security") {
    panel.innerHTML = securityTab(s);
    bindSecurityTab();
  } else if (tab === "statistic") {
    panel.innerHTML = statisticTab(s);
    bindStatisticTab();
  } else if (tab === "deploy") {
    panel.innerHTML = deployTab(s);
    bindDeployTab();
  } else {
    panel.innerHTML = advancedTab(s);
    bindAdvancedTab(s);
  }
}

route("/settings", renderSettings);
route("/account", renderAccount);
route("/tools", renderSettings);
