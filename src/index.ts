/**
 * Worker entry point: middleware, routing table, legacy Qexo aliases.
 */

import {
  HttpError,
  Router,
  fail,
  getCookie,
  json,
  ok,
  readBody,
  str,
  type Ctx,
  type Handler,
} from "./lib";
import { assertCsrf, checkApiToken, resolveSession, requireStaff } from "./auth";
import { ContentService } from "./content";
import { Store, purgeAllCaches } from "./store";
import * as app from "./api-app";
import * as pub from "./api-public";
import { handleMcp } from "./mcp";

const router = new Router();

/* ------------------------------------------------------------------ */
/* page guards (standalone login + protected admin shell)              */
/* ------------------------------------------------------------------ */

function redirectTo(ctx: Ctx, path: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: new URL(path, ctx.url).toString(), "Cache-Control": "no-store" },
  });
}

/** Only same-origin absolute paths are accepted as post-login targets. */
function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

const serveApp: Handler = async (ctx) => {
  const resolved = await resolveSession(ctx.env, ctx.req);
  if (!resolved) return redirectTo(ctx, `/login?next=${encodeURIComponent("/")}`);
  return ctx.env.ASSETS.fetch(new URL("/index.html", ctx.url).toString());
};

const serveLogin: Handler = async (ctx) => {
  const resolved = await resolveSession(ctx.env, ctx.req);
  if (resolved) return redirectTo(ctx, safeNext(ctx.url.searchParams.get("next")));
  return ctx.env.ASSETS.fetch(new URL("/login.html", ctx.url).toString());
};

router.get("/", serveApp);
router.get("/index.html", serveApp);
router.get("/login", serveLogin);
router.get("/login.html", serveLogin);

/* ------------------------------------------------------------------ */
/* MCP endpoint (own bearer auth, stateless Streamable HTTP)           */
/* ------------------------------------------------------------------ */

router.post("/mcp", handleMcp);
router.get("/mcp", handleMcp);
router.del("/mcp", handleMcp);
router.add("OPTIONS", "/mcp", handleMcp);

/* ------------------------------------------------------------------ */
/* middleware                                                         */
/* ------------------------------------------------------------------ */

const authed =
  (handler: Handler): Handler =>
  async (ctx) => {
    if (!ctx.user) return json({ status: false, msg: "未登录", need_login: true }, 401);
    assertCsrf(ctx);
    return handler(ctx);
  };

const staff =
  (handler: Handler): Handler =>
  async (ctx) => {
    if (!ctx.user) return json({ status: false, msg: "未登录", need_login: true }, 401);
    assertCsrf(ctx);
    await requireStaff(ctx);
    return handler(ctx);
  };

const token =
  (handler: Handler): Handler =>
  async (ctx) => {
    if (!(await checkApiToken(ctx.env, ctx.req))) return json({ status: false, msg: "鉴权错误！" });
    return handler(ctx);
  };

/* ------------------------------------------------------------------ */
/* auth & init                                                        */
/* ------------------------------------------------------------------ */

router.post("/api/auth", app.apiAuth);
router.post("/api/logout", app.apiLogout);
router.get("/api/me", app.apiMe);
router.get("/api/init/state", app.apiInitState);
router.post("/api/init_step", app.apiInitStep);
router.post("/api/init/step", app.apiInitStep);

/* ------------------------------------------------------------------ */
/* dashboard                                                          */
/* ------------------------------------------------------------------ */

