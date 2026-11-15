/**
 * Admin API. Endpoint names follow Qexo where practical so that existing
 * scripts and themes keep working, with a few REST-ish additions for the SPA.
 */

import {
  HttpError,
  attachment,
  b64ToUtf8,
  bytesToHuman,
  formatDate,
  json,
  nowSec,
  ok,
  fail,
  readBody,
  str,
  firstFile,
  toInt,
  type Ctx,
  type Env,
} from "./lib";
import { ContentService, excerptOf } from "./content";
import { Store, DEFAULT_SETTINGS, LANGUAGES, QEXO_VERSION, languageList, purgeAllCaches } from "./store";
import { PLATFORMS, platformNames } from "./platforms";
import { PROVIDERS, PROVIDER_PARAMS, createProvider } from "./vcs";
import { IMAGE_HOSTS, IMAGE_HOST_PARAMS, getImageHost } from "./images";
import { GithubApiError, listGithubBranches, listGithubRepos } from "./github";
import {
  authenticate,
  countUsers,
  createSession,
  createUser,
  destroySession,
  rateLimit,
  replaceUser,
  verifyRecaptcha,
  clearSessionCookie,
} from "./auth";
import { cacheDel } from "./store";
import { createMcpToken, listMcpTokens, mcpToolCatalog, revokeMcpToken } from "./mcp";
import { turnstileConfig, verifyTurnstile } from "./turnstile";

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function fmOf(v: unknown): Record<string, unknown> {
  if (!v) return {};
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v as Record<string, unknown>;
}

function mask(value: string): string {
  if (!value) return "";
  return value.length <= 8 ? "******" : value.slice(0, 4) + "******" + value.slice(-2);
}

function publicSettings(all: Record<string, string>): Record<string, string> {
  const copy: Record<string, string> = { ...all };
  delete copy[`_SESSION_SECRET`];
  copy.WEBHOOK_APIKEY = all.WEBHOOK_APIKEY ? "******" : "";
  try {
    const img = JSON.parse(all.IMG_HOST || "{}");
    if (img?.params) {
      for (const k of Object.keys(img.params)) {
        if (/secret|token|key|password/i.test(k)) img.params[k] = mask(String(img.params[k]));
      }
    }
    copy.IMG_HOST = JSON.stringify(img);
  } catch {
    /* ignore */
  }
  try {
    const prov = JSON.parse(all.PROVIDER || "{}");
    if (prov?.params) {
      for (const k of Object.keys(prov.params)) {
        if (/token|key|password|secret/i.test(k)) prov.params[k] = mask(String(prov.params[k]));
      }
    }
    copy.PROVIDER = JSON.stringify(prov);
  } catch {
    /* ignore */
  }
  return copy;
}

/**
 * Keeps stored secrets when the UI submits a masked placeholder. Only
 * credential-like keys are merged: an empty repo/branch/path must stay empty,
 * otherwise the backend would silently resurrect a value the form never sent.
 */
