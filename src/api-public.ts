/**
 * Public API compatibility layer (/pub/*).
 *
 * Themes and third-party widgets built against Qexo call these endpoints, so
 * both the paths and the JSON envelopes are preserved.
 */

import { HttpError, json, nowSec, ok, fail, readBody, str, toInt, type Ctx, type Env } from "./lib";
import { ContentService } from "./content";
import { Store, QEXO_VERSION, cacheGet, cacheSet, purgeAllCaches } from "./store";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  "Access-Control-Max-Age": "86400",
};

function cors(data: unknown, status = 200): Response {
  return json(data, status, CORS);
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

async function requireToken(ctx: Ctx): Promise<boolean> {
  const { checkApiToken } = await import("./auth");
  return checkApiToken(ctx.env, ctx.req);
}

/* ------------------------------------------------------------------ */
/* content lists                                                      */
/* ------------------------------------------------------------------ */

export async function pubGetPosts(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  try {
    const svc = await ContentService.create(ctx.env, new Store(ctx.env));
    const posts = await svc.listPosts(ctx.url.searchParams.get("s") || "");
    return cors({ status: true, posts });
  } catch (e: any) {
    return cors({ status: false, error: String(e?.message || e) });
  }
}

export async function pubGetPages(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  try {
    const svc = await ContentService.create(ctx.env, new Store(ctx.env));
    const pages = await svc.listPages(ctx.url.searchParams.get("s") || "");
    return cors({ status: true, pages });
  } catch (e: any) {
    return cors({ status: false, error: String(e?.message || e) });
  }
}

export async function pubGetConfigs(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  try {
    const svc = await ContentService.create(ctx.env, new Store(ctx.env));
    const configs = await svc.listConfigs(ctx.url.searchParams.get("s") || "");
    return cors({ status: true, configs });
  } catch (e: any) {
    return cors({ status: false, error: String(e?.message || e) });
  }
}

export async function pubGetImages(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const { results } = await ctx.env.DB.prepare("SELECT name, url, size, date FROM images ORDER BY date DESC").all<any>();
  const images = (results || []).map((r) => ({
    name: r.name,
    size: r.size,
    url: r.url,
    date: new Date(Number(r.date) * 1000).toISOString().replace("T", " ").slice(0, 19),
    time: String(r.date),
  }));
  return cors({ status: true, images });
}

export async function pubSave(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const body = await readBody(ctx.req);
  const svc = await ContentService.create(ctx.env, new Store(ctx.env));
  const file = str(body, "file");
  await svc.provider.putFile(file, str(body, "content"), str(body, "commitchange", `Update ${file} by Qexo`));
  await purgeAllCaches(ctx.env);
  return cors({ msg: "保存成功！", status: true });
}

export async function pubDelete(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const body = await readBody(ctx.req);
  const svc = await ContentService.create(ctx.env, new Store(ctx.env));
  const file = str(body, "file");
  await svc.delete(file);
  return cors({ msg: "删除成功！", status: true });
}

export async function pubStatus(ctx: Ctx): Promise<Response> {
  try {
    const store = new Store(ctx.env);
    const cached = await cacheGet(ctx.env, "pub:status", 60);
    if (cached) return cors(JSON.parse(cached));
    const row = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM content_index WHERE kind = 'post'").first<{ n: number }>();
    let count = row?.n ?? 0;
    if (!count) {
      try {
        const svc = await ContentService.create(ctx.env, store);
        const counts = await svc.refreshIndex();
        count = counts.posts;
      } catch {
        count = 0;
      }
    }
    const payload = { data: { posts: String(count), last: await store.get("LAST_LOGIN") }, status: true };
    await cacheSet(ctx.env, "pub:status", JSON.stringify(payload));
    return cors(payload);
  } catch (e: any) {
    return cors({ msg: String(e?.message || e), status: false });
  }
}

/* ------------------------------------------------------------------ */
/* statistics                                                         */
/* ------------------------------------------------------------------ */

function domainOf(referer: string): string {
  try {
    return new URL(referer).hostname;
  } catch {
    return "";
  }
}

export async function pubStatistic(ctx: Ctx): Promise<Response> {
  try {
    const store = new Store(ctx.env);
    if ((await store.get("STATISTIC_ALLOW", "否")) !== "是") {
      return cors({ msg: "统计功能未开启", status: false }, 403);
    }
    const referer = ctx.req.headers.get("referer") || "";
    const host = domainOf(referer);
    const allow = (await store.get("STATISTIC_DOMAINS")).split(",").map((s) => s.trim()).filter(Boolean);
    if (!host || !allow.some((d) => host.includes(d))) {
      return cors({ msg: "域名未验证", status: false }, 403);
    }
    const path = referer.startsWith("http") ? new URL(referer).pathname : "/";
    const now = nowSec();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "INSERT INTO stat_pv (url, number) VALUES (?, 1) ON CONFLICT(url) DO UPDATE SET number = number + 1",
      ).bind(path),
      ctx.env.DB.prepare(
        "INSERT INTO stat_pv (url, number) VALUES (?, 1) ON CONFLICT(url) DO UPDATE SET number = number + 1",
      ).bind(host),
      ctx.env.DB.prepare("INSERT OR IGNORE INTO stat_uv (ip, first_seen) VALUES (?, ?)").bind(ctx.ip, now),
    ]);
    const page = await ctx.env.DB.prepare("SELECT number FROM stat_pv WHERE url = ?").bind(path).first<{ number: number }>();
    const site = await ctx.env.DB.prepare("SELECT number FROM stat_pv WHERE url = ?").bind(host).first<{ number: number }>();
    const uv = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM stat_uv").first<{ n: number }>();
    return cors({ site_pv: site?.number || 0, page_pv: page?.number || 0, site_uv: uv?.n || 0, status: true });
  } catch (e: any) {
    return cors({ status: false, error: String(e?.message || e) });
  }
}