router.get(
  "/api/dashboard",
  authed(async (ctx) => {
    const store = new Store(ctx.env);
    const svc = await ContentService.create(ctx.env, store).catch(() => null);
    let counts = svc ? await svc.counts() : { post: 0, draft: 0, page: 0, config: 0 };
    // Fresh database: build the index once so the dashboard is not empty until
    // the user opens the post list.
    if (svc && counts.post + counts.draft + counts.page + counts.config === 0) {
      try {
        const fresh = await svc.refreshIndex();
        counts = { post: fresh.posts, draft: fresh.drafts, page: fresh.pages, config: fresh.configs };
      } catch {
        /* provider unreachable: keep the zeros */
      }
    }
    const recent = await ctx.env.DB.prepare(
      "SELECT path, name, title, date FROM content_index WHERE kind = 'post' ORDER BY date DESC, name DESC LIMIT 5",
    ).all<any>();
    const images = await ctx.env.DB.prepare("SELECT url, name FROM images ORDER BY date DESC LIMIT 4").all<any>();
    const imageCount = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM images").first<{ n: number }>();
    const friends = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM friends").first<{ n: number }>();
    const talks = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM talks").first<{ n: number }>();
    const notifications = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM notifications").first<{ n: number }>();
    const pv = await ctx.env.DB.prepare("SELECT SUM(number) AS n FROM stat_pv").first<{ n: number }>();
    const uv = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM stat_uv").first<{ n: number }>();
    const provider = await store.getJSON<any>("PROVIDER", { provider: "", params: {} });
    return json({
      status: true,
      counts,
      recent: recent.results || [],
      images: images.results || [],
      image_count: imageCount?.n || 0,
      friends: friends?.n || 0,
      talks: talks?.n || 0,
      notifications: notifications?.n || 0,
      statistic: { pv: pv?.n || 0, uv: uv?.n || 0 },
      provider: {
        name: provider.provider || "",
        platform: provider.params?.config || "",
        repo: provider.params?.repo || "",
        branch: provider.params?.branch || "",
      },
      default_password: (await store.get("DEFAULT_ADMIN_PASSWORD", "0")) === "1",
      last_login: await store.get("LAST_LOGIN"),
    });
  }),
);

/* ------------------------------------------------------------------ */
/* content                                                            */
/* ------------------------------------------------------------------ */

router.get("/api/posts", authed(app.apiListPosts));
router.post("/api/posts/refresh", authed(app.apiRefresh));
router.get("/api/post", authed(app.apiGetPost));
router.get("/api/page", authed(app.apiGetPost));
router.post("/api/save_post", authed(app.apiSavePost));
router.post("/api/save_draft", authed(app.apiSaveDraft));
router.post("/api/publish", authed(app.apiPublish));
router.post("/api/unpublish", authed(app.apiUnpublish));
router.post("/api/new_post", authed(app.apiNewPost));
router.post("/api/new_page", authed(app.apiNewPage));
router.post("/api/delete", authed(app.apiDeleteFile));
router.post("/api/rename", authed(app.apiRename));
router.get("/api/pages", authed(app.apiListPages));
router.post("/api/save_page", authed(app.apiSavePage));
router.post("/api/save", authed(app.apiSaveRaw));
router.get("/api/configs", authed(app.apiListConfigs));
router.get("/api/config", authed(app.apiGetConfig));
router.post("/api/save_config", authed(app.apiSaveConfig));
router.post("/api/excerpt", authed(app.apiExcerpt));
router.get("/api/excerpt", authed(app.apiExcerpt));

/* ------------------------------------------------------------------ */
/* images                                                             */
/* ------------------------------------------------------------------ */

router.get("/api/images/file/*", app.apiServeImage);
router.get("/api/images", authed(app.apiListImages));
router.post("/api/upload", authed(app.apiUpload));
router.post("/api/delete_img", authed(app.apiDeleteImage));

/* ------------------------------------------------------------------ */
/* friends & talks                                                    */
/* ------------------------------------------------------------------ */

router.get("/api/friends", authed(app.apiListFriends));
router.post("/api/friends", authed(app.apiAddFriend));
router.put("/api/friends", authed(app.apiEditFriend));
router.del("/api/friends", authed(app.apiDeleteFriend));
router.post("/api/friends/clean", authed(app.apiCleanFriends));
router.get("/api/talks", authed(app.apiListTalks));
router.post("/api/talks", authed(app.apiSaveTalk));
router.del("/api/talks", authed(app.apiDeleteTalk));