function mergeSecrets(next: Record<string, string>, prev: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...next };
  for (const [k, v] of Object.entries(next)) {
    if (!/token|key|password|secret/i.test(k)) continue;
    if (typeof v === "string" && (v.includes("******") || v === "")) {
      if (prev[k]) out[k] = prev[k];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* bootstrap                                                          */
/* ------------------------------------------------------------------ */

export const DEFAULT_ADMIN_USER = "admin";
export const DEFAULT_ADMIN_PASSWORD = "admin123";

/**
 * Every fresh deployment starts with admin/admin123 so the operator can log in
 * without a wizard round-trip. The flag below is surfaced in the UI until the
 * password is changed.
 */
export async function ensureBootstrapAdmin(env: Env): Promise<void> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  if ((row?.n ?? 0) > 0) return;
  const store = new Store(env);
  try {
    await createUser(env, DEFAULT_ADMIN_USER, DEFAULT_ADMIN_PASSWORD);
    await store.set("DEFAULT_ADMIN_PASSWORD", "1");
    const init = toInt(await store.get("INIT", "2"), 2);
    if (init < 4) await store.set("INIT", "4");
  } catch {
    // Concurrent bootstrap: another request won the UNIQUE(username) race.
  }
}

/* ------------------------------------------------------------------ */
/* auth                                                               */
/* ------------------------------------------------------------------ */

export async function apiAuth(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const username = str(body, "username");
  const password = str(body, "password");
  const ip = ctx.ip;

  if (!(await rateLimit(ctx.env, `login:${ip}`, 10, 600))) {
    return fail("尝试次数过多，请 10 分钟后再试", 429);
  }

  const store = new Store(ctx.env);
  if ((await countUsers(ctx.env)) === 0) {
    return json({ status: false, msg: "系统尚未初始化", need_init: true });
  }

  const kind = str(body, "type");
  const verify = str(body, "verify");
  const turnstile = turnstileConfig(ctx.env);
  const turnstileToken = str(body, "cf-turnstile-response");
  if (turnstile.enabled) {
    // Server-side gate: a client cannot bypass it by omitting `type`.
    const result = await verifyTurnstile(ctx.env, turnstileToken, ip);
    if (!result.ok) return fail("人机验证失败，请刷新页面后重试");
  } else if (kind === "v3" || kind === "v2") {
    const secret = await store.get(kind === "v3" ? "LOGIN_RECAPTCHA_SERVER_TOKEN" : "LOGIN_RECAPTCHAV2_SERVER_TOKEN");
    if (!secret) return fail("未配置人机验证，请联系管理员");
    if (!verify) return fail("未收到人机验证信息");
    const result = await verifyRecaptcha(secret, verify, kind === "v3" ? "v3" : "v2", ip);
    if (!result.ok) return fail("人机验证失败!");
  } else if (kind === "turnstile" || turnstileToken) {
    return fail("未配置人机验证，请联系管理员");
  }

  const user = await authenticate(ctx.env, username, password);
  if (!user) return fail("登录失败，用户名或密码错误");
  const { cookie } = await createSession(ctx.env, user.id, ctx.req);
  await store.set("LAST_LOGIN", formatDate(nowSec()));
  return json({ msg: "登录成功！", status: true, user }, 200, { "Set-Cookie": cookie });
}

export async function apiLogout(ctx: Ctx): Promise<Response> {
  await destroySession(ctx.env, ctx.req);
  return json({ msg: "已退出登录", status: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

export async function apiMe(ctx: Ctx): Promise<Response> {
  await ensureBootstrapAdmin(ctx.env);
  const store = new Store(ctx.env);
  const init = toInt(await store.get("INIT", "2"), 2);
  const all = await store.all();
  const ts = turnstileConfig(ctx.env);
  return json({
    status: true,
    init,
    csrf: ctx.session?.csrf || "",
    user: ctx.user,
    default_admin: all.DEFAULT_ADMIN_PASSWORD === "1",
    language: all.LANGUAGE || "zh_CN",
    languages: languageList(),
    site: { name: all.QEXO_NAME, split: all.QEXO_SPLIT, logo: all.QEXO_LOGO, icon: all.QEXO_ICON },
    platforms: platformNames(),
    providers: PROVIDERS.map((p) => ({ name: p, params: PROVIDER_PARAMS[p] })),
    image_hosts: IMAGE_HOSTS.filter((x) => x !== "关闭").map((x) => ({ name: x, params: IMAGE_HOST_PARAMS[x] || {} })),
    version: QEXO_VERSION,
    recaptcha: {
      v2: !!all.LOGIN_RECAPTCHAV2_SITE_TOKEN,
      v3: !!all.LOGIN_RECAPTCHA_SITE_TOKEN,
      v2_site: all.LOGIN_RECAPTCHAV2_SITE_TOKEN,
      v3_site: all.LOGIN_RECAPTCHA_SITE_TOKEN,
    },
    turnstile: { enabled: ts.enabled, site_key: ts.enabled ? ts.siteKey : "" },
  });
}

/* ------------------------------------------------------------------ */
/* init                                                               */
/* ------------------------------------------------------------------ */

export async function apiInitState(ctx: Ctx): Promise<Response> {
  await ensureBootstrapAdmin(ctx.env);
  const store = new Store(ctx.env);
  const init = toInt(await store.get("INIT", "2"), 2);
  return json({
    status: true,
    init,
    users: await countUsers(ctx.env),
    languages: languageList(),
    platforms: platformNames(),
    providers: PROVIDERS.map((p) => ({ name: p, params: PROVIDER_PARAMS[p] })),
  });
}

export async function apiInitStep(ctx: Ctx): Promise<Response> {
  const store = new Store(ctx.env);
  const current = toInt(await store.get("INIT", "2"), 2);
  if (current >= 6) return fail("初始化已完成，无法再次进行", 403);
  const body = await readBody(ctx.req);
  const step = str(body, "step");

  try {
    if (step === "1") {
      const lang = str(body, "language", "zh_CN");
      if (!LANGUAGES.includes(lang as any)) return fail("不支持的语言");
      await store.set("LANGUAGE", lang);
      await store.set("INIT", String(Math.max(current, 3)));
      return json({ status: true, msg: "语言设置成功", next_step: 2 });
    }

    if (step === "2") {
      const username = str(body, "username").trim();
      const password = str(body, "password");
      const repassword = str(body, "repassword");
      if (!username) return fail("用户名不能为空");
      if (password.length < 6) return fail("密码至少 6 位");
      if (password !== repassword) return fail("两次输入的密码不一致");
      if ((await countUsers(ctx.env)) > 0) return fail("管理员已存在");
      await createUser(ctx.env, username, password);
      const apiKey = str(body, "apikey") || crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const { sha256Hex } = await import("./lib");
      await store.set("WEBHOOK_APIKEY", await sha256Hex(apiKey));
      await store.set("INIT", String(Math.max(current, 4)));
      return json({ status: true, msg: "管理员创建成功", next_step: 3 });
    }

    if (step === "3") {
      const saved = await saveProvider(ctx, body, true);
      if (!saved.ok) return fail(saved.msg);
      await store.set("INIT", String(Math.max(current, 5)));
      return json({ status: true, msg: saved.msg, next_step: 4 });
    }

    if (step === "4") {
      const kind = str(body, "kind");
      if (kind) {
        await store.set("DEPLOY_KIND", kind);
        await store.set("DEPLOY_WEBHOOK", str(body, "webhook"));
        await store.set("DEPLOY_TOKEN", str(body, "token"));
        await store.set("DEPLOY_REPO", str(body, "repo"));
        await store.set("DEPLOY_WORKFLOW", str(body, "workflow"));
        await store.set("DEPLOY_REF", str(body, "ref", "main"));
      }
      await store.set("INIT", "6");
      return json({ status: true, msg: "初始化完成", next_step: 6 });
    }
    return fail("未知的初始化步骤");
  } catch (e: any) {
    return fail(e?.message || String(e));
  }
}

/* ------------------------------------------------------------------ */
/* provider                                                           */
/* ------------------------------------------------------------------ */

export async function saveProvider(
  ctx: Ctx,
  body: Record<string, unknown>,
  skipVerify: boolean,
): Promise<{ ok: boolean; msg: string }> {
  const store = new Store(ctx.env);
  const raw = body.provider;
  let cfg: any;
  if (typeof raw === "string") {
    try {
      cfg = JSON.parse(raw);
    } catch {
      return { ok: false, msg: "Provider 配置不是合法 JSON" };
    }
  } else if (raw && typeof raw === "object") {
    cfg = { ...(raw as any) };
  } else {
    cfg = { provider: str(body, "name"), params: { ...(body as any) } };
  }
  if (!cfg.provider) return { ok: false, msg: "缺少 Provider 类型" };
  if (!cfg.params) cfg.params = {};
  if (!cfg.params.config) cfg.params.config = str(body, "config", "Hexo");
  if (!PLATFORMS[cfg.params.config]) return { ok: false, msg: `未知平台: ${cfg.params.config}` };

  const prev = await store.getJSON<any>("PROVIDER", { params: {} });
  cfg.params = mergeSecrets(cfg.params, prev?.params || {});

  // The form prefills both fields from the saved config. An empty value is
  // still an explicit "not chosen" state, not a valid value and not a request
  // to keep the old one.
  if (cfg.provider === "github") {
    if (!String(cfg.params.repo || "").trim()) {
      return { ok: false, msg: "GitHub 仓库为空：请明确选择仓库后再保存，未写入任何配置" };
    }
    if (!String(cfg.params.branch || "").trim()) {
      return { ok: false, msg: "项目分支为空：请明确选择分支后再保存，未写入任何配置" };
    }
  }

  let message = "";
  if (cfg.provider === "github" && cfg.params.config === "Hexo" && !skipVerify) {
    try {
      const svc = new ContentService(ctx.env, store, cfg);
      const v = await svc.verify();
      if (v.status === -1) return { ok: false, msg: "Provider 校验失败" };
      message += v.hexo ? `Hexo 版本 ${v.hexo}；` : "未检测到 Hexo 版本；";
      if (v.indexhtml) message += "检测到 index.html，可能不是源码仓库；";
      message += v.config_hexo ? "已找到 _config.yml；" : "未找到 _config.yml；";
      message += v.theme_dir ? "已找到 themes 目录；" : "未找到 themes 目录；";
      message += v.package ? "已找到 package.json；" : "未找到 package.json；";
      message += v.source ? "已找到 source 目录；" : "未找到 source 目录；";
    } catch (e: any) {
      return { ok: false, msg: `校验失败: ${e?.message || e}` };
    }
  }

  await store.set("PROVIDER", JSON.stringify(cfg));
  await purgeAllCaches(ctx.env);
  return { ok: true, msg: message + "内容源配置已更新" };
}

export async function apiSetProvider(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const force = str(body, "force") === "true";
  const result = await saveProvider(ctx, body, force);
  return result.ok ? ok(result.msg || "保存成功") : fail(result.msg);
}

export async function apiVerifyProvider(ctx: Ctx): Promise<Response> {
  const store = new Store(ctx.env);
  try {
    const svc = await ContentService.create(ctx.env, store);
    const v = await svc.verify();
    return json({ status: true, ...v });
  } catch (e: any) {
    return fail(e?.message || String(e));
  }
}

/* ------------------------------------------------------------------ */
/* GitHub token health check (repo/branch pickers)                     */
/* ------------------------------------------------------------------ */

/**
 * The form may post a freshly typed token, the masked placeholder, or nothing
 * at all. In the latter two cases the saved provider token is used, so the
 * pickers keep working after a page reload without ever sending the secret
 * back to the browser.
 */
async function resolveGithubToken(ctx: Ctx, body: Record<string, unknown>): Promise<{ token: string; saved: boolean }> {
  const submitted = str(body, "token").trim();
  if (submitted && !submitted.includes("******")) return { token: submitted, saved: false };
  const prev = await new Store(ctx.env).getJSON<any>("PROVIDER", { params: {} });
  return { token: String(prev?.params?.token || "").trim(), saved: true };
}

/** Upstream connectivity failures stay 5xx; bad credentials/input are 4xx. */
function githubFailureStatus(e: unknown): number {
  return e instanceof GithubApiError && e.upstream >= 500 ? 502 : 400;
}

export async function apiGithubRepos(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const { token, saved } = await resolveGithubToken(ctx, body);
  if (!token) return fail("尚未保存 GitHub 密钥：请先填写密钥，再点击「检测密钥」", 400);
  try {
    const data = await listGithubRepos(token, ctx.env);
    return json({ status: true, ...data, token_source: saved ? "saved" : "input" });
  } catch (e: any) {
    return fail(e?.message || String(e), githubFailureStatus(e));
  }
}

export async function apiGithubBranches(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const { token, saved } = await resolveGithubToken(ctx, body);
  if (!token) return fail("尚未保存 GitHub 密钥：请先填写密钥并保存", 400);
  const repo = str(body, "repo").trim();
  if (!repo) return fail("请先选择或填写 GitHub 仓库", 400);
  try {
    const data = await listGithubBranches(token, repo, ctx.env);
    return json({ status: true, ...data, token_source: saved ? "saved" : "input" });
  } catch (e: any) {
    return fail(e?.message || String(e), githubFailureStatus(e));
  }
}

/* ------------------------------------------------------------------ */
/* content                                                            */
/* ------------------------------------------------------------------ */

async function content(ctx: Ctx): Promise<ContentService> {
  return ContentService.create(ctx.env, new Store(ctx.env));
}

export async function apiListPosts(ctx: Ctx): Promise<Response> {
  const svc = await content(ctx);
  const search = ctx.url.searchParams.get("s") || "";
  const posts = await svc.listPosts(search);
  return json({ status: true, data: posts, posts });
}

export async function apiRefresh(ctx: Ctx): Promise<Response> {
  const svc = await content(ctx);
  const counts = await svc.refreshIndex();
  return ok("索引已刷新", { counts });
}

export async function apiGetPost(ctx: Ctx): Promise<Response> {
  const path = ctx.url.searchParams.get("path") || "";
  if (!path) return fail("缺少 path 参数");
  const svc = await content(ctx);
  const post = await svc.readPost(path);
  return json({ status: true, ...post, path });
}

export async function apiSavePost(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const svc = await content(ctx);
  const file = str(body, "file");
  const contentText = str(body, "content");
  const fm = fmOf(body.front_matter);
  const status = str(body, "status", "true") !== "false";
  const result = await svc.savePost(file, contentText, fm, str(body, "path") || undefined, status);
  return ok(result.deployed ? "保存成功，已触发部署" : "保存成功", { path: result.path });
}

export async function apiSaveDraft(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const svc = await content(ctx);
  const result = await svc.savePost(str(body, "file"), str(body, "content"), fmOf(body.front_matter), str(body, "path") || undefined, false, false);
  return ok("草稿保存成功", { path: result.path });
}

/** Pages are written verbatim to the supplied path (Qexo: provider.save). */
export async function apiSavePage(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const path = str(body, "file");
  if (!path) return fail("缺少文件路径");
  const svc = await content(ctx);
  const result = await svc.savePage(path, str(body, "content"), fmOf(body.front_matter));
  return ok(result.deployed ? "保存成功，已触发部署" : "保存成功", { path: result.path });
}

/** Raw file write (no front matter handling), mirrors Qexo's /api/save. */
export async function apiSaveRaw(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const path = str(body, "file");
  if (!path) return fail("缺少文件路径");
  const svc = await content(ctx);
  await svc.provider.putFile(path, str(body, "content"), str(body, "commitchange", `Update ${path} by Qexo`));
  await purgeAllCaches(ctx.env);
  return ok("保存成功");
}

export async function apiPublish(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const svc = await content(ctx);
  const result = await svc.publish(str(body, "file"));
  return ok("发布成功", { path: result.path });
}

export async function apiUnpublish(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const svc = await content(ctx);
  const result = await svc.unpublish(str(body, "file"));
  return ok("转为草稿成功", { path: result.path });
}

export async function apiNewPost(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const svc = await content(ctx);
  const result = await svc.newPost(str(body, "file"));
  return ok("创建成功", { path: result.path, name: str(body, "file") });
}

export async function apiNewPage(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const svc = await content(ctx);
  const result = await svc.newPage(str(body, "file"));
  return ok("创建成功", { path: result.path });
}

export async function apiDeleteFile(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const svc = await content(ctx);
  await svc.delete(str(body, "file"));
  return ok("删除成功");
}

export async function apiRename(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const svc = await content(ctx);
  const changed = await svc.rename(str(body, "file"), str(body, "new"));
  return ok(changed ? "重命名成功" : "路径未变化");
}

export async function apiListPages(ctx: Ctx): Promise<Response> {
  const svc = await content(ctx);
  const pages = await svc.listPages(ctx.url.searchParams.get("s") || "");
  return json({ status: true, data: pages, pages });
}

export async function apiListConfigs(ctx: Ctx): Promise<Response> {
  const svc = await content(ctx);
  const configs = await svc.listConfigs(ctx.url.searchParams.get("s") || "");
  return json({ status: true, data: configs, configs });
}

export async function apiGetConfig(ctx: Ctx): Promise<Response> {
  const path = ctx.url.searchParams.get("path") || "";
  if (!path) return fail("缺少 path 参数");
  const svc = await content(ctx);
  const raw = await svc.getFileRaw(path);
  return json({ status: true, content: raw, path });
}

export async function apiSaveConfig(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const svc = await content(ctx);
  await svc.saveConfig(str(body, "file"), str(body, "content"));
  return ok("保存成功");
}

export async function apiExcerpt(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const length = toInt(body.length ?? 200, 200);
  return json({ status: true, excerpt: excerptOf(str(body, "content"), length) });
}

/* ------------------------------------------------------------------ */
/* images                                                             */
/* ------------------------------------------------------------------ */

export async function apiListImages(ctx: Ctx): Promise<Response> {
  const search = ctx.url.searchParams.get("s") || "";
  const { results } = await ctx.env.DB.prepare(
    "SELECT id, name, url, size, date, type FROM images ORDER BY date DESC LIMIT 500",
  ).all<{ id: string; name: string; url: string; size: string; date: number; type: string }>();
  const data = (results || [])
    .filter((r) => !search || r.name.toUpperCase().includes(search.toUpperCase()) || r.url.toUpperCase().includes(search.toUpperCase()))
    .map((r) => ({
      name: r.name,
      size: bytesToHuman(Number(r.size)),
      url: r.url,
      date: formatDate(Number(r.date)),
      time: String(r.date),
      id: r.id,
    }));
  return json({ status: true, data, images: data });
}

export async function apiUpload(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const file = firstFile(body);
  if (!file) return fail("没有收到上传文件");
  const store = new Store(ctx.env);
  const cfg = await store.getJSON<{ type: string; params: Record<string, string> }>("IMG_HOST", { type: "关闭", params: {} });
  const host = getImageHost(cfg.type, cfg.params || {}, ctx.env);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await host.upload(file, bytes);
  const date = nowSec();
  const id = crypto.randomUUID();
  await ctx.env.DB.prepare(
    "INSERT INTO images (id, name, url, size, date, type, delete_config) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, file.name, result.url, String(file.size), date, file.type || "", JSON.stringify(result.deleteConfig))
    .run();
  const data = {
    name: file.name,
    size: bytesToHuman(file.size),
    url: result.url,
    date: formatDate(date),
    time: String(date),
    id,
  };
  return json({ msg: "上传成功", status: true, url: result.url, data });
}

export async function apiDeleteImage(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const key = str(body, "image") || str(body, "id");
  const row = await ctx.env.DB.prepare("SELECT * FROM images WHERE date = ? OR id = ?")
    .bind(Number(key) || -1, key)
    .first<any>();
  if (!row) return fail("图片记录不存在");
  let msg = "已删除本地记录";
  if (str(body, "sync") === "true" && row.delete_config) {
    try {
      const cfg = JSON.parse(row.delete_config);
      const stored = await new Store(ctx.env).getJSON<any>("IMG_HOST", { type: "关闭", params: {} });
      const host = getImageHost(cfg.provider || stored.type, stored.params || {}, ctx.env);
      if (host.remove) msg = await host.remove(cfg);
    } catch (e: any) {
      msg = `本地记录已删除，远程删除失败: ${e?.message || e}`;
    }
  }
  await ctx.env.DB.prepare("DELETE FROM images WHERE id = ?").bind(row.id).run();
  return ok(msg);
}

export async function apiServeImage(ctx: Ctx): Promise<Response> {
  const key = ctx.params.wildcard || "";
  if (!ctx.env.R2) return new Response("R2 not configured", { status: 404 });
  const obj = await ctx.env.R2.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: obj.httpEtag,
    },
  });
}

/* ------------------------------------------------------------------ */
/* friends                                                            */
/* ------------------------------------------------------------------ */

export async function apiListFriends(ctx: Ctx): Promise<Response> {
  const search = (ctx.url.searchParams.get("s") || "").toUpperCase();
  const { results } = await ctx.env.DB.prepare(
    "SELECT id, name, url, image_url, description, time, status FROM friends ORDER BY time DESC",
  ).all<any>();
  const data = (results || [])
    .filter((r) => !search || String(r.name).toUpperCase().includes(search) || String(r.url).toUpperCase().includes(search))
    .map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      image: r.image_url,
      description: r.description,
      time: String(r.time),
      status: r.status ? "显示" : "隐藏",
    }));
  return json({ status: true, data, friends: data });
}

