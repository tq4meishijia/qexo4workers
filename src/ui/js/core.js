/* Core: state, API client, router, UI primitives, markdown preview. */

export const state = {
  me: null,
  csrf: "",
  settings: null,
  lang: "zh_CN",
};

/* ---------------- i18n (UI chrome) ---------------- */

const STRINGS = {
  zh_CN: {
    dashboard: "控制台", posts: "文章", pages: "页面", configs: "配置", images: "图床",
    friends: "友链", talks: "说说", settings: "设置", tools: "工具", account: "账户",
    logout: "退出登录", search: "搜索", save: "保存", cancel: "取消", confirm: "确定",
    delete: "删除", edit: "编辑", create: "新建", upload: "上传", refresh: "刷新",
    title: "标题", content: "内容", date: "日期", tags: "标签", categories: "分类",
    status: "状态", published: "已发布", draft: "草稿", all: "全部", name: "名称",
    url: "链接", description: "描述", preview: "预览", markdown: "Markdown",
    empty: "暂无数据", loading: "加载中…", copied: "已复制", copy: "复制",
    published_at: "发布于", updated_at: "更新于", path: "路径", size: "大小",
    new_post: "新建文章", new_page: "新建页面", save_draft: "保存草稿", publish: "发布",
    unpublish: "转为草稿", rename: "重命名", back: "返回", basic: "基本",
    security: "安全", statistic: "统计", deploy: "部署", advanced: "高级",
    image_host: "图床", provider: "内容源", account_security: "账号与密码",
    friends_manage: "友链管理", talks_manage: "说说管理", config_files: "配置文件",
    dashboard_hint: "管理你的静态博客内容、配置与发布流程",
  },
  en_US: {
    dashboard: "Dashboard", posts: "Posts", pages: "Pages", configs: "Configs", images: "Images",
    friends: "Friends", talks: "Talks", settings: "Settings", tools: "Tools", account: "Account",
    logout: "Sign out", search: "Search", save: "Save", cancel: "Cancel", confirm: "Confirm",
    delete: "Delete", edit: "Edit", create: "New", upload: "Upload", refresh: "Refresh",
    title: "Title", content: "Content", date: "Date", tags: "Tags", categories: "Categories",
    status: "Status", published: "Published", draft: "Draft", all: "All", name: "Name",
    url: "URL", description: "Description", preview: "Preview", markdown: "Markdown",
    empty: "Nothing here yet", loading: "Loading…", copied: "Copied", copy: "Copy",
    published_at: "Published", updated_at: "Updated", path: "Path", size: "Size",
    new_post: "New post", new_page: "New page", save_draft: "Save draft", publish: "Publish",
    unpublish: "Unpublish", rename: "Rename", back: "Back", basic: "General",
    security: "Security", statistic: "Analytics", deploy: "Deploy", advanced: "Advanced",
    image_host: "Image host", provider: "Content source", account_security: "Account",
    friends_manage: "Friend links", talks_manage: "Talks", config_files: "Config files",
    dashboard_hint: "Manage content, configuration and deploys for your static blog",
  },
};

export function t(key) {
  const pack = STRINGS[state.lang] || STRINGS.zh_CN;
  return pack[key] || STRINGS.zh_CN[key] || key;
}