/* ------------------------------------------------------------------ */
/* settings & tools                                                   */
/* ------------------------------------------------------------------ */

router.get("/api/settings", authed(app.apiGetSettings));
router.post("/api/settings", staff(app.apiSaveSettings));
router.post("/api/settings/provider", staff(app.apiSetProvider));
router.post("/api/settings/verify_provider", staff(app.apiVerifyProvider));
router.post("/api/settings/github/repos", staff(app.apiGithubRepos));
router.post("/api/settings/github/branches", staff(app.apiGithubBranches));
router.post("/api/settings/image_host", staff(app.apiSetImageHost));
router.post("/api/settings/user", authed(app.apiSetUser));
router.get("/api/custom", authed(app.apiCustomFields));
router.post("/api/custom", staff(app.apiCustomFields));
router.del("/api/custom", staff(app.apiCustomFields));
router.get("/api/notifications", authed(app.apiNotifications));
router.post("/api/notifications", authed(app.apiCreateNotification));
router.del("/api/notifications", authed(app.apiNotifications));
router.get("/api/deploy/logs", authed(app.apiDeployLogs));
router.post("/api/deploy/test", staff(app.apiTestDeploy));
router.post("/api/purge", authed(app.apiPurge));
router.post("/api/fix", staff(app.apiFix));
router.post("/api/create_webhook", staff(app.apiCreateWebhook));
router.get("/api/update/check", authed(app.apiUpdateCheck));
router.get("/api/statistic/summary", authed(app.apiStatSummary));
router.get("/api/export", staff(app.apiExport));
router.post("/api/import", staff(app.apiImport));

/* ------------------------------------------------------------------ */
/* MCP management                                                     */
/* ------------------------------------------------------------------ */

router.get("/api/mcp", staff(app.apiMcp));
router.post("/api/mcp/tokens", staff(app.apiCreateMcpToken));
router.del("/api/mcp/tokens", staff(app.apiRevokeMcpToken));
router.post("/api/mcp/toggle", staff(app.apiToggleMcp));

/* ------------------------------------------------------------------ */
/* public API (theme compatibility)                                   */
/* ------------------------------------------------------------------ */

router.get("/pub/friends", pub.pubFriends);
router.get("/pub/status", pub.pubStatus);
router.get("/pub/statistic", pub.pubStatistic);
router.post("/pub/statistic", pub.pubStatistic);
router.get("/pub/talks", pub.pubGetTalks);
router.post("/pub/like_talk", pub.pubLikeTalk);
router.post("/pub/ask_friend", pub.pubAskFriend);
router.get("/pub/get_posts", pub.pubGetPosts);
router.get("/pub/get_pages", pub.pubGetPages);
router.get("/pub/get_configs", pub.pubGetConfigs);
router.get("/pub/get_images", pub.pubGetImages);
router.get("/pub/get_friends", pub.pubGetFriends);
router.post("/pub/clean_friend", pub.pubCleanFriend);
router.post("/pub/save", pub.pubSave);
router.post("/pub/delete", pub.pubDelete);
router.get("/pub/get_custom", pub.pubGetCustom);
router.post("/pub/set_custom", pub.pubSetCustom);
router.post("/pub/del_custom", pub.pubSetCustom);
router.post("/pub/new_custom", pub.pubSetCustom);
router.get("/pub/get_notifications", pub.pubGetNotifications);
router.post("/pub/notifications", pub.pubNotifications);
router.get("/pub/get_all_talks", pub.pubAllTalks);
router.post("/pub/save_talk", pub.pubSaveTalk);
router.post("/pub/del_talk", pub.pubDelTalk);
router.post("/pub/fix", pub.pubFix);
router.post("/pub/create_webhook", pub.pubCreateWebhook);

/* ------------------------------------------------------------------ */
/* webhook receiver                                                   */
/* ------------------------------------------------------------------ */

