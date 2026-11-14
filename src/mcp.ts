/**
 * MCP (Model Context Protocol) server.
 *
 * Transport: Streamable HTTP (2025-06-18), single endpoint `/mcp`, JSON
 * responses. Stateless: no Mcp-Session-Id is issued, which the spec permits.
 * Auth: per-token bearer credentials with read/write scopes, stored as SHA-256.
 */

import {
  HttpError,
  b64decode,
  b64encode,
  json,
  nowSec,
  safeEqual,
  sha256Hex,
  toInt,
  type Ctx,
  type Env,
} from "./lib";
import { ContentService } from "./content";
import { Store, QEXO_VERSION } from "./store";
import { getImageHost } from "./images";
import { guessContentType } from "./vcs";

const LATEST_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
  "Cache-Control": "no-store",
};

interface McpToken {
  id: string;
  name: string;
  hash: string;
  scopes: string[];
  created_at: number;
  last_used_at?: number;
}

interface RpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: any;
}

interface ToolDef {
  name: string;
  description: string;
  scope: "read" | "write";
  inputSchema: Record<string, unknown>;
  handler: (args: any, env: Env) => Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/* HTTP entry                                                         */
/* ------------------------------------------------------------------ */

export async function handleMcp(ctx: Ctx): Promise<Response> {
  if (ctx.req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (ctx.req.method !== "POST") {
    return json({ error: "Method Not Allowed", hint: "MCP endpoint accepts POST (Streamable HTTP)" }, 405, {
      ...CORS,
      Allow: "POST, OPTIONS",
    });
  }

  const origin = ctx.req.headers.get("origin");
  if (origin && (!/^https?:\/\//i.test(origin) || origin === "null")) {
    return json({ error: "Forbidden origin" }, 403, CORS);
  }

  const token = await authenticate(ctx.env, ctx.req);
  if (!token) {
    return json({ error: "Unauthorized" }, 401, {
      ...CORS,
      "WWW-Authenticate": 'Bearer realm="qexo-mcp"',
    });
  }

  const contentType = (ctx.req.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return json(rpcError(null, -32600, "Content-Type must be application/json"), 415, CORS);
  }

  const raw = await ctx.req.text();
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400, CORS);
  }

  if (Array.isArray(payload)) {
    return json(rpcError(null, -32600, "Batch requests are not supported by 2025-06-18"), 400, CORS);
  }
  if (!payload || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    return json(rpcError(payload?.id ?? null, -32600, "Invalid Request"), 400, CORS);
  }

  const request = payload as RpcRequest;
  const negotiated = negotiateVersion(ctx.req);

  // Notifications and client responses: acknowledge, no body.
  if (request.id === undefined || request.id === null) {
    if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") {
      return new Response(null, {
        status: 202,
        headers: { ...CORS, "MCP-Protocol-Version": negotiated },
      });
    }
    // Unknown notifications are ignored per JSON-RPC.
    return new Response(null, { status: 202, headers: { ...CORS, "MCP-Protocol-Version": negotiated } });
  }

  try {
    const result = await dispatch(request, ctx.env, token, negotiated);
    return json({ jsonrpc: "2.0", id: request.id, result }, 200, {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "MCP-Protocol-Version": negotiated,
    });
  } catch (error: any) {
    if (error instanceof RpcError) {
      return json(rpcError(request.id, error.code, error.message, error.data), 200, {
        ...CORS,
        "MCP-Protocol-Version": negotiated,
      });
    }
    console.error("MCP error", request.method, error?.stack || error);
    return json(rpcError(request.id, -32603, error?.message || "Internal error"), 200, {
      ...CORS,
      "MCP-Protocol-Version": negotiated,
    });
  }
}

class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function negotiateVersion(req: Request): string {
  const requested = req.headers.get("mcp-protocol-version") || "";
  return SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL;
}

/* ------------------------------------------------------------------ */
/* Auth                                                               */
/* ------------------------------------------------------------------ */

