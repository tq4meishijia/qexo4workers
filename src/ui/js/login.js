/* Standalone login page: no SPA, no shell, only /api/auth + /api/me. */

const $ = (id) => document.getElementById(id);

function safeNext(raw) {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

const next = safeNext(new URLSearchParams(location.search).get("next"));

function showError(message) {
  const box = $("login-error");
  box.textContent = message;
  box.hidden = false;
}

function clearError() {
  $("login-error").hidden = true;
}

function loadRecaptcha(siteKey, version, containerId, onReady) {
  if (!siteKey) return;
  const script = document.createElement("script");
  script.src = `https://www.google.com/recaptcha/api.js?render=${
    version === "v3" ? siteKey : "explicit"
  }&hl=zh-CN`;
  script.async = true;
  script.defer = true;
  script.onload = () => {
    if (version === "v3") onReady(() => window.grecaptcha.execute(siteKey, { action: "login" }));
    else {
      const id = window.grecaptcha.render(containerId, { sitekey: siteKey });
      onReady(() => window.grecaptcha.getResponse(id));
    }
  };
  document.head.appendChild(script);
}

let getToken = () => "";
let captchaVersion = "";

async function boot() {
  let me = {};
  try {
    me = await fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json());
  } catch {
    showError("无法连接服务，请检查网络后重试");
  }

  if (me.user) {
    location.replace(next);
    return;
  }

  if (me.site?.name) document.title = `登录 · ${me.site.name}`;
  $("site-name").textContent = me.site?.name || "Qexo";
  $("version").textContent = me.version || "";
  if (me.default_admin) $("default-hint").hidden = false;

  const v3 = me.recaptcha?.v3;
  const v2 = me.recaptcha?.v2;
  if (v3 && me.recaptcha.v3_site) {
    captchaVersion = "v3";
    loadRecaptcha(me.recaptcha.v3_site, "v3", "", (fn) => (getToken = fn));
  } else if (v2 && me.recaptcha.v2_site) {
    captchaVersion = "v2";
    loadRecaptcha(me.recaptcha.v2_site, "v2", "recaptcha-v2", (fn) => (getToken = fn));
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  const btn = $("login-btn");
  btn.disabled = true;
  btn.textContent = "登录中…";

  try {
    const form = event.target;
    const payload = {
      username: form.username.value.trim(),
      password: form.password.value,
      verify: captchaVersion ? await getToken() : "",
      type: captchaVersion,
    };
    const res = await fetch("/api/auth", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== true) {
      throw new Error(data.msg || "登录失败，请检查用户名与密码");
    }
    location.replace(next);
  } catch (error) {
    showError(error.message || "登录失败");
    btn.disabled = false;
    btn.textContent = "登录";
  }
});

boot();