export async function apiAddFriend(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const time = nowSec();
  const id = crypto.randomUUID();
  await ctx.env.DB.prepare(
    "INSERT INTO friends (id, name, url, image_url, description, time, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, str(body, "name"), str(body, "url"), str(body, "image"), str(body, "description"), time, str(body, "status") === "显示" ? 1 : 0)
    .run();
  await cacheDel(ctx.env, "list:");
  return ok("添加成功！", { time: String(time), id });
}

export async function apiEditFriend(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const time = Number(str(body, "time"));
  await ctx.env.DB.prepare(
    "UPDATE friends SET name = ?, url = ?, image_url = ?, description = ?, status = ? WHERE time = ?",
  )
    .bind(str(body, "name"), str(body, "url"), str(body, "image"), str(body, "description"), str(body, "status") === "显示" ? 1 : 0, time)
    .run();
  return ok("修改成功！");
}

export async function apiDeleteFriend(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  await ctx.env.DB.prepare("DELETE FROM friends WHERE time = ?").bind(Number(str(body, "time"))).run();
  return ok("删除成功！");
}

export async function apiCleanFriends(ctx: Ctx): Promise<Response> {
  const res = await ctx.env.DB.prepare("DELETE FROM friends WHERE status = 0").run();
  const n = res.meta?.changes || 0;
  return ok(n ? `成功清理了${n}条友链` : "无隐藏的友链");
}

/* ------------------------------------------------------------------ */
/* talks                                                              */
/* ------------------------------------------------------------------ */

export async function apiListTalks(ctx: Ctx): Promise<Response> {
  const search = (ctx.url.searchParams.get("s") || "").toUpperCase();
  const { results } = await ctx.env.DB.prepare("SELECT * FROM talks ORDER BY time DESC").all<any>();
  const data = (results || [])
    .filter((r) => !search || String(r.content).toUpperCase().includes(search) || String(r.tags).toUpperCase().includes(search))
    .map((r) => ({
      id: r.id,
      content: r.content,
      tags: safeJSON(r.tags, []),
      time: r.time,
      time_text: formatDate(Number(r.time)),
      like: safeJSON(r.likes, []).length,
      values: safeJSON(r.values_, {}),
    }));
  return json({ status: true, data, talks: data });
}

export async function apiSaveTalk(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const id = str(body, "id");
  const content = str(body, "content");
  const tags = str(body, "tags", "[]");
  const values = str(body, "values", "{}");
  if (id) {
    await ctx.env.DB.prepare("UPDATE talks SET content = ?, tags = ?, time = ?, values_ = ? WHERE id = ?")
      .bind(content, tags, Number(str(body, "time")) || nowSec(), values, id)
      .run();
    return ok("修改成功！", { id });
  }
  const newId = crypto.randomUUID();
  await ctx.env.DB.prepare("INSERT INTO talks (id, content, tags, time, likes, values_) VALUES (?, ?, ?, ?, '[]', ?)")
    .bind(newId, content, tags, nowSec(), values)
    .run();
  return ok("发布成功！", { id: newId });
}

export async function apiDeleteTalk(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  await ctx.env.DB.prepare("DELETE FROM talks WHERE id = ?").bind(str(body, "id")).run();
  return ok("删除成功！");
}

function safeJSON<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* settings                                                           */
/* ------------------------------------------------------------------ */

export async function apiGetSettings(ctx: Ctx): Promise<Response> {
  const store = new Store(ctx.env);
  const all = await store.all();
  const customs = await ctx.env.DB.prepare("SELECT name, content FROM custom_fields ORDER BY name").all<any>();
  return json({
    status: true,
    settings: publicSettings(all),
    raw: all,
    custom: customs.results || [],
    languages: languageList(),
    platforms: platformNames(),
    providers: PROVIDERS.map((p) => ({ name: p, params: PROVIDER_PARAMS[p] })),
    image_hosts: IMAGE_HOSTS.filter((x) => x !== "关闭").map((x) => ({ name: x, params: IMAGE_HOST_PARAMS[x] || {} })),
    version: QEXO_VERSION,
  });
}

export async function apiSaveSettings(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const group = str(body, "group");
  const store = new Store(ctx.env);
  const values: Record<string, string> = {};

  switch (group) {
    case "basic":
      values.QEXO_NAME = str(body, "name", "博客管理面板");
      values.QEXO_SPLIT = str(body, "split", "-");
      values.QEXO_LOGO = str(body, "logo");
      values.QEXO_ICON = str(body, "icon");
      values.QEXO_LOGO_DARK = str(body, "logo_dark");
      if (body.language) values.LANGUAGE = str(body, "language");
      break;
    case "security":
      values.ALLOW_FRIEND = str(body, "allow_friend", "否");
      values.FRIEND_RECAPTCHA = str(body, "friend_recaptcha", "否");
      values.RECAPTCHA_TOKEN = str(body, "recaptcha_token");
      values.LOGIN_RECAPTCHA_SITE_TOKEN = str(body, "login_site_token");
      values.LOGIN_RECAPTCHA_SERVER_TOKEN = str(body, "login_server_token");
      values.LOGIN_RECAPTCHAV2_SITE_TOKEN = str(body, "login_site_token_v2");
      values.LOGIN_RECAPTCHAV2_SERVER_TOKEN = str(body, "login_server_token_v2");
      if (str(body, "apikey")) {
        const { sha256Hex } = await import("./lib");
        values.WEBHOOK_APIKEY = await sha256Hex(str(body, "apikey"));
      }
      break;
    case "statistic":
      values.STATISTIC_ALLOW = str(body, "allow", "否");
      values.STATISTIC_DOMAINS = str(body, "domains");
      break;
    case "abbrlink":
      values.ABBRLINK_ALG = str(body, "alg", "crc16");
      values.ABBRLINK_REP = str(body, "rep", "dec");
      break;
    case "cdn":
      values.CDN_PREV = str(body, "cdn");
      break;
    case "excerpt":
      values.AUTO_EXCERPT_CONFIG = str(body, "config", DEFAULT_SETTINGS.AUTO_EXCERPT_CONFIG);
      break;
    case "sidebar":
      if (str(body, "type") === "page") values.PAGE_SIDEBAR = str(body, "content", "[]");
      else if (str(body, "type") === "post") values.POST_SIDEBAR = str(body, "content", "[]");
      else if (str(body, "type") === "talk") values.TALK_SIDEBAR = str(body, "content", "[]");
      else return fail("未知的侧边栏类型");
      break;
    case "onepush":
      values.ONEPUSH = str(body, "onepush");
      break;
    case "deploy":
      values.DEPLOY_KIND = str(body, "kind");
      values.DEPLOY_WEBHOOK = str(body, "webhook");
      values.DEPLOY_TOKEN = str(body, "token");
      values.DEPLOY_REPO = str(body, "repo");
      values.DEPLOY_WORKFLOW = str(body, "workflow");
      values.DEPLOY_REF = str(body, "ref", "main");
      break;
    case "value":
      if (!str(body, "name")) return fail("缺少字段名");
      values[str(body, "name")] = str(body, "content");
      break;
    default:
      return fail("未知的设置分组");
  }

  await store.setMany(values);
  if (group === "basic") await purgeAllCaches(ctx.env);
  return ok("保存成功");
}

export async function apiSetImageHost(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const raw = body.image_host ?? body;
  let cfg: any;
  try {
    cfg = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return fail("图床配置不是合法 JSON");
  }
  if (!cfg?.type) return fail("缺少图床类型");
  const store = new Store(ctx.env);
  const prev = await store.getJSON<any>("IMG_HOST", { type: "关闭", params: {} });
  cfg.params = mergeSecrets(cfg.params || {}, prev?.params || {});
  await store.set("IMG_HOST", JSON.stringify(cfg));
  return ok("保存成功");
}

export async function apiSetUser(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const user = ctx.user!;
  const current = str(body, "password");
  const username = str(body, "username");
  const next = str(body, "newpassword");
  const repeat = str(body, "repassword");
  const check = await authenticate(ctx.env, user.username, current);
  if (!check) return fail("原密码错误");
  if (next !== repeat) return fail("两次输入的新密码不一致");
  if (!next) return fail("新密码不能为空");
  if (!username) return fail("用户名不能为空");
  await replaceUser(ctx.env, user.id, username, next);
  // Keep the warning if the operator sets the password back to the default.
  await new Store(ctx.env).set("DEFAULT_ADMIN_PASSWORD", next === DEFAULT_ADMIN_PASSWORD ? "1" : "0");
  return json({ msg: "保存成功，请重新登录", status: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

export async function apiCustomFields(ctx: Ctx): Promise<Response> {
  if (ctx.req.method === "GET") {
    const { results } = await ctx.env.DB.prepare("SELECT name, content FROM custom_fields ORDER BY name").all<any>();
    return json({ status: true, data: results || [] });
  }
  const body = await readBody(ctx.req);
  const name = str(body, "name");
  if (!name) return fail("缺少字段名");
  if (ctx.req.method === "DELETE") {
    await ctx.env.DB.prepare("DELETE FROM custom_fields WHERE name = ?").bind(name).run();
    return ok("删除成功！");
  }
  await ctx.env.DB.prepare(
    "INSERT INTO custom_fields (name, content, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
  )
    .bind(name, str(body, "content"), nowSec())
    .run();
  return ok("保存成功");
}

/* ------------------------------------------------------------------ */
/* notifications / webhooks / maintenance                             */
/* ------------------------------------------------------------------ */

export async function apiNotifications(ctx: Ctx): Promise<Response> {
  if (ctx.req.method === "DELETE") {
    const body = await readBody(ctx.req);
    if (str(body, "all") === "true") {
      await ctx.env.DB.prepare("DELETE FROM notifications").run();
    } else {
      await ctx.env.DB.prepare("DELETE FROM notifications WHERE id = ?").bind(str(body, "id")).run();
    }
    return ok("删除成功！");
  }
  const { results } = await ctx.env.DB.prepare(
    "SELECT id, time, label, content FROM notifications ORDER BY time DESC LIMIT 50",
  ).all<any>();
  const data = (results || []).map((r) => ({ ...r, time_text: formatDate(Number(r.time)) }));
  return json({ status: true, data });
}

export async function apiCreateNotification(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  await ctx.env.DB.prepare("INSERT INTO notifications (id, time, label, content) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), Date.now() / 1000, str(body, "title", "通知"), str(body, "content"))
    .run();
  return ok("添加成功！");
}

export async function apiCreateWebhook(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const store = new Store(ctx.env);
  const svc = await content(ctx);
  const plain = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const { sha256Hex } = await import("./lib");
  await store.set("WEBHOOK_APIKEY", await sha256Hex(plain));
  const uri = str(body, "uri");
  if (!uri) return fail("缺少回调地址");
  const url = `${uri}${uri.includes("?") ? "&" : "?"}token=${plain}`;
  try {
    await svc.provider.deleteHooks();
    await svc.provider.createHook(url, ["push"]);
    return ok("保存成功", { token: plain, webhook_url: url });
  } catch (e: any) {
    return fail(e?.message || String(e));
  }
}

export async function apiPurge(ctx: Ctx): Promise<Response> {
  await purgeAllCaches(ctx.env);
  await ctx.env.DB.prepare("DELETE FROM cache").run();
  return ok("清除所有缓存成功！");
}

export async function apiFix(ctx: Ctx): Promise<Response> {
  const store = new Store(ctx.env);
  const all = await store.all();
  let counter = 0;
  const values: Record<string, string> = {};
  for (const [name, content] of Object.entries(DEFAULT_SETTINGS)) {
    if (all[name] === undefined) {
      values[name] = content;
      counter++;
    }
  }
  if (Object.keys(values).length) await store.setMany(values);
  return ok(`成功修复 ${counter} 个配置项`);
}

export async function apiDeployLogs(ctx: Ctx): Promise<Response> {
  const { results } = await ctx.env.DB.prepare(
    "SELECT id, time, target, status, message FROM deploy_logs ORDER BY time DESC LIMIT 30",
  ).all<any>();
  return json({ status: true, data: (results || []).map((r) => ({ ...r, time_text: formatDate(Number(r.time)) })) });
}

export async function apiTestDeploy(ctx: Ctx): Promise<Response> {
  const store = new Store(ctx.env);
  const kind = await store.get("DEPLOY_KIND");
  const hook = await store.get("DEPLOY_WEBHOOK");
  if (!kind || !hook) return fail("尚未配置部署方式");
  try {
    const res = await fetch(hook, { method: "POST", body: JSON.stringify({ reason: "Qexo connection test" }) });
    return res.ok ? ok(`触发成功 (${res.status})`) : fail(`触发失败: HTTP ${res.status}`);
  } catch (e: any) {
    return fail(e?.message || String(e));
  }
}

export async function apiUpdateCheck(ctx: Ctx): Promise<Response> {
  const store = new Store(ctx.env);
  const cached = await store.get("_UPDATE_CHECK");
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (nowSec() - parsed.at < 21600) return json({ status: true, ...parsed.data });
    } catch {
      /* ignore */
    }
  }
  try {
    const res = await fetch("https://api.github.com/repos/Qexo/Qexo/releases/latest", {
      headers: { "User-Agent": "qexo-workers", Accept: "application/vnd.github+json" },
    });
    const data: any = await res.json();
    const latest = String(data?.tag_name || "").replace(/^v/, "");
    const payload = {
      current: QEXO_VERSION,
      latest,
      hasNew: !!latest && latest !== QEXO_VERSION.split("-")[0],
      url: data?.html_url || "https://github.com/Qexo/Qexo/releases",
      notes: String(data?.body || "").slice(0, 2000),
    };
    await store.set("_UPDATE_CHECK", JSON.stringify({ at: nowSec(), data: payload }));
    return json({ status: true, ...payload });
  } catch (e: any) {
    return fail(`检查更新失败: ${e?.message || e}`);
  }
}

/* ------------------------------------------------------------------ */
/* statistics                                                         */
/* ------------------------------------------------------------------ */

export async function apiStatSummary(ctx: Ctx): Promise<Response> {
  const pv = await ctx.env.DB.prepare("SELECT SUM(number) AS n FROM stat_pv").first<{ n: number }>();
  const uv = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM stat_uv").first<{ n: number }>();
  const top = await ctx.env.DB.prepare("SELECT url, number FROM stat_pv ORDER BY number DESC LIMIT 10").all<any>();
  return json({ status: true, site_pv: pv?.n || 0, site_uv: uv?.n || 0, top: top.results || [] });
}

/* ------------------------------------------------------------------ */
/* import / export                                                    */
/* ------------------------------------------------------------------ */

export async function apiExport(ctx: Ctx): Promise<Response> {
  const store = new Store(ctx.env);
  const [settings, customs, images, friends, talks, notifications, uv, pv, posts] = await Promise.all([
    ctx.env.DB.prepare("SELECT name, content FROM settings").all<any>(),
    ctx.env.DB.prepare("SELECT name, content FROM custom_fields").all<any>(),
    ctx.env.DB.prepare("SELECT * FROM images").all<any>(),
    ctx.env.DB.prepare("SELECT * FROM friends").all<any>(),
    ctx.env.DB.prepare("SELECT * FROM talks").all<any>(),
    ctx.env.DB.prepare("SELECT * FROM notifications").all<any>(),
    ctx.env.DB.prepare("SELECT * FROM stat_uv").all<any>(),
    ctx.env.DB.prepare("SELECT * FROM stat_pv").all<any>(),
    ctx.env.DB.prepare("SELECT * FROM content_index WHERE kind = 'post'").all<any>(),
  ]);
  const payload = {
    version: QEXO_VERSION,
    exported_at: new Date().toISOString(),
    settings: settings.results || [],
    custom: customs.results || [],
    images: images.results || [],
    friends: friends.results || [],
    talks: talks.results || [],
    notifications: notifications.results || [],
    uv: uv.results || [],
    pv: pv.results || [],
    posts: posts.results || [],
  };
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": attachment(`qexo-backup-${new Date().toISOString().slice(0, 10)}.json`),
      "Cache-Control": "no-store",
    },
  });
}