router.post("/api/webhook", async (ctx) => {
  const token = ctx.url.searchParams.get("token") || "";
  const { sha256Hex, safeEqual } = await import("./lib");
  const expected = await new Store(ctx.env).get("WEBHOOK_APIKEY");
  if (!token || !expected || !safeEqual(await sha256Hex(token), expected)) {
    return json({ msg: "No permission", status: false });
  }
  await purgeAllCaches(ctx.env);
  return json({ msg: "Done", status: true });
});

/* ------------------------------------------------------------------ */
/* legacy Qexo endpoint aliases                                       */
/* ------------------------------------------------------------------ */

function groupFrom(fields: Record<string, string>): string {
  return fields.group || "";
}

async function withBody(
  ctx: Ctx,
  fields: Record<string, string>,
  group: string,
  parsed: Record<string, unknown>,
): Promise<Response> {
  const merged: Record<string, unknown> = { ...parsed, ...fields, group };
  const req = new Request(ctx.req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(merged),
  });
  return app.apiSaveSettings({ ...ctx, req });
}

const legacy =
  (group: string, map: (b: Record<string, unknown>) => Record<string, string>): Handler =>
  async (ctx) => {
    const body = await readBody(ctx.req);
    return withBody(ctx, map(body), group, body);
  };

router.post(
  "/api/set_hexo",
  staff(async (ctx) => {
    const body = await readBody(ctx.req);
    const force = str(body, "force") === "true";
    const result = await app.saveProvider(ctx, body, force);
    return result.ok ? ok(result.msg) : fail(result.msg);
  }),
);