/* ------------------------------------------------------------------ */
/* friends                                                            */
/* ------------------------------------------------------------------ */

export async function pubFriends(ctx: Ctx): Promise<Response> {
  const { results } = await ctx.env.DB.prepare(
    "SELECT name, url, image_url, description, time FROM friends WHERE status = 1 ORDER BY time ASC",
  ).all<any>();
  const data = (results || []).map((r) => ({
    name: r.name,
    url: r.url,
    image: r.image_url,
    description: r.description,
    time: String(r.time),
  }));
  return cors({ data, status: true });
}

export async function pubGetFriends(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const { results } = await ctx.env.DB.prepare(
    "SELECT name, url, image_url, description, time, status FROM friends ORDER BY time DESC",
  ).all<any>();
  return cors({
    data: (results || []).map((r) => ({
      name: r.name,
      url: r.url,
      image: r.image_url,
      description: r.description,
      time: String(r.time),
      status: r.status ? "显示" : "隐藏",
    })),
    status: true,
  });
}

export async function pubAskFriend(ctx: Ctx): Promise<Response> {
  const store = new Store(ctx.env);
  if ((await store.get("ALLOW_FRIEND", "否")) !== "是") return cors({ msg: "本站暂未开放友链申请", status: false });
  const { rateLimit } = await import("./auth");
  if (!(await rateLimit(ctx.env, `friend:${ctx.ip}`, 5, 3600))) return cors({ msg: "申请过于频繁，请稍后再试", status: false }, 429);
  const body = await readBody(ctx.req);
  const mode = await store.get("FRIEND_RECAPTCHA", "否");
  if (mode === "v2" || mode === "v3") {
    const token = str(body, "verify") || str(body, "recaptcha");
    const secret = await store.get("RECAPTCHA_TOKEN");
    if (!token) return cors({ msg: "未收到人机验证信息", status: false });
    const { verifyRecaptcha } = await import("./auth");
    const result = await verifyRecaptcha(secret, token, mode === "v3" ? "v3" : "v2", ctx.ip);
    if (!result.ok) return cors({ msg: "人机验证失败!", status: false });
  }
  const name = str(body, "name");
  const url = str(body, "url");
  if (!name || !url) return cors({ msg: "名称和链接不能为空", status: false });
  const time = nowSec();
  await ctx.env.DB.prepare(
    "INSERT INTO friends (id, name, url, image_url, description, time, status) VALUES (?, ?, ?, ?, ?, ?, 0)",
  )
    .bind(crypto.randomUUID(), name, url, str(body, "image"), str(body, "description"), time)
    .run();
  await ctx.env.DB.prepare("INSERT INTO notifications (id, time, label, content) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), time, "友链申请", `${name} (${url}) 申请友链：${str(body, "description")}`)
    .run();
  await notify(ctx.env, "收到新的友链申请", `${name} (${url}) 申请友链`);
  return cors({ msg: "申请成功，等待站长审核", status: true });
}

export async function pubCleanFriend(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const res = await ctx.env.DB.prepare("DELETE FROM friends WHERE status = 0").run();
  return cors({ msg: `成功清理了${res.meta?.changes || 0}条友链`, status: true });
}

/* ------------------------------------------------------------------ */
/* talks                                                              */
/* ------------------------------------------------------------------ */

export async function pubGetTalks(ctx: Ctx): Promise<Response> {
  const page = Math.max(1, toInt(ctx.url.searchParams.get("page"), 1));
  const limit = Math.min(50, Math.max(1, toInt(ctx.url.searchParams.get("limit"), 5)));
  const total = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM talks").first<{ n: number }>();
  const { results } = await ctx.env.DB.prepare("SELECT * FROM talks ORDER BY time DESC LIMIT ? OFFSET ?")
    .bind(limit, (page - 1) * limit)
    .all<any>();
  const data = (results || []).map((r) => {
    const likes = safeJSON<string[]>(r.likes, []);
    return {
      id: r.id,
      content: r.content,
      time: String(r.time),
      tags: safeJSON<string[]>(r.tags, []),
      like: likes.length,
      liked: likes.includes(ctx.ip),
      values: safeJSON(r.values_, {}),
    };
  });
  return cors({ msg: "获取成功！", status: true, count: total?.n || 0, data });
}

export async function pubLikeTalk(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req);
  const id = str(body, "id");
  const row = await ctx.env.DB.prepare("SELECT likes FROM talks WHERE id = ?").bind(id).first<{ likes: string }>();
  if (!row) return cors({ msg: "说说不存在", status: false });
  const likes = safeJSON<string[]>(row.likes, []);
  const idx = likes.indexOf(ctx.ip);
  const action = idx === -1;
  if (action) likes.push(ctx.ip);
  else likes.splice(idx, 1);
  await ctx.env.DB.prepare("UPDATE talks SET likes = ? WHERE id = ?").bind(JSON.stringify(likes), id).run();
  return cors({ msg: action ? "点赞成功！" : "取消成功！", action, status: true });
}

