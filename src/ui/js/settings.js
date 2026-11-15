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
  { id: "appearance", label: "外观" },
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
    const cfg = JSON.parse(s.raw.PROVIDER || '{"provider":"","params":{}}');
    // Switching back to the configured provider restores its saved values;
    // switching to another provider starts from a blank form.
    const params = cfg.provider === type.value ? (cfg.params || {}) : {};
    dispose();
    document.getElementById("prov-fields").innerHTML = providerFieldsHtml(meta, params);
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

const CONTENT_SOURCE_IMAGE_HOST = "GitHub 内容源";
const DEFAULT_IMAGE_DIR = "img-qexo";
const DEFAULT_CDN_PRESET = "raw";

/** Mirrors normalizeCustomPrefix() in src/images.ts: an illegal value never wins. */
function validCustomPrefix(value) {
  const v = String(value || "").trim();
  if (!v || v.length > 300 || /[\s\u0000-\u001f]/.test(v) || !/^https?:\/\//i.test(v)) return "";
  try {
    const u = new URL(v);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return "";
  } catch {
    return "";
  }
  return v.replace(/\/+$/, "");
}

function contentSourceTarget(s) {
  try {
    const cfg = JSON.parse(s.raw?.PROVIDER || s.settings?.PROVIDER || "{}");
    return { repo: cfg.params?.repo || "owner/repo", branch: cfg.params?.branch || "main" };
  } catch {
    return { repo: "owner/repo", branch: "main" };
  }
}

function contentSourceImageFields(meta, params, s) {
  const options = meta?.params?.cdn_preset?.options || [];
  const preset = params.cdn_preset || DEFAULT_CDN_PRESET;
  const dir = params.path || DEFAULT_IMAGE_DIR;
  const { repo, branch } = contentSourceTarget(s);
  return `
    <label class="field"><span>上传目录（内容源仓库根目录下）</span>
      <input data-i="path" id="img-dir" value="${esc(dir)}" placeholder="${DEFAULT_IMAGE_DIR}" />
      <small>默认 <code>${DEFAULT_IMAGE_DIR}</code>；留空保存后仍回退默认值。仓库与分支读取「设置 → 内容源」的当前配置，密钥直接复用，不在此重复填写。</small>
    </label>
    <label class="field"><span>访问前缀（公共 CDN 下拉）</span>
      <select data-i="cdn_preset" id="img-cdn-preset">
        ${options.map((o) => `<option value="${esc(o.value)}" data-template="${esc(o.template || "")}" ${o.value === preset ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
      </select>
      <small>默认 <b>GitHub 原始 raw</b>；下拉均为第三方公共服务，可用性不由本项目保证，可随时改选。</small>
    </label>
    <label class="field"><span>自定义前缀（可选，优先级最高）</span>
      <input data-i="cdn_custom" id="img-cdn-custom" value="${esc(params.cdn_custom || "")}" placeholder="https://cdn.example.com/{repo}/{branch}" />
      <small>支持占位符 <code>{repo}</code>（owner/repo）与 <code>{branch}</code>；填写合法 http(s) 前缀时覆盖下拉，留空或非法时自动回退到下拉选项。</small>
    </label>
    <div class="picker-note" id="img-cdn-preview" data-repo="${esc(repo)}" data-branch="${esc(branch)}"></div>
    <div class="picker-status" id="img-cdn-status"></div>
    <p class="hint">生效规则：自定义前缀（合法） &gt; 下拉预设 &gt; GitHub 原始 raw；上传目录（可覆盖） &gt; <code>${DEFAULT_IMAGE_DIR}</code>。</p>`;
}

function imageFieldsHtml(meta, params, s) {
  if (meta?.name !== CONTENT_SOURCE_IMAGE_HOST) return paramsFields(meta?.params, params, "i");
  return contentSourceImageFields(meta, params, s);
}

function bindImagePreview() {
  const preset = document.getElementById("img-cdn-preset");
  if (!preset) return;
  const custom = document.getElementById("img-cdn-custom");
  const dir = document.getElementById("img-dir");
  const preview = document.getElementById("img-cdn-preview");
  const status = document.getElementById("img-cdn-status");
  const update = () => {
    const repo = preview.dataset.repo || "owner/repo";
    const branch = preview.dataset.branch || "main";
    const valid = validCustomPrefix(custom.value);
    const illegal = !!custom.value.trim() && !valid;
    const template = valid || preset.selectedOptions[0]?.dataset.template || "";
    const base = template.replaceAll("{repo}", repo).replaceAll("{branch}", branch).replace(/\/+$/, "");
    const folder = (dir.value.trim() || DEFAULT_IMAGE_DIR).replace(/^\/+|\/+$/g, "");
    preview.textContent = `当前生效前缀：${base}/${folder}/…（仓库 ${repo} · 分支 ${branch}）`;
    if (illegal) {
      status.className = "picker-status err";
      status.textContent = "自定义前缀不合法，已回退到下拉选项";
    } else if (valid) {
      status.className = "picker-status ok";
      status.textContent = "自定义前缀已生效，覆盖下拉选项";
    } else {
      status.className = "picker-status";
      status.textContent = "使用下拉预设（默认 GitHub 原始 raw）";
    }
  };
  preset.addEventListener("change", update);
  custom.addEventListener("input", update);
  dir.addEventListener("input", update);
  update();
}

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
    <div id="img-fields">${imageFieldsHtml(meta, cfg.params || {}, s)}</div>
    <button class="btn primary" id="save-image">保存</button>
    <p class="hint mt">R2 为 Workers 原生方案：文件写入绑定桶，默认通过 <code>/api/images/file/*</code> 提供访问。GitHub 图床会把图片提交到仓库；S3 兼容 AWS SigV4，可用于 R2 / 阿里云 OSS / MinIO。「${CONTENT_SOURCE_IMAGE_HOST}」为独立类型：写入内容源仓库的 <code>${DEFAULT_IMAGE_DIR}</code> 目录并复用其密钥，访问前缀可用公共 CDN 下拉或自定义前缀覆盖。</p>
  </div>`;
}

function bindImageTab(s) {
  const type = document.getElementById("img-type");
  type.onchange = () => {
    const meta = s.image_hosts.find((h) => h.name === type.value);
    document.getElementById("img-fields").innerHTML = imageFieldsHtml(meta, {}, s);
    bindImagePreview();
  };
  bindImagePreview();
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

function turnstileSummary(t) {
  const sw = t.switch_on ? "开启" : "关闭";
  const cfg = t.configured ? "已满足" : `未满足（缺少 ${(t.missing || []).join("、") || "必要配置"}）`;
  const eff = t.effective ? "已生效" : "未生效";
  return `当前状态：开关 ${sw} · 前置条件 ${cfg} · 实际 ${eff}。仅当开关开启且三项环境变量齐备时，登录页才会渲染控件并强制校验。`;
}

function applyTurnstileState(t, message = "", kind = "") {
  const tagInfo = t.effective ? ["ok", "已生效"] : t.switch_on ? ["warn", "已开启 · 未生效"] : ["", "已关闭"];
  const tag = document.getElementById("ts-tag");
  const summary = document.getElementById("ts-summary");
  const status = document.getElementById("ts-status");
  if (tag) {
    tag.className = `tag ${tagInfo[0]}`.trim();
    tag.textContent = tagInfo[1];
  }
  if (summary) summary.textContent = turnstileSummary(t);
  if (status) {
    status.className = `picker-status${kind ? ` ${kind}` : ""}`;
    status.textContent = message;
  }
}

function turnstileHowtoHtml() {
  return `
    <p class="hint">Turnstile 是 Cloudflare 的人机验证组件。浏览器只生成 token，校验由本服务端调用 Siteverify 完成；Secret key 不会出现在页面中。</p>
    <div class="hr"></div>
    <p class="hint"><b>一、前置条件</b></p>
    <ol class="hint" style="line-height:1.85;padding-left:20px;margin:0">
      <li>已在 Cloudflare 创建 widget，取得 <b>Site key</b>（公开值）与 <b>Secret key</b>（私有，仅放服务端）。</li>
      <li>widget 的 Hostname Management 覆盖实际访问域名；添加根域名会自动授权其所有子域名。</li>
      <li>生产 Worker 齐备三项：<code>TURNSTILE_SITE_KEY</code>（公开，可放配置文件的 <code>[vars]</code>）、<code>TURNSTILE_SECRET</code>、<code>TURNSTILE_HOSTNAMES</code>。</li>
    </ol>
    <div class="hr"></div>
    <p class="hint"><b>二、配置命令（部署机执行，值在交互提示中输入）</b></p>
    <pre class="mono" style="background:var(--bg-2);border:1px solid var(--border-soft);border-radius:8px;padding:10px;white-space:pre-wrap;margin:0">wrangler secret put TURNSTILE_SECRET --config wrangler.prod.toml
wrangler secret put TURNSTILE_HOSTNAMES --config wrangler.prod.toml</pre>
    <ul class="hint" style="line-height:1.85;padding-left:20px;margin:8px 0 0">
      <li><code>TURNSTILE_HOSTNAMES</code> 填管理后台域名，多个用逗号分隔；<b>生产不得包含 localhost / 127.0.0.1</b>，且需与 Siteverify 返回的 hostname 完全一致。</li>
      <li><code>TURNSTILE_VERIFY_URL</code> 仅为本地测试注入点，生产保持未设置。</li>
      <li><code>wrangler secret put</code> 会自动创建新 Worker 版本，无需重新部署；改变的是配置，不是程序版本号。</li>
    </ul>
    <div class="hr"></div>
    <p class="hint"><b>三、在本页启用与验证</b></p>
    <ol class="hint" style="line-height:1.85;padding-left:20px;margin:0">
      <li>前置条件显示「已满足」后打开本页开关；切换会立即保存并即时生效，本卡片内给出反馈。</li>
      <li>强制刷新登录页确认控件出现，完成一次登录；同一 token 重放会被拒绝。</li>
      <li>关闭开关会立即恢复原有登录 / reCAPTCHA 路径，不会锁死后台。</li>
    </ol>
    <p class="hint mt">密钥请勿写入仓库或聊天。本说明为页内浮层，不会跳转或打开外部站点。</p>`;
}

function turnstileCard(s) {
  const t = s.turnstile || { switch_on: false, configured: false, effective: false, missing: [] };
  const tagCls = t.effective ? "ok" : t.switch_on ? "warn" : "";
  const tagText = t.effective ? "已生效" : t.switch_on ? "已开启 · 未生效" : "已关闭";
  return `<div class="card">
    <div class="card-head">
      <div><h3>Cloudflare Turnstile</h3><div class="sub">登录页人机验证 · 服务端校验 token</div></div>
      <span class="tag ${tagCls}" id="ts-tag">${tagText}</span>
    </div>
    <div class="field">
      <div class="field-head">
        <span>功能开关（切换后立即保存）</span>
        <span class="field-tools"><button type="button" class="link-btn" id="ts-howto">如何启用</button></span>
      </div>
      <label style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="ts-enabled" style="width:auto" ${t.switch_on ? "checked" : ""} />
        <span style="margin:0">启用 Turnstile 登录验证</span>
      </label>
      <div class="picker-note" id="ts-summary">${esc(turnstileSummary(t))}</div>
      <div class="picker-status" id="ts-status"></div>
    </div>
  </div>`;
}

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
  </div>
  ${turnstileCard(s)}`;
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

  const tsSwitch = document.getElementById("ts-enabled");
  if (tsSwitch) {
    tsSwitch.onchange = async () => {
      tsSwitch.disabled = true;
      const status = document.getElementById("ts-status");
      status.className = "picker-status loading";
      status.textContent = "正在保存…";
      try {
        const res = await api("/api/settings/turnstile", {
          method: "POST",
          body: { enabled: tsSwitch.checked ? "是" : "否" },
        });
        const t = res.turnstile;
        applyTurnstileState(t, res.msg, t.effective ? "ok" : t.switch_on ? "err" : "");
        toast(res.msg, t.effective || !t.switch_on ? "ok" : "warn");
        await loadSettings(true);
      } catch (e) {
        tsSwitch.checked = !tsSwitch.checked;
        status.className = "picker-status err";
        status.textContent = `保存失败：${e.message}`;
        toast(e.message, "err");
      } finally {
        tsSwitch.disabled = false;
      }
    };
    document.getElementById("ts-howto").onclick = () =>
      openModal({
        title: "如何启用 Turnstile",
        body: turnstileHowtoHtml(),
        buttons: [{ label: "关闭", cls: "ghost" }],
      });
  }
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
/* appearance · 面板风格切换                                           */
/* ------------------------------------------------------------------ */

let styleChangeListener = null;

function appearanceTab() {
  const lib = window.QexoStyles;
  if (!lib) {
    return `<div class="card"><div class="empty"><strong>风格库未加载</strong>请检查 /js/style-library.js 是否可访问</div></div>`;
  }
  const current = lib.current();
  const themes = lib.list();
  const defaultName = lib.get(lib.DEFAULT_ID)?.name || lib.DEFAULT_ID;
  return `
  <div class="card">
    <div class="card-head">
      <div><h3>面板风格</h3><div class="sub">共 ${themes.length} 套 · 切换即时生效，选择通过 Cookie 记住</div></div>
      <span class="tag info" id="style-current">当前：${esc(lib.get(current)?.name || current)}</span>
    </div>
    <div class="style-grid" id="style-grid" role="radiogroup" aria-label="面板风格">
      ${themes.map((s) => `
        <label class="style-card ${s.id === current ? "is-active" : ""}" data-style-id="${esc(s.id)}">
          <input class="style-input sr-only" type="radio" name="ui-style" value="${esc(s.id)}" ${s.id === current ? "checked" : ""} />
          <span class="style-swatches" aria-hidden="true">${s.swatches.map((c) => `<i style="background:${esc(c)}"></i>`).join("")}</span>
          <span class="style-info">
            <span class="style-title-row"><span class="style-name">${esc(s.name)}</span><span class="style-check" aria-hidden="true">✓</span></span>
            <span class="style-en">${esc(s.en)}</span>
            <span class="style-note">${esc(s.note)}</span>
          </span>
        </label>`).join("")}
    </div>
    <div class="style-foot mt">
      <p class="hint" id="style-hint" style="margin:0">刷新或重新访问会自动恢复上次选择；Cookie 缺失或无效时回退到默认风格「${esc(defaultName)}」。</p>
      <button class="btn sm" id="style-reset">恢复默认</button>
    </div>
  </div>
  <div class="card">
    <div class="card-head"><h3>扩展新主题</h3></div>
    <p class="hint">所有主题集中定义在 <code>/js/style-library.js</code> 的 <code>THEMES</code> 数组中；每套只需提供 16 个核心色，其余 token 由 <code>buildTokens()</code> 统一派生。新增一项即可出现在上方控件中，无需改动页面或样式表。</p>
    <p class="hint" id="style-verify"></p>
  </div>`;
}

function bindAppearanceTab() {
  const lib = window.QexoStyles;
  if (!lib) return;
  const grid = document.getElementById("style-grid");
  if (!grid) return;

  const refresh = (id) => {
    grid.querySelectorAll(".style-card").forEach((card) => {
      card.classList.toggle("is-active", card.dataset.styleId === id);
    });
    const tag = document.getElementById("style-current");
    if (tag) tag.textContent = "当前：" + (lib.get(id)?.name || id);
  };
  const persistNote = (ok) => {
    const hint = document.getElementById("style-hint");
    if (!hint) return;
    hint.textContent = ok
      ? "已保存到 Cookie，刷新或重新访问会自动恢复；Cookie 缺失或无效时回退到默认风格。"
      : "浏览器禁止写入 Cookie，本次切换仅在当前页面有效。";
  };

  grid.addEventListener("change", (e) => {
    if (!e.target || e.target.name !== "ui-style") return;
    const id = lib.apply(e.target.value);
    refresh(id);
    persistNote(lib.persisted());
    toast("已切换至 " + (lib.get(id)?.name || id), "ok");
  });

  document.getElementById("style-reset").onclick = () => {
    const id = lib.reset();
    const input = grid.querySelector(`.style-input[value="${id}"]`);
    if (input) input.checked = true;
    refresh(id);
    persistNote(lib.persisted());
    toast("已恢复默认风格", "ok");
  };

  // 允外部调用 QexoStyles.apply() 时同步控件；重渲染前先移除旧监听，避免累积。
  if (styleChangeListener) document.removeEventListener("qexo:stylechange", styleChangeListener);
  styleChangeListener = (e) => {
    const id = e.detail.id;
    const input = grid.querySelector(`.style-input[value="${id}"]`);
    if (input && !input.checked) input.checked = true;
    refresh(id);
  };
  document.addEventListener("qexo:stylechange", styleChangeListener);

  const problems = lib.verify();
  const box = document.getElementById("style-verify");
  if (box) {
    box.textContent = problems.length
      ? "配置自检发现问题：" + problems.join("；")
      : `配置自检通过：${lib.list().length} 套主题的核心色与派生 token 均完整。`;
  }
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
  } else if (tab === "appearance") {
    panel.innerHTML = appearanceTab();
    bindAppearanceTab();
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