router.post(
  "/api/set_user",
  authed(async (ctx) => {
    const body = await readBody(ctx.req);
    const req = new Request(ctx.req.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return app.apiSetUser({ ...ctx, req });
  }),
);

router.post(
  "/api/set_image_host",
  staff(async (ctx) => {
    const body = await readBody(ctx.req);
    return app.apiSetImageHost({ ...ctx, req: jsonRequest(ctx, { image_host: str(body, "image_host") }) });
  }),
);

router.post(
  "/api/set_api",
  staff(
    legacy("security", (b) => ({
      apikey: str(b as any, "apikey"),
      allow_friend: str(b as any, "allow_friend", "否"),
      friend_recaptcha: str(b as any, "friend-recaptcha", "否"),
      recaptcha_token: str(b as any, "recaptcha-token"),
    })),
  ),
);

router.post("/api/set_security", staff(legacy("security", (b) => ({
  login_site_token: str(b as any, "site-token"),
  login_server_token: str(b as any, "server-token"),
  login_site_token_v2: str(b as any, "site-token-v2"),
  login_server_token_v2: str(b as any, "server-token-v2"),
}))));

router.post("/api/set_statistic", staff(legacy("statistic", (b) => ({
  allow: str(b as any, "allow_statistic", "否"),
  domains: str(b as any, "statistic_domains"),
}))));

router.post("/api/set_abbrlink", staff(legacy("abbrlink", (b) => ({
  alg: str(b as any, "alg", "crc16"),
  rep: str(b as any, "rep", "dec"),
}))));

router.post("/api/set_cdn", staff(legacy("cdn", (b) => ({ cdn: str(b as any, "cdn") }))));

router.post("/api/set_cust", staff(legacy("basic", (b) => ({
  name: str(b as any, "name"),
  split: str(b as any, "split"),
  logo: str(b as any, "logo"),
  icon: str(b as any, "icon"),
  logo_dark: str(b as any, "logo-dark"),
}))));

router.post("/api/set_excerpt", authed(legacy("excerpt", (b) => ({ config: str(b as any, "excerpt") }))));

router.post("/api/set_sidebar", authed(legacy("sidebar", (b) => ({
  type: str(b as any, "type"),
  content: str(b as any, "content", "[]"),
}))));

router.post("/api/set_onepush", staff(legacy("onepush", (b) => ({ onepush: str(b as any, "onepush") }))));

router.post("/api/set_value", authed(legacy("value", (b) => ({
  name: str(b as any, "name"),
  content: str(b as any, "content"),
}))));
router.post("/api/new_value", staff(legacy("value", (b) => ({
  name: str(b as any, "name"),
  content: str(b as any, "content"),
}))));

router.post("/api/set_custom", staff(app.apiCustomFields));
router.post("/api/new_custom", staff(app.apiCustomFields));
router.del("/api/del_custom", staff(app.apiCustomFields));
router.post(
  "/api/del_custom",
  staff(async (ctx) => {
    const body = await readBody(ctx.req);
    await ctx.env.DB.prepare("DELETE FROM custom_fields WHERE name = ?").bind(str(body, "name")).run();
    return ok("删除成功！");
  }),
);
router.post(
  "/api/del_value",
  staff(async (ctx) => {
    const body = await readBody(ctx.req);
    await ctx.env.DB.prepare("DELETE FROM settings WHERE name = ?").bind(str(body, "name")).run();
    await purgeAllCaches(ctx.env);
    return ok("删除成功！");
  }),
);

router.post("/api/add_friend", authed(app.apiAddFriend));
router.post("/api/edit_friend", authed(app.apiEditFriend));
router.post("/api/del_friend", authed(app.apiDeleteFriend));
router.post("/api/clean_friend", authed(app.apiCleanFriends));
router.post("/api/save_talk", authed(app.apiSaveTalk));
router.post("/api/del_talk", authed(app.apiDeleteTalk));
router.get("/api/get_notifications", authed(app.apiNotifications));
router.post("/api/create_webhook", staff(app.apiCreateWebhook));
router.post("/api/purge", authed(app.apiPurge));
router.post("/api/fix", staff(app.apiFix));
router.post(
  "/api/change_lang",
  authed(legacy("basic", (b) => ({ language: str(b as any, "lang", "zh_CN") }))),
);

router.post(
  "/api/test_onepush",
  staff(async (ctx) => {
    const body = await readBody(ctx.req);
    const { notify } = await import("./api-public");
    await new Store(ctx.env).set("ONEPUSH", str(body, "onepush"));
    await notify(ctx.env, "Qexo消息测试", "这是一条测试消息");
    return ok("测试消息已发送");
  }),
);

router.post(
  "/api/del_notifications",
  authed(async (ctx) => {
    const body = await readBody(ctx.req);
    await ctx.env.DB.prepare("DELETE FROM notifications WHERE time = ?").bind(Number(str(body, "time"))).run();
    return ok("删除成功！");
  }),
);

router.post(
  "/api/clear_notifications",
  authed(async (ctx) => {
    await ctx.env.DB.prepare("DELETE FROM notifications").run();
    return ok("删除成功！");
  }),
);

router.post("/api/do_update", staff(async () => fail("Workers 版本请通过 wrangler deploy 或 Git 集成升级")));

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function jsonRequest(ctx: Ctx, data: unknown): Request {
  return new Request(ctx.req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

/* ------------------------------------------------------------------ */
/* entry                                                              */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: any, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && (url.pathname.startsWith("/pub/") || url.pathname.startsWith("/api/"))) {
      if (url.pathname.startsWith("/pub/")) return pub.preflight();
      return new Response(null, { status: 204 });
    }

    const match = router.match(request.method, url.pathname);
    if (!match) {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/pub/")) {
        return json({ status: false, msg: "接口不存在" }, 404);
      }
      return env.ASSETS.fetch(request);
    }

    const ctx: Ctx = {
      req: request,
      env,
      url,
      params: match.params,
      ip: request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1",
    };

    try {
      if (url.pathname.startsWith("/api/")) {
        const resolved = await resolveSession(env, request);
        if (resolved) {
          ctx.session = resolved.session;
          ctx.user = resolved.user;
        }
      }
      return await match.handler(ctx);
    } catch (error: any) {
      if (error instanceof HttpError) return json({ status: false, msg: error.message }, error.status);
      console.error("Unhandled error", url.pathname, error?.stack || error);
      return json({ status: false, msg: `服务器内部错误: ${error?.message || error}` }, 500);
    }
  },
};