async function authenticate(env: Env, req: Request): Promise<McpToken | null> {
  const store = new Store(env);
  if ((await store.get("MCP_ENABLED", "是")) !== "是") return null;
  const header = req.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const plain = match[1].trim();
  if (!plain.startsWith("qx_mcp_")) return null;

  const tokens = await store.getJSON<McpToken[]>("MCP_TOKENS", []);
  const hash = await sha256Hex(plain);
  const found = tokens.find((t) => safeEqual(t.hash, hash));
  if (!found) return null;

  // Throttle last_used_at writes: at most once per hour per token.
  if (!found.last_used_at || nowSec() - found.last_used_at > 3600) {
    found.last_used_at = nowSec();
    await store.set("MCP_TOKENS", JSON.stringify(tokens));
  }
  return found;
}

export async function createMcpToken(
  env: Env,
  name: string,
  scopes: string[],
): Promise<{ token: string; record: McpToken }> {
  const store = new Store(env);
  const tokens = await store.getJSON<McpToken[]>("MCP_TOKENS", []);
  const plain = "qx_mcp_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const record: McpToken = {
    id: crypto.randomUUID(),
    name: name || "AI Agent",
    hash: await sha256Hex(plain),
    scopes: scopes.length ? scopes : ["read"],
    created_at: nowSec(),
  };
  tokens.push(record);
  await store.set("MCP_TOKENS", JSON.stringify(tokens));
  return { token: plain, record };
}

export async function listMcpTokens(env: Env): Promise<Omit<McpToken, "hash">[]> {
  const tokens = await new Store(env).getJSON<McpToken[]>("MCP_TOKENS", []);
  return tokens.map(({ hash, ...rest }) => rest);
}

export async function revokeMcpToken(env: Env, id: string): Promise<boolean> {
  const store = new Store(env);
  const tokens = await store.getJSON<McpToken[]>("MCP_TOKENS", []);
  const next = tokens.filter((t) => t.id !== id);
  if (next.length === tokens.length) return false;
  await store.set("MCP_TOKENS", JSON.stringify(next));
  return true;
}

function requireScope(token: McpToken, scope: "read" | "write"): void {
  const scopes = token.scopes || [];
  if (scopes.includes("write")) return;
  if (scope === "read" && scopes.includes("read")) return;
  throw new RpcError(-32003, `Insufficient scope: ${scope} required`, { required: scope, granted: scopes });
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                           */
/* ------------------------------------------------------------------ */

async function dispatch(req: RpcRequest, env: Env, token: McpToken, version: string): Promise<unknown> {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: version,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: { name: "qexo-workers", title: "Qexo Workers", version: QEXO_VERSION },
        instructions:
          "Qexo 管理静态博客（Hexo/Hugo 等）。内容写入 Git 仓库，随后由 Cloudflare Pages 构建。" +
          "读取用 list_posts/get_post；写入用 create_post/update_post；发布状态用 publish_post/unpublish_post。" +
          "删除文件需显式 confirm=true。所有路径均为仓库相对路径。",
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.scope === "read", destructiveHint: t.name === "delete_file" },
        })),
      };
    case "tools/call":
      return callTool(req.params, env, token);
    case "resources/list":
      return listResources(env);
    case "resources/read":
      return readResource(req.params, env);
    case "resources/templates/list":
      return {
        resourceTemplates: [
          {
            uriTemplate: "qexo://config/{path}",
            name: "配置文件",
            description: "读取仓库中的 YAML/JSON/TOML 配置文件，path 为仓库相对路径",
            mimeType: "text/plain",
          },
        ],
      };
    case "prompts/list":
      return {
        prompts: [
          {
            name: "write_post",
            title: "写一篇博客文章",
            description: "按主题生成文章并写入 Qexo（默认保存为草稿）",
            arguments: [
              { name: "topic", description: "文章主题", required: true },
              { name: "tone", description: "语气，如 技术/随笔/教程", required: false },
              { name: "publish", description: "true 则直接发布", required: false },
            ],
          },
        ],
      };
    case "prompts/get":
      return getPrompt(req.params);
    default:
      throw new RpcError(-32601, `Method not found: ${req.method}`);
  }
}