/* ---------------- utils ---------------- */

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function fmtDate(v) {
  if (!v) return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Filters already-rendered rows in place. Avoids re-rendering the toolbar,
 * which would steal focus from the search box on every keystroke.
 */
export function filterRows(selector, query) {
  const q = (query || "").trim().toLowerCase();
  document.querySelectorAll(selector).forEach((el) => {
    el.style.display = !q || (el.textContent || "").toLowerCase().includes(q) ? "" : "none";
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("copied"), "ok");
  } catch {
    toast("复制失败，请手动选择文本", "err");
  }
}

/* ---------------- 交互反馈：按钮加载态 / 列表状态 ---------------- */

/**
 * 按钮加载态：禁用 + 旋转指示器 + aria-busy，可选替换文案（如「保存中…」）。
 * 与文章列表行内反馈共用 .btn.is-loading 样式；恢复时还原原始内容。
 */
export function btnBusy(btn, busy, label = "") {
  if (!btn) return;
  if (busy) {
    if (btn.disabled) return; // 已在处理中，忽略重复置忙
    btn.dataset.busyHtml = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<span class="spin" aria-hidden="true"></span>${esc(label || "处理中…")}`;
  } else {
    btn.disabled = false;
    btn.classList.remove("is-loading");
    btn.removeAttribute("aria-busy");
    if (btn.dataset.busyHtml !== undefined) {
      btn.innerHTML = btn.dataset.busyHtml;
      delete btn.dataset.busyHtml;
    }
  }
}

/** 包装一次异步动作：置忙 → 执行 → 恢复；错误交给调用方原有的 toast 路径。 */
export async function runBusy(btn, fn, label = "") {
  btnBusy(btn, true, label);
  try {
    return await fn();
  } finally {
    btnBusy(btn, false);
  }
}

/** 列表容器的统一状态片段：加载中 / 加载失败；空态文案仍由各页面自定义。 */
export const listStateHtml = {
  loading: (text = "加载中…") =>
    `<div class="empty is-loading"><span class="spin" aria-hidden="true"></span><span>${esc(text)}</span></div>`,
  error: (msg) =>
    `<div class="empty"><strong>加载失败</strong><p>${esc(msg || "请稍后重试")}</p></div>`,
};

/* ---------------- API ---------------- */

export async function api(path, options = {}) {
  const opts = { method: options.method || "GET", headers: {}, credentials: "same-origin" };
  if (state.csrf) opts.headers["X-CSRF-Token"] = state.csrf;
  if (options.body instanceof FormData) {
    opts.body = options.body;
  } else if (options.body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, opts);
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json().catch(() => ({})) : await res.text();
  if (res.status === 401) {
    state.me = null;
    if (!location.pathname.startsWith("/login")) {
      const next = location.pathname + location.search + location.hash;
      location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
    throw new Error((data && data.msg) || "未登录");
  }
  if (data && typeof data === "object" && data.status === false && data.msg) {
    const err = new Error(data.msg);
    err.payload = data;
    throw err;
  }
  return data;
}

export async function refreshMe() {
  const me = await api("/api/me");
  state.me = me.user || null;
  state.csrf = me.csrf || "";
  state.lang = me.language || "zh_CN";
  state.settings = me;
  return me;
}

/* ---------------- toast / modal ---------------- */

export function toast(message, kind = "", ms = 3200) {
  const root = document.getElementById("toasts");
  if (!root) return;
  // 相同文案在存活期内只保留一条，并限制并存数量，避免连续操作后
  // 提示区堆叠旧消息、干扰对当前操作结果的判断。
  for (const node of [...root.children]) {
    if (node.textContent === message) node.remove();
  }
  while (root.children.length >= 4) root.firstElementChild.remove();
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .2s";
    setTimeout(() => el.remove(), 220);
  }, ms);
}

let modalResolver = null;

export function openModal({ title = "提示", body = "", buttons = [{ label: "关闭", cls: "ghost" }] }) {
  const root = document.getElementById("modal");
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = body;
  const foot = document.getElementById("modal-foot");
  foot.innerHTML = "";
  buttons.forEach((b) => {
    const btn = document.createElement("button");
    btn.className = `btn ${b.cls || ""}`;
    btn.textContent = b.label;
    btn.onclick = async () => {
      // 提交进行中直接忽略：disabled 只挡住真实点击，程序派发的
      // dispatchEvent 仍会进入本回调，需在 JS 层再次拦截防重复提交。
      if (btn.disabled) return;
      // 弹窗动作提交期间锁定全部按钮：防重复提交，被点按钮进入加载态。
      const footBtns = [...foot.querySelectorAll("button")];
      footBtns.forEach((x) => (x.disabled = true));
      const prevHtml = btn.innerHTML;
      btn.classList.add("is-loading");
      btn.setAttribute("aria-busy", "true");
      btn.innerHTML = `<span class="spin" aria-hidden="true"></span>${esc(b.label)}`;
      try {
        if (b.onClick) {
          const keep = await b.onClick();
          if (keep === false) return;
        }
        closeModal();
      } catch (e) {
        // 回调未自行处理的异常在此统一反馈：弹窗保持打开，可直接重试。
        toast(e?.message || String(e), "err");
      } finally {
        btn.innerHTML = prevHtml;
        btn.classList.remove("is-loading");
        btn.removeAttribute("aria-busy");
        // 弹窗已关闭（foot 将随下次打开重建）时无需恢复；仍打开则解除锁定。
        if (root.hidden === false) footBtns.forEach((x) => (x.disabled = false));
      }
    };
    foot.appendChild(btn);
  });
  root.hidden = false;
  return new Promise((resolve) => (modalResolver = resolve));
}

export function closeModal() {
  const root = document.getElementById("modal");
  if (!root || root.hidden) return;
  root.hidden = true;
  if (modalResolver) modalResolver(true);
  modalResolver = null;
}

export function confirmDialog(message, { danger = true, okText = "确定" } = {}) {
  return new Promise((resolve) => {
    openModal({
      title: "请确认",
      body: `<p style="color:var(--text-dim);line-height:1.7">${esc(message)}</p>`,
      buttons: [
        { label: "取消", cls: "ghost", onClick: () => resolve(false) },
        {
          label: okText,
          cls: danger ? "danger" : "primary",
          onClick: () => resolve(true),
        },
      ],
    });
    const root = document.getElementById("modal");
    const obs = new MutationObserver(() => {
      if (root.hidden) {
        obs.disconnect();
        resolve(false);
      }
    });
    obs.observe(root, { attributes: true, attributeFilter: ["hidden"] });
  });
}

/* ---------------- icons ---------------- */

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  posts: '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h6"/>',
  pages: '<path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/>',
  configs: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  images: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-7 9"/>',
  friends: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M15 20c0-2.5 1.6-4.6 4-5.3"/>',
  talks: '<path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a9 9 0 0 1 9-9 9 9 0 0 1 9 9z"/><path d="M8 11h8M8 15h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
  tools: '<path d="M14.7 6.3a4 4 0 0 1-5 5L4 17v3h3l5.7-5.7a4 4 0 0 1 5-5L21 6l-2-2-4.3 2.3z"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
  logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>',
  plug: '<path d="M9 3v6M15 3v6"/><path d="M6 9h12v3a6 6 0 0 1-12 0z"/><path d="M12 18v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

export function icon(name) {
  return `<span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.dashboard}</svg></span>`;
}

/* ---------------- markdown preview ---------------- */

function inline(src) {
  let s = src;
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => `<img alt="${alt}" src="${url}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, text, url) => `<a href="${url}" target="_blank" rel="noopener">${text}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s;
}

export function renderMarkdown(input) {
  const src = String(input || "")
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "");
  const blocks = [];
  let text = src.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code class="lang-${esc(lang)}">${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  const lines = text.split("\n");
  const out = [];
  let listType = null;
  let inQuote = false;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      out.push("</blockquote>");
      inQuote = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\u0000BLOCK\d+\u0000$/.test(line.trim())) {
      closeList(); closeQuote();
      out.push(line.trim());
      continue;
    }
    if (!line.trim()) {
      closeList(); closeQuote();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList(); closeQuote();
      out.push(`<h${h[1].length}>${inline(esc(h[2]))}</h${h[1].length}>`);
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      closeList(); closeQuote();
      out.push("<hr>");
      continue;
    }
    if (/^>\s?/.test(line)) {
      if (!inQuote) {
        out.push("<blockquote>");
        inQuote = true;
      }
      out.push(`<p>${inline(esc(line.replace(/^>\s?/, "")))}</p>`);
      continue;
    }
    closeQuote();
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const type = ul ? "ul" : "ol";
      if (listType !== type) {
        closeList();
        out.push(`<${type}>`);
        listType = type;
      }
      out.push(`<li>${inline(esc((ul || ol)[1]))}</li>`);
      continue;
    }
    if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1])) {
      closeList();
      const headers = line.split("|").slice(1, -1).map((s) => s.trim());
      i++;
      const rows = [];
      while (i + 1 < lines.length && /^\|.*\|$/.test(lines[i + 1])) {
        i++;
        rows.push(lines[i].split("|").slice(1, -1).map((s) => s.trim()));
      }
      out.push("<table><thead><tr>" + headers.map((x) => `<th>${inline(esc(x))}</th>`).join("") + "</tr></thead><tbody>");
      for (const r of rows) out.push("<tr>" + r.map((x) => `<td>${inline(esc(x))}</td>`).join("") + "</tr>");
      out.push("</tbody></table>");
      continue;
    }
    closeList();
    out.push(`<p>${inline(esc(line))}</p>`);
  }
  closeList(); closeQuote();
  let html = out.join("\n");
  html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (_, n) => blocks[Number(n)]);
  return html;
}

