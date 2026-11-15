/* ============================================================================
 * Qexo Workers · 面板风格库（唯一配置源）
 * ----------------------------------------------------------------------------
 * 本文件是**经典脚本**（非 module），必须在 <head> 中同步加载：
 *   1. 首次绘制前读取 Cookie 并注入整套 CSS 变量，避免刷新时闪默认风格；
 *   2. 所有主题集中定义在 THEMES 数组，新增主题只改这一处；
 *   3. 主题只提供 16 个核心色，其余派生 token 由纯函数 buildTokens 统一计算。
 *
 * 对外 API：window.QexoStyles
 *   list() / get(id) / current() / apply(id) / reset() / verify() / persisted()
 *   COOKIE_KEY / DEFAULT_ID
 * 事件：document 上的 "qexo:stylechange"，detail = { id, theme, persisted }
 * ========================================================================== */
(function () {
  "use strict";

  var COOKIE_KEY = "qexo_ui_style";
  var DEFAULT_ID = "midnight";
  var MAX_AGE = 60 * 60 * 24 * 365;

  /* ------------------------------------------------------------------------
   * 主题注册表 —— 新增主题只需在此追加一个对象
   *   id        稳定标识，写入 Cookie，仅允许小写字母/数字/连字符
   *   mode      light | dark，用于 color-scheme 与派生阴影
   *   c         16 个核心色（必填，6 位十六进制）
   *   radius    卡片 / 控件圆角（只影响绘制，不影响盒模型）
   *   font      head / body / mono 字体栈
   *   swatches  设置页预览用的三色
   *   overrides 可选：覆盖任意派生 token
   * ---------------------------------------------------------------------- */
  var CORE_KEYS = [
    "bg", "bg2", "panel", "panel2", "panel3", "border", "borderSoft",
    "text", "textDim", "muted", "accent", "accent2", "ok", "warn", "danger", "input"
  ];

  var SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
  var MONO = '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace';
  var SERIF = 'Georgia, "Times New Roman", "Noto Serif SC", serif';

  var THEMES = [
    {
      id: "midnight", name: "深空蓝", en: "Midnight", mode: "dark",
      note: "原版深色控制台，蓝青双强调",
      radius: ["12px", "8px"], font: [SANS, SANS, MONO], labelTransform: "uppercase",
      swatches: ["#0a0e13", "#16212d", "#3b82f6"],
      c: {
        bg: "#0a0e13", bg2: "#0e141b", panel: "#111a23", panel2: "#16212d", panel3: "#1b2836",
        border: "#22303f", borderSoft: "#1a2634", text: "#e6edf3", textDim: "#a9b8c9",
        muted: "#7d8fa5", accent: "#3b82f6", accent2: "#22d3ee", ok: "#22c55e",
        warn: "#f59e0b", danger: "#ef4444", input: "#0c1219"
      }
    },
    {
      id: "corporate", name: "企业简洁", en: "Corporate Clean", mode: "light",
      note: "浅灰蓝底、白卡细描边与克制商务蓝",
      radius: ["12px", "8px"], font: [SANS, SANS, MONO], labelTransform: "uppercase",
      swatches: ["#f8fafc", "#ffffff", "#1e40af"],
      c: {
        bg: "#f8fafc", bg2: "#f1f5f9", panel: "#ffffff", panel2: "#f1f5f9", panel3: "#e2e8f0",
        border: "#cbd5e1", borderSoft: "#e5e7eb", text: "#0f172a", textDim: "#475569",
        muted: "#94a3b8", accent: "#1e40af", accent2: "#0ea5e9", ok: "#0f7a58",
        warn: "#a16207", danger: "#b91c1c", input: "#ffffff"
      }
    },
    {
      id: "warm", name: "暖色仪表盘", en: "Warm Dashboard", mode: "light",
      note: "陶土底色、奶油白卡与柔和漫射阴影",
      radius: ["20px", "12px"], font: [SANS, SANS, MONO], labelTransform: "uppercase",
      swatches: ["#d4a088", "#faf8f5", "#3d8380"],
      c: {
        bg: "#d4a088", bg2: "#c9967a", panel: "#faf8f5", panel2: "#f2ede6", panel3: "#e8dccf",
        border: "#d9c3b3", borderSoft: "#e8d9cc", text: "#3a3330", textDim: "#6b5b53",
        muted: "#8d7a70", accent: "#3d8380", accent2: "#c17767", ok: "#3d8380",
        warn: "#9a6b25", danger: "#b05c4c", input: "#fffdf9"
      }
    },
    {
      id: "vibrancy", name: "macOS 毛玻璃", en: "macOS Vibrancy", mode: "dark",
      note: "三层深灰系统材质与衬线标题",
      radius: ["10px", "6px"], font: [SANS, SERIF, MONO], labelTransform: "uppercase",
      swatches: ["#1c1c1e", "#3a3a3c", "#0a84ff"],
      c: {
        bg: "#1c1c1e", bg2: "#242426", panel: "#2c2c2e", panel2: "#3a3a3c", panel3: "#48484a",
        border: "#48484a", borderSoft: "#333336", text: "#f5f5f7", textDim: "#a1a1a6",
        muted: "#6e6e73", accent: "#0a84ff", accent2: "#5ac8fa", ok: "#30d158",
        warn: "#ff9f0a", danger: "#ff453a", input: "#1c1c1e"
      },
      overrides: {
        "sidebar-a": "rgba(28,28,30,0.80)", "sidebar-b": "rgba(24,24,26,0.80)",
        "topbar-bg": "rgba(58,58,60,0.82)", "shadow-card": "inset 0 1px 0 rgba(255,255,255,0.06)"
      }
    },
    {
      id: "hud", name: "科幻 HUD", en: "Sci-Fi HUD", mode: "dark",
      note: "深空底、青色发光边框与等宽读数",
      radius: ["4px", "2px"],
      font: [MONO, MONO, MONO], labelTransform: "uppercase",
      swatches: ["#020617", "#0f172a", "#22d3ee"],
      c: {
        bg: "#020617", bg2: "#071026", panel: "#0f172a", panel2: "#152238", panel3: "#1e293b",
        border: "#1e3a4a", borderSoft: "#14283a", text: "#e5f2ff", textDim: "#9bb6cf",
        muted: "#6f8ba6", accent: "#22d3ee", accent2: "#06b6d4", ok: "#22c55e",
        warn: "#fbbf24", danger: "#fb7185", input: "#081426"
      },
      overrides: {
        "shadow-card": "0 0 20px rgba(6,182,212,0.18)",
        "shadow-modal": "0 0 40px rgba(6,182,212,0.28)",
        "shadow-toast": "0 0 18px rgba(6,182,212,0.22)",
        "backdrop": "rgba(2,6,23,0.78)"
      }
    },
    {
      id: "eink", name: "电子纸", en: "E-Ink", mode: "light",
      note: "暖纸白、墨色字级与直角灰阶",
      radius: ["0px", "0px"], font: [SANS, SANS, MONO], labelTransform: "none",
      swatches: ["#f5f3ea", "#e6e4da", "#20211e"],
      c: {
        bg: "#f5f3ea", bg2: "#eceadf", panel: "#faf8f1", panel2: "#e6e4da", panel3: "#dcd9cd",
        border: "#8d8f86", borderSoft: "#bab9b0", text: "#20211e", textDim: "#555750",
        muted: "#7a7b73", accent: "#20211e", accent2: "#555750", ok: "#20211e",
        warn: "#555750", danger: "#20211e", input: "#faf8f1"
      },
      overrides: {
        "shadow-card": "none", "shadow-modal": "none", "shadow-toast": "none",
        "brand-a": "#20211e", "brand-b": "#555750", "btn-primary-a": "#20211e",
        "btn-primary-b": "#3b3d38", "btn-primary-border": "#20211e",
        "btn-primary-fg": "#f5f3ea", "brand-glow": "transparent"
      }
    }
  ];

  /* ------------------------------------------------------------------------
   * 纯函数：颜色工具与 token 派生
   * ---------------------------------------------------------------------- */
  function hex2rgb(hex) {
    var h = String(hex).replace("#", "").trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgba(hex, a) {
    var v = hex2rgb(hex);
    return "rgba(" + v[0] + ", " + v[1] + ", " + v[2] + ", " + a + ")";
  }
  function mix(a, b, t) {
    var A = hex2rgb(a), B = hex2rgb(b);
    return "#" + A.map(function (v, i) {
      return Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0");
    }).join("");
  }
  function luminance(hex) {
    var v = hex2rgb(hex).map(function (n) {
      var x = n / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function contrastOn(hex) { return luminance(hex) > 0.45 ? "#0a1017" : "#ffffff"; }

  /** 由 16 个核心色派生出样式表需要的全部 token；新增主题无需改动此函数。 */
  function buildTokens(theme) {
    var c = theme.c, dark = theme.mode === "dark";
    var ink = dark ? "#ffffff" : "#000000";
    var t = {
      /* 核心 */
      "bg": c.bg, "bg-2": c.bg2, "panel": c.panel, "panel-2": c.panel2, "panel-3": c.panel3,
      "border": c.border, "border-soft": c.borderSoft, "text": c.text, "text-dim": c.textDim,
      "muted": c.muted, "accent": c.accent, "accent-2": c.accent2, "ok": c.ok,
      "warn": c.warn, "danger": c.danger, "input-bg": c.input,
      /* 排版与形状 */
      "radius": theme.radius[0], "radius-sm": theme.radius[1],
      "sans": theme.font[0], "font-head": theme.font[1], "mono": theme.font[2],
      "label-transform": theme.labelTransform || "none",
      /* 按钮规范：结构层常量，所有主题共用；--btn-radius 随主题圆角换档 */
      "btn-h": "36px", "btn-h-sm": "28px", "btn-h-icon": "36px",
      "btn-pad": "14px", "btn-pad-sm": "10px",
      "btn-gap": "8px", "btn-gap-sm": "6px", "btn-icon": "18px",
      "btn-radius": "var(--radius-sm)",
      "dur-feedback": "140ms", "dur-press": "90ms", "dur-theme": "220ms",
      "ease": "cubic-bezier(.2, .7, .3, 1)",
      /* 强调色派生 */
      "accent-soft": rgba(c.accent, 0.14), "accent-border": rgba(c.accent, 0.35),
      "focus-ring": rgba(c.accent, 0.16),
      "accent-fg": dark ? mix(c.accent, "#ffffff", 0.78) : mix(c.accent, "#000000", 0.28),
      "on-brand": contrastOn(c.accent2), "brand-a": c.accent2, "brand-b": c.accent,
      "brand-glow": rgba(c.accent2, 0.25),
      "btn-primary-a": mix(c.accent, "#ffffff", 0.10),
      "btn-primary-b": mix(c.accent, "#000000", 0.18),
      "btn-primary-border": mix(c.accent, "#000000", 0.18),
      "btn-primary-fg": contrastOn(c.accent),
      /* 状态色派生 */
      "ok-soft": rgba(c.ok, 0.10), "ok-border": rgba(c.ok, 0.35),
      "ok-fg": dark ? mix(c.ok, "#ffffff", 0.55) : mix(c.ok, "#000000", 0.20),
      "warn-soft": rgba(c.warn, 0.10), "warn-border": rgba(c.warn, 0.35),
      "warn-fg": dark ? mix(c.warn, "#ffffff", 0.55) : mix(c.warn, "#000000", 0.20),
      "danger-soft": rgba(c.danger, 0.10), "danger-border": rgba(c.danger, 0.40),
      "danger-fg": dark ? mix(c.danger, "#ffffff", 0.62) : mix(c.danger, "#000000", 0.18),
      "info-soft": rgba(c.accent2, 0.08), "info-border": rgba(c.accent2, 0.30),
      "info-fg": dark ? mix(c.accent2, "#ffffff", 0.55) : mix(c.accent2, "#000000", 0.28),
      /* 表面与分隔 */
      "border-hover": mix(c.border, c.textDim, 0.25),
      "row-hover": rgba(c.panel2, 0.55), "subtle-bg": rgba(ink, 0.02),
      "page-glow-1": mix(c.bg, c.panel2, 0.55), "page-glow-2": mix(c.bg, "#000000", 0.12),
      "sidebar-a": rgba(c.panel, 0.92), "sidebar-b": rgba(c.bg, 0.92),
      "topbar-bg": rgba(c.bg, 0.82), "backdrop": dark ? "rgba(4,8,12,0.66)" : "rgba(15,23,42,0.42)",
      "auth-a": rgba(c.panel2, 0.96), "auth-b": rgba(c.bg2, 0.96),
      "avatar-a": mix(c.accent, "#000000", 0.62), "avatar-b": mix(c.accent, "#000000", 0.78),
      "avatar-fg": dark ? mix(c.accent, "#ffffff", 0.78) : mix(c.accent, "#ffffff", 0.30),
      "editor-bg": mix(c.bg, c.panel, 0.25), "preview-bg": mix(c.bg, c.panel, 0.35),
      "preview-text": c.textDim, "code-inline-bg": mix(c.panel2, c.panel3, 0.5),
      "code-block-bg": mix(c.bg2, c.panel, 0.5), "quote-bg": rgba(c.accent, 0.06),
      "dropzone-border": mix(c.border, c.textDim, 0.20), "dropzone-bg": rgba(c.panel2, 0.35),
      "spin-track": rgba(c.text, 0.22), "spin-fg": c.text,
      /* 阴影 */
      "shadow-card": dark ? "0 10px 30px rgba(0,0,0,0.28)" : "0 8px 24px rgba(15,23,42,0.06)",
      "shadow-modal": dark ? "0 30px 90px rgba(0,0,0,0.55)" : "0 24px 64px rgba(15,23,42,0.18)",
      "shadow-toast": dark ? "0 12px 30px rgba(0,0,0,0.42)" : "0 10px 28px rgba(15,23,42,0.14)"
    };
    if (theme.overrides) Object.keys(theme.overrides).forEach(function (k) { t[k] = theme.overrides[k]; });
    return t;
  }

  /* 样式表引用的全部 token；verify() 用它检查每个主题是否完整 */
  var REQUIRED_TOKENS = [
    "bg", "bg-2", "panel", "panel-2", "panel-3", "border", "border-soft", "text", "text-dim",
    "muted", "accent", "accent-2", "ok", "warn", "danger", "input-bg", "radius", "radius-sm",
    "sans", "font-head", "mono", "label-transform",
    "btn-h", "btn-h-sm", "btn-h-icon", "btn-pad", "btn-pad-sm", "btn-gap", "btn-gap-sm",
    "btn-icon", "btn-radius", "dur-feedback", "dur-press", "dur-theme", "ease",
    "accent-soft", "accent-border", "focus-ring",
    "accent-fg", "on-brand", "brand-a", "brand-b", "brand-glow", "btn-primary-a", "btn-primary-b",
    "btn-primary-border", "btn-primary-fg", "ok-soft", "ok-border", "ok-fg", "warn-soft",
    "warn-border", "warn-fg", "danger-soft", "danger-border", "danger-fg", "info-soft",
    "info-border", "info-fg", "border-hover", "row-hover", "subtle-bg", "page-glow-1",
    "page-glow-2", "sidebar-a", "sidebar-b", "topbar-bg", "backdrop", "auth-a", "auth-b",
    "avatar-a", "avatar-b", "avatar-fg", "editor-bg", "preview-bg", "preview-text",
    "code-inline-bg", "code-block-bg", "quote-bg", "dropzone-border", "dropzone-bg",
    "spin-track", "spin-fg", "shadow-card", "shadow-modal", "shadow-toast"
  ];

  /* ------------------------------------------------------------------------
   * 注册表索引与校验
   * ---------------------------------------------------------------------- */
  var BY_ID = Object.create(null);
  THEMES.forEach(function (s) { BY_ID[s.id] = s; });

  function isKnown(id) { return typeof id === "string" && /^[a-z0-9-]{1,32}$/.test(id) && !!BY_ID[id]; }

  function verify() {
    var problems = [];
    var seen = Object.create(null);
    THEMES.forEach(function (s) {
      if (seen[s.id]) problems.push("重复 id: " + s.id);
      seen[s.id] = true;
      CORE_KEYS.forEach(function (k) {
        if (!/^#[0-9a-fA-F]{6}$/.test(s.c[k] || "")) problems.push(s.id + " 核心色无效: " + k);
      });
      var tokens = buildTokens(s);
      REQUIRED_TOKENS.forEach(function (k) {
        if (!tokens[k]) problems.push(s.id + " 缺少 token: --" + k);
      });
    });
    if (!isKnown(DEFAULT_ID)) problems.push("默认主题不存在: " + DEFAULT_ID);
    return problems;
  }

  /* ------------------------------------------------------------------------
   * Cookie 持久化（纯前端，Path=/ 全站共享，含登录页）
   * ---------------------------------------------------------------------- */
  function readCookie() {
    var parts = document.cookie ? document.cookie.split(";") : [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf(COOKIE_KEY + "=") === 0) {
        try { return decodeURIComponent(p.slice(COOKIE_KEY.length + 1)); }
        catch (e) { return ""; } // 编码损坏 → 视为无效值
      }
    }
    return null; // 不存在
  }

  function writeCookie(id) {
    try {
      var secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie = COOKIE_KEY + "=" + encodeURIComponent(id) +
        "; Path=/; Max-Age=" + MAX_AGE + "; SameSite=Lax" + secure;
      return readCookie() === id;
    } catch (e) { return false; }
  }

  function clearCookie() {
    try {
      document.cookie = COOKIE_KEY + "=; Path=/; Max-Age=0; SameSite=Lax";
    } catch (e) { /* 存储不可用时忽略 */ }
  }

  /* ------------------------------------------------------------------------
   * 应用与首屏引导
   * ---------------------------------------------------------------------- */
  var root = document.documentElement;
  var currentId = DEFAULT_ID;

  function setThemeColor(hex) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", hex);
  }

  /**
   * 应用主题。只改 <html> 的 data-style 与内联 CSS 变量，不改 DOM 结构。
   * @param {string} id 主题 id；未知值一律回退 DEFAULT_ID
   * @param {{persist?: boolean}} [opts] persist=false 用于首屏还原，不写 Cookie
   */
  function apply(id, opts) {
    opts = opts || {};
    if (!isKnown(id)) id = DEFAULT_ID;              // 无效 id 回退
    var theme = BY_ID[id];
    var tokens = buildTokens(theme);
    Object.keys(tokens).forEach(function (k) { root.style.setProperty("--" + k, tokens[k]); });
    root.setAttribute("data-style", id);
    root.style.colorScheme = theme.mode;
    setThemeColor(theme.c.bg);
    currentId = id;

    var persisted = false;
    if (opts.persist !== false) persisted = writeCookie(id);

    document.dispatchEvent(new CustomEvent("qexo:stylechange", {
      detail: { id: id, theme: theme, persisted: persisted }
    }));
    return id;
  }

  function boot() {
    var raw = readCookie();
    var id;
    if (raw === null) {
      id = DEFAULT_ID;                              // Cookie 不存在
    } else if (isKnown(raw)) {
      id = raw;                                     // 有效：恢复上次选择
    } else {
      clearCookie();                                // 无效：清掉脏值并回退
      id = DEFAULT_ID;
    }
    apply(id, { persist: false });                  // 首屏不写 Cookie，无副作用
  }

  boot();

  window.QexoStyles = {
    COOKIE_KEY: COOKIE_KEY,
    DEFAULT_ID: DEFAULT_ID,
    list: function () { return THEMES.map(function (s) { return s; }); },
    get: function (id) { return BY_ID[id] || null; },
    current: function () { return currentId; },
    apply: apply,
    reset: function () { return apply(DEFAULT_ID); },
    verify: verify,
    persisted: function () { return readCookie() === currentId; },
    readCookie: readCookie,
    clearCookie: clearCookie
  };
})();