async function callTool(params: any, env: Env, token: McpToken): Promise<unknown> {
  const name = params?.name;
  const args = params?.arguments || {};
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);

  try {
    // Authorization failures are surfaced as tool errors so the model can
    // explain the limitation instead of treating it as a transport failure.
    requireScope(token, tool.scope);
    const data = await tool.handler(args, env);
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return {
      content: [{ type: "text", text: text.length > 120000 ? text.slice(0, 120000) + "\n…(truncated)" : text }],
      structuredContent: isPlainObject(data) ? data : { result: data },
      isError: false,
    };
  } catch (error: any) {
    const message = error instanceof HttpError ? error.message : error?.message || String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/* ------------------------------------------------------------------ */
/* Service helpers                                                    */
/* ------------------------------------------------------------------ */

async function svc(env: Env): Promise<ContentService> {
  return ContentService.create(env, new Store(env));
}

function summarizePost(p: any) {
  return {
    name: p.name,
    path: p.path,
    title: p.title || p.name,
    status: p.status ? "published" : "draft",
    size: p.size,
    date: p.date || 0,
  };
}

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

const TOOLS: ToolDef[] = [
  {
    name: "qexo_overview",
    description: "站点概览：内容源、平台、文章/草稿/页面数量、友链/说说数量、PV/UV。",
    scope: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, env) => {
      const store = new Store(env);
      const content = await svc(env).catch(() => null);
      const counts = content ? await content.counts() : { post: 0, draft: 0, page: 0, config: 0 };
      const provider = await store.getJSON<any>("PROVIDER", { provider: "", params: {} });
      const pv = await env.DB.prepare("SELECT SUM(number) AS n FROM stat_pv").first<{ n: number }>();
      const uv = await env.DB.prepare("SELECT COUNT(*) AS n FROM stat_uv").first<{ n: number }>();
      const friends = await env.DB.prepare("SELECT COUNT(*) AS n FROM friends").first<{ n: number }>();
      const talks = await env.DB.prepare("SELECT COUNT(*) AS n FROM talks").first<{ n: number }>();
      return {
        version: QEXO_VERSION,
        provider: {
          type: provider.provider || "",
          platform: provider.params?.config || "",
          repo: provider.params?.repo || "",
          branch: provider.params?.branch || "",
        },
        counts,
        friends: friends?.n || 0,
        talks: talks?.n || 0,
        statistic: { pv: pv?.n || 0, uv: uv?.n || 0 },
      };
    },
  },
  {
    name: "list_posts",
    description: "列出文章与草稿。可按名称搜索，可按状态过滤。",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "按文件名/路径搜索" },
        status: { type: "string", enum: ["all", "published", "draft"], default: "all" },
        limit: { type: "number", default: 100 },
      },
      additionalProperties: false,
    },
    handler: async (args, env) => {
      const service = await svc(env);
      let items = await service.listPosts(args.search || "");
      if (args.status === "published") items = items.filter((i) => i.status);
      if (args.status === "draft") items = items.filter((i) => !i.status);
      const limit = Math.min(500, Math.max(1, toInt(args.limit, 100)));
      return { total: items.length, posts: items.slice(0, limit).map(summarizePost) };
    },
  },
  {
    name: "get_post",
    description: "读取单篇文章/页面的 front-matter 与正文。path 为仓库相对路径。",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "如 source/_posts/hello.md" } },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args, env) => {
      if (!args.path) throw new Error("path is required");
      const service = await svc(env);
      const post = await service.readPost(args.path);
      return { path: args.path, ...post };
    },
  },
  {
    name: "list_pages",
    description: "列出独立页面（关于、友链等）。",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { search: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (args, env) => {
      const pages = await (await svc(env)).listPages(args.search || "");
      return { total: pages.length, pages: pages.map(summarizePost) };
    },
  },
  {
    name: "list_configs",
    description: "列出仓库中的配置文件（YAML/JSON/TOML 等）。",
    scope: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, env) => {
      const configs = await (await svc(env)).listConfigs("");
      return {
        total: configs.length,
        configs: configs.map((c) => ({ name: c.name, path: c.path, size: c.size })),
      };
    },
  },
  {
    name: "get_config",
    description: "读取配置文件全文。",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "如 _config.yml" } },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args, env) => {
      if (!args.path) throw new Error("path is required");
      const content = await (await svc(env)).getFileRaw(args.path);
      return { path: args.path, content };
    },
  },
  {
    name: "list_images",
    description: "列出图床中已记录的图片。",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { search: { type: "string" }, limit: { type: "number", default: 50 } },
      additionalProperties: false,
    },
    handler: async (args, env) => {
      const limit = Math.min(200, Math.max(1, toInt(args.limit, 50)));
      const { results } = await env.DB.prepare(
        "SELECT name, url, size, date FROM images ORDER BY date DESC LIMIT ?",
      )
        .bind(limit)
        .all<any>();
      const q = (args.search || "").toUpperCase();
      const images = (results || [])
        .filter((r) => !q || String(r.name).toUpperCase().includes(q))
        .map((r) => ({ name: r.name, url: r.url, size: Number(r.size), date: r.date }));
      return { total: images.length, images };
    },
  },
  {
    name: "list_friends",
    description: "列出友链（含隐藏状态）。",
    scope: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, env) => {
      const { results } = await env.DB.prepare(
        "SELECT name, url, image_url, description, time, status FROM friends ORDER BY time DESC",
      ).all<any>();
      return {
        total: (results || []).length,
        friends: (results || []).map((r) => ({
          name: r.name,
          url: r.url,
          image: r.image_url,
          description: r.description,
          status: r.status ? "visible" : "hidden",
          time: r.time,
        })),
      };
    },
  },
  {
    name: "list_talks",
    description: "分页读取说说。",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { page: { type: "number", default: 1 }, limit: { type: "number", default: 10 } },
      additionalProperties: false,
    },
    handler: async (args, env) => {
      const page = Math.max(1, toInt(args.page, 1));
      const limit = Math.min(50, Math.max(1, toInt(args.limit, 10)));
      const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM talks").first<{ n: number }>();
      const { results } = await env.DB.prepare("SELECT id, content, tags, time, likes FROM talks ORDER BY time DESC LIMIT ? OFFSET ?")
        .bind(limit, (page - 1) * limit)
        .all<any>();
      return {
        total: total?.n || 0,
        page,
        limit,
        talks: (results || []).map((r) => ({
          id: r.id,
          content: r.content,
          tags: safeParse(r.tags, []),
          time: r.time,
          likes: safeParse<string[]>(r.likes, []).length,
        })),
      };
    },
  },
  {
    name: "get_statistics",
    description: "站点访问统计：总 PV/UV 与访问量最高的页面。",
    scope: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, env) => {
      const pv = await env.DB.prepare("SELECT SUM(number) AS n FROM stat_pv").first<{ n: number }>();
      const uv = await env.DB.prepare("SELECT COUNT(*) AS n FROM stat_uv").first<{ n: number }>();
      const top = await env.DB.prepare("SELECT url, number FROM stat_pv ORDER BY number DESC LIMIT 10").all<any>();
      return { site_pv: pv?.n || 0, site_uv: uv?.n || 0, top: top.results || [] };
    },
  },
  {
    name: "create_post",
    description:
      "新建文章。默认保存为草稿；publish=true 时直接发布到正式目录。front_matter 可含 title/date/tags/categories/abbrlink/excerpt。",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "文件名，不含扩展名，可含子目录" },
        content: { type: "string", description: "Markdown 正文" },
        front_matter: { type: "object", description: "front-matter 字段" },
        publish: { type: "boolean", default: false },
      },
      required: ["name", "content"],
      additionalProperties: false,
    },
    handler: async (args, env) => {
      if (!args.name) throw new Error("name is required");
      const fm = { ...(args.front_matter || {}) };
      if (!fm.title) fm.title = String(args.name).split("/").pop();
      if (!fm.date) fm.date = new Date().toISOString().replace("T", " ").slice(0, 19);
      const service = await svc(env);
      const result = await service.savePost(String(args.name), String(args.content ?? ""), fm, undefined, args.publish === true);
      return { path: result.path, published: args.publish === true, deployed: result.deployed };
    },
  },
  {
    name: "update_post",
    description: "更新已有文章的正文和/或 front-matter，可同时改变发布状态。",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        front_matter: { type: "object" },
        publish: { type: "boolean", description: "省略则保持当前状态" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args, env) => {
      if (!args.path) throw new Error("path is required");
      const service = await svc(env);
      const existing = await service.readPost(args.path);
      const row = await env.DB.prepare("SELECT kind FROM content_index WHERE path = ?")
        .bind(args.path)
        .first<{ kind: string }>();
      const wasPublished = row ? row.kind === "post" : !/_drafts|drafts\//.test(args.path);
      const content = args.content === undefined ? existing.content : String(args.content);
      const fm = { ...existing.front_matter, ...(args.front_matter || {}) };
      const publish = args.publish === undefined ? wasPublished : args.publish === true;
      const name = String(args.path).split("/").pop()!.replace(/\.[^.]+$/, "");
      const result = await service.savePost(name, content, fm, args.path, publish);
      return { path: result.path, published: publish, deployed: result.deployed };
    },
  },
  {
    name: "publish_post",
    description: "把草稿发布为正式文章。",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args, env) => {
      const result = await (await svc(env)).publish(args.path);
      return { path: result.path, published: true };
    },
  },
  {
    name: "unpublish_post",
    description: "把已发布文章转为草稿。",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args, env) => {
      const result = await (await svc(env)).unpublish(args.path);
      return { path: result.path, published: false };
    },
  },
  {
    name: "delete_file",
    description: "删除仓库中的文件（文章/页面/配置）。必须显式传 confirm=true，操作不可回退。",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, confirm: { type: "boolean" } },
      required: ["path", "confirm"],
      additionalProperties: false,
    },
    handler: async (args, env) => {
      if (args.confirm !== true) throw new Error("confirm=true is required to delete");
      await (await svc(env)).delete(args.path);
      return { path: args.path, deleted: true };
    },
  },
  {
    name: "save_config",
    description: "保存配置文件。YAML/JSON 会先做语法校验，失败则不写入。",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async (args, env) => {
      await (await svc(env)).saveConfig(args.path, String(args.content ?? ""));
      return { path: args.path, saved: true };
    },
  },
  {
    name: "upload_image",
    description: "上传图片到已配置的图床。传 data_base64（可带 data: 前缀）或 url 二选一。",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string" },
        data_base64: { type: "string" },
        url: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: async (args, env) => {
      const store = new Store(env);
      const cfg = await store.getJSON<{ type: string; params: Record<string, string> }>("IMG_HOST", {
        type: "关闭",
        params: {},
      });
      let bytes: Uint8Array;
      let filename = args.filename || `mcp-${Date.now()}.png`;
      let mime = "image/png";
      if (args.data_base64) {
        const raw = String(args.data_base64);
        const m = /^data:([^;]+);base64,/.exec(raw);
        if (m) mime = m[1];
        const payload = raw.replace(/^data:[^;]+;base64,/, "");
        bytes = b64decode(payload);
        if (bytes.length > 8 * 1024 * 1024) throw new Error("image larger than 8 MiB");
      } else if (args.url) {
        const res = await fetch(String(args.url));
        if (!res.ok) throw new Error(`failed to fetch image: HTTP ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
        mime = res.headers.get("content-type") || "image/png";
        const ext = (mime.split("/")[1] || "png").replace("jpeg", "jpg");
        if (!filename.includes(".")) filename += `.${ext}`;
      } else {
        throw new Error("data_base64 or url is required");
      }
      const host = getImageHost(cfg.type, cfg.params || {}, env);
      const file = new File([bytes as any], filename, { type: mime || guessContentType(filename) });
      const result = await host.upload(file, bytes);
      const date = nowSec();
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO images (id, name, url, size, date, type, delete_config) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(id, filename, result.url, String(bytes.length), date, mime, JSON.stringify(result.deleteConfig))
        .run();
      return { url: result.url, name: filename, size: bytes.length, id };
    },
  },
  {
    name: "trigger_deploy",
    description: "触发一次站点构建（使用「设置 → 部署」中配置的方式）。",
    scope: "write",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, env) => {
      const store = new Store(env);
      const kind = await store.get("DEPLOY_KIND");
      const hook = await store.get("DEPLOY_WEBHOOK");
      if (!kind || !hook) throw new Error("deploy is not configured (设置 → 部署)");
      const res = await fetch(hook, { method: "POST", body: JSON.stringify({ reason: "MCP trigger_deploy" }) });
      return { target: kind, httpStatus: res.status, ok: res.ok };
    },
  },
];

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Resources & prompts                                                */
/* ------------------------------------------------------------------ */

async function listResources(env: Env) {
  const configs = await (await svc(env))
    .listConfigs("")
    .catch(() => []);
  return {
    resources: [
      {
        uri: "qexo://status",
        name: "站点状态",
        description: "内容源、平台、文章数量与统计",
        mimeType: "application/json",
      },
      {
        uri: "qexo://posts",
        name: "文章列表",
        description: "已发布与草稿的 JSON 列表",
        mimeType: "application/json",
      },
      ...configs.slice(0, 50).map((c) => ({
        uri: `qexo://config/${encodeURIComponent(c.path)}`,
        name: c.name,
        description: c.path,
        mimeType: "text/plain",
      })),
    ],
  };
}