export async function apiImport(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const payload: any = body;
  if (!payload || typeof payload !== "object") return fail("备份内容不是合法 JSON");  let n = 0;
  const batch: D1PreparedStatement[] = [];
  for (const s of payload.settings || []) {
    if (!s?.name) continue;
    batch.push(
      ctx.env.DB.prepare(
        "INSERT INTO settings (name, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET content=excluded.content",
      ).bind(s.name, String(s.content ?? ""), nowSec()),
    );
    n++;
  }
  for (const c of payload.custom || []) {
    if (!c?.name) continue;
    batch.push(
      ctx.env.DB.prepare(
        "INSERT INTO custom_fields (name, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET content=excluded.content",
      ).bind(c.name, String(c.content ?? ""), nowSec()),
    );
    n++;
  }
  for (const f of payload.friends || []) {
    batch.push(
      ctx.env.DB.prepare(
        "INSERT OR IGNORE INTO friends (id, name, url, image_url, description, time, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(f.id || crypto.randomUUID(), f.name || "", f.url || "", f.image_url || "", f.description || "", Number(f.time) || nowSec(), Number(f.status) ? 1 : 0),
    );
    n++;
  }
  for (const t of payload.talks || []) {
    batch.push(
      ctx.env.DB.prepare("INSERT OR IGNORE INTO talks (id, content, tags, time, likes, values_) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(t.id || crypto.randomUUID(), t.content || "", t.tags || "[]", Number(t.time) || nowSec(), t.likes || "[]", t.values_ || "{}"),
    );
    n++;
  }
  if (batch.length) await ctx.env.DB.batch(batch);
  return ok(`成功导入 ${n} 条记录`);
}

/* ------------------------------------------------------------------ */
/* MCP (Model Context Protocol)                                       */
/* ------------------------------------------------------------------ */

export async function apiMcp(ctx: Ctx): Promise<Response> {
  const store = new Store(ctx.env);
  const tokens = await listMcpTokens(ctx.env);
  const origin = (ctx.env.PUBLIC_ORIGIN || new URL(ctx.req.url).origin).replace(/\/+$/, "");
  return json({
    status: true,
    enabled: (await store.get("MCP_ENABLED", "是")) === "是",
    endpoint: `${origin}/mcp`,
    protocol: "2025-06-18",
    protocols: ["2025-06-18", "2025-03-26", "2024-11-05"],
    tokens,
    tools: mcpToolCatalog(),
  });
}

export async function apiCreateMcpToken(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const name = str(body, "name", "AI Agent").slice(0, 60);
  const rawScopes = body.scopes;
  const scopes = Array.isArray(rawScopes)
    ? rawScopes.map(String)
    : String(rawScopes || "read")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  const allowed = scopes.filter((s) => s === "read" || s === "write");
  if (!allowed.length) return fail("至少选择一个权限（read / write）");
  const { token, record } = await createMcpToken(ctx.env, name, allowed);
  return json({
    status: true,
    msg: "令牌已创建，仅显示一次，请立即保存",
    token,
    record: { id: record.id, name: record.name, scopes: record.scopes, created_at: record.created_at },
  });
}

export async function apiRevokeMcpToken(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const id = str(body, "id");
  if (!id) return fail("缺少令牌 id");
  const removed = await revokeMcpToken(ctx.env, id);
  return removed ? ok("令牌已吊销，使用该令牌的客户端将立即失效") : fail("令牌不存在");
}

export async function apiToggleMcp(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const enabled = str(body, "enabled", "true") !== "false";
  await new Store(ctx.env).set("MCP_ENABLED", enabled ? "是" : "否");
  return ok(enabled ? "MCP 已启用" : "MCP 已停用");
}