/* ---------------- router ---------------- */

const routes = new Map();
let current = "";
let renderToken = 0;

export function route(path, render) {
  routes.set(path, render);
}

export function navigate(path) {
  if (location.hash === `#${path}`) renderRoute();
  else location.hash = `#${path}`;
}

export async function renderRoute() {
  // 任何成功的路由切换都应关闭遗留弹窗，避免遮罩继续拦截页面交互。
  closeModal();
  const token = ++renderToken;
  const raw = location.hash.replace(/^#/, "") || "/dashboard";
  const [path, queryString] = raw.split("?");
  const query = new URLSearchParams(queryString || "");
  const parts = path.split("/").filter(Boolean);
  const base = "/" + (parts[0] || "dashboard");
  const render = routes.get(base);
  const view = document.getElementById("view");
  current = path;
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("href") === `#${base}` || (base === "/settings" && el.getAttribute("href") === "#/settings"));
  });
  document.getElementById("sidebar").classList.remove("open");
  if (!render) {
    view.innerHTML = `<div class="card"><div class="empty"><strong>页面不存在</strong><a href="#/dashboard">返回控制台</a></div></div>`;
    return;
  }
  try {
    await render({ view, parts, query, path });
  } catch (err) {
    // A stale render (user already navigated away) must not clobber the view.
    if (token !== renderToken) return;
    view.innerHTML = `<div class="card"><div class="empty"><strong>加载失败</strong><p>${esc(err.message || err)}</p></div></div>`;
  }
  document.getElementById("avatar").textContent = (state.me?.username || "A").slice(0, 1).toUpperCase();
}

export function startRouter() {
  window.addEventListener("hashchange", renderRoute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
  renderRoute();
}

export function setTitle(title, crumbs = []) {
  document.getElementById("page-title").textContent = title;
  document.getElementById("crumbs").innerHTML = crumbs.map((c) => (c.href ? `<a href="${c.href}">${esc(c.text)}</a>` : esc(c.text))).join(" / ");
}