async function readResource(params: any, env: Env) {
  const uri = String(params?.uri || "");
  if (uri === "qexo://status") {
    const content = await TOOLS[0].handler({}, env);
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(content, null, 2) }] };
  }
  if (uri === "qexo://posts") {
    const posts = await (await svc(env)).listPosts("");
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(posts.map(summarizePost), null, 2) }],
    };
  }
  const m = /^qexo:\/\/config\/(.+)$/.exec(uri);
  if (m) {
    const path = decodeURIComponent(m[1]);
    const content = await (await svc(env)).getFileRaw(path);
    return { contents: [{ uri, mimeType: "text/plain", text: content }] };
  }
  throw new RpcError(-32602, `Unknown resource: ${uri}`);
}

function getPrompt(params: any) {
  const name = params?.name;
  if (name !== "write_post") throw new RpcError(-32602, `Unknown prompt: ${name}`);
  const args = params?.arguments || {};
  const topic = String(args.topic || "未命名主题");
  const tone = String(args.tone || "技术");
  const publish = String(args.publish || "false") === "true";
  return {
    description: "生成并写入一篇博客文章",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `请为我的博客写一篇${tone}风格的文章，主题：${topic}。\n` +
            `要求：中文；Markdown；含二级标题与小节；代码块标注语言；300-800 字。\n` +
            `完成后调用 create_post 工具写入，name 使用英文短横线 slug，` +
            `front_matter 包含 title/date/tags，publish=${publish}。`,
        },
      },
    ],
  };
}

/** Metadata for the admin UI. */
export function mcpToolCatalog() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, scope: t.scope }));
}

export { b64encode, b64decode };