export async function pubSaveTalk(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const body = await readBody(ctx.req);
  const id = str(body, "id");
  if (id) {
    await ctx.env.DB.prepare("UPDATE talks SET content = ?, tags = ?, time = ?, values_ = ? WHERE id = ?")
      .bind(str(body, "content"), str(body, "tags", "[]"), Number(str(body, "time")) || nowSec(), str(body, "values", "{}"), id)
      .run();
    return cors({ msg: "修改成功！", status: true, id });
  }
  const newId = crypto.randomUUID();
  await ctx.env.DB.prepare("INSERT INTO talks (id, content, tags, time, likes, values_) VALUES (?, ?, ?, ?, '[]', ?)")
    .bind(newId, str(body, "content"), str(body, "tags", "[]"), nowSec(), str(body, "values", "{}"))
    .run();
  return cors({ msg: "发布成功！", status: true, id: newId });
}

export async function pubDelTalk(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const body = await readBody(ctx.req);
  await ctx.env.DB.prepare("DELETE FROM talks WHERE id = ?").bind(str(body, "id")).run();
  return cors({ msg: "删除成功！", status: true });
}

export async function pubAllTalks(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const search = (ctx.url.searchParams.get("s") || "").toUpperCase();
  const { results } = await ctx.env.DB.prepare("SELECT * FROM talks ORDER BY time DESC").all<any>();
  const data = (results || [])
    .filter((r) => !search || String(r.content).toUpperCase().includes(search) || String(r.tags).toUpperCase().includes(search))
    .map((r) => ({
      id: r.id,
      content: String(r.content).slice(0, 20),
      tags: safeJSON<string[]>(r.tags, []).join(", "),
      time: new Date(Number(r.time) * 1000).toISOString().replace("T", " ").slice(0, 19),
      like: safeJSON<string[]>(r.likes, []).length,
    }));
  return cors({ msg: "获取成功！", status: true, data });
}

/* ------------------------------------------------------------------ */
/* custom fields / notifications / maintenance                        */
/* ------------------------------------------------------------------ */

export async function pubGetCustom(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const { results } = await ctx.env.DB.prepare("SELECT name, content FROM custom_fields ORDER BY name").all<any>();
  return cors({ status: true, data: results || [] });
}

export async function pubSetCustom(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const body = await readBody(ctx.req);
  const name = str(body, "name");
  if (ctx.req.method === "DELETE" || ctx.url.pathname.endsWith("/del_custom")) {
    await ctx.env.DB.prepare("DELETE FROM custom_fields WHERE name = ?").bind(name).run();
    return cors({ msg: "删除成功！", status: true });
  }
  await ctx.env.DB.prepare(
    "INSERT INTO custom_fields (name, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET content=excluded.content",
  )
    .bind(name, str(body, "content"), nowSec())
    .run();
  return cors({ msg: "保存成功", status: true });
}

export async function pubNotifications(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const body = await readBody(ctx.req);
  await ctx.env.DB.prepare("INSERT INTO notifications (id, time, label, content) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), Date.now() / 1000, str(body, "title", "通知"), str(body, "content"))
    .run();
  return cors({ msg: "添加成功！", status: true });
}

export async function pubGetNotifications(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const { results } = await ctx.env.DB.prepare(
    "SELECT id, time, label, content FROM notifications ORDER BY time DESC LIMIT 50",
  ).all<any>();
  return cors({ status: true, data: results || [] });
}

export async function pubFix(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const { DEFAULT_SETTINGS } = await import("./store");
  const store = new Store(ctx.env);
  const all = await store.all();
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (all[k] === undefined) values[k] = v;
  await store.setMany(values);
  return cors({ msg: `成功修复 ${Object.keys(values).length} 个配置项`, status: true });
}

export async function pubCreateWebhook(ctx: Ctx): Promise<Response> {
  if (!(await requireToken(ctx))) return cors({ msg: "鉴权错误！", status: false });
  const body = await readBody(ctx.req);
  const svc = await ContentService.create(ctx.env, new Store(ctx.env));
  const store = new Store(ctx.env);
  const plain = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const { sha256Hex } = await import("./lib");
  await store.set("WEBHOOK_APIKEY", await sha256Hex(plain));
  const uri = str(body, "uri");
  const url = `${uri}${uri.includes("?") ? "&" : "?"}token=${plain}`;
  await svc.provider.deleteHooks();
  await svc.provider.createHook(url, ["push"]);
  return cors({ msg: "WebHook 创建成功", status: true, token: plain, webhook_url: url });
}

/* ------------------------------------------------------------------ */
/* notifications push (OnePush subset)                                */
/* ------------------------------------------------------------------ */

export async function notify(env: Env, title: string, content: string): Promise<void> {
  try {
    const store = new Store(env);
    const raw = await store.get("ONEPUSH");
    if (!raw) return;
    const cfg = JSON.parse(raw);
    const notifier = String(cfg.notifier || "").toLowerCase();
    const params = cfg.params || {};
    if (notifier === "telegram") {
      await fetch(`https://api.telegram.org/bot${params.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: params.chat_id || params.userid, text: `${title}\n${content}` }),
      });
    } else if (notifier === "serverchan" || notifier === "serverchanturbo") {
      const url = params.url || `https://sctapi.ftqq.com/${params.token}.send`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ title, desp: content }),
      });
    } else if (notifier === "bark") {
      await fetch(`${params.url || "https://api.day.app"}/${params.token}/${encodeURIComponent(title)}/${encodeURIComponent(content)}`);
    } else if (notifier === "custom" || notifier === "webhook") {
      await fetch(params.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
    }
  } catch {
    /* notification failures must never break the request */
  }
}

function safeJSON<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export { QEXO_VERSION };
