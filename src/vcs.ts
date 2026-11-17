/**
 * VCS / storage providers.
 *
 * Ported from Qexo's hexoweb/libs/platforms/providers/*.py, but every client is
 * a plain `fetch` call so it runs on Workers. Each method is written to keep the
 * subrequest count low (the free plan allows 50 per invocation).
 */

import { b64decode, b64encode, HttpError, type Env } from "./lib";

export interface TreeEntry {
  path: string;
  type: "file" | "dir";
  size?: number;
  sha?: string;
}

export interface ProviderParams {
  token?: string;
  repo?: string;
  branch?: string;
  path?: string;
  url?: string;
  [k: string]: string | undefined;
}

export interface ProviderConfig {
  provider: string;
  params: ProviderParams;
}

export interface VCSProvider {
  readonly name: string;
  getFile(path: string): Promise<string>;
  getBytes(path: string): Promise<Uint8Array>;
  putFile(path: string, content: string | Uint8Array, message: string, sha?: string): Promise<void>;
  deleteFile(path: string, message: string, sha?: string): Promise<void>;
  listTree(): Promise<TreeEntry[]>;
  listDir(path: string): Promise<TreeEntry[]>;
  listHooks(): Promise<unknown[]>;
  createHook(url: string, events?: string[]): Promise<void>;
  deleteHooks(): Promise<boolean>;
}

export const PROVIDER_PARAMS: Record<string, Record<string, { description: string; placeholder: string }>> = {
  github: {
    token: { description: "GitHub 密钥", placeholder: "ghp_xxx / github_pat_xxx" },
    repo: { description: "GitHub 仓库", placeholder: "username/repo" },
    branch: { description: "项目分支", placeholder: "main" },
    path: { description: "博客路径", placeholder: "留空为根目录" },
  },
  gitlab: {
    url: { description: "GitLab 地址", placeholder: "https://gitlab.com" },
    token: { description: "GitLab 密钥", placeholder: "glpat-xxx" },
    repo: { description: "项目 ID 或路径", placeholder: "username/repo" },
    branch: { description: "项目分支", placeholder: "main" },
    path: { description: "博客路径", placeholder: "留空为根目录" },
  },
  gitea: {
    url: { description: "Gitea 地址", placeholder: "https://git.example.com" },
    token: { description: "Gitea 密钥", placeholder: "token" },
    repo: { description: "Gitea 仓库", placeholder: "username/repo" },
    branch: { description: "项目分支", placeholder: "main" },
    path: { description: "博客路径", placeholder: "留空为根目录" },
  },
  r2: {
    path: { description: "存储前缀", placeholder: "留空为根目录" },
  },
};

export const PROVIDERS = Object.keys(PROVIDER_PARAMS);

abstract class BaseProvider implements VCSProvider {
  abstract readonly name: string;
  protected root: string;
  protected branch: string;

  constructor(protected params: ProviderParams, protected env: Env) {
    const normalized = (params.path || "").trim().replace(/^\/+|\/+$/g, "");
    this.root = normalized ? normalized + "/" : "";
    this.branch = params.branch || "main";
  }

  /** Strips the configured sub-directory and returns null for outside paths. */
  protected toRepoPath(path: string): string {
    const clean = path.replace(/^\/+/, "");
    return this.root + clean;
  }

  protected fromRepoPath(path: string): string | null {
    if (!path.startsWith(this.root)) return null;
    return path.slice(this.root.length);
  }

  protected async req(url: string, init: RequestInit = {}, what = "VCS"): Promise<Response> {
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HttpError(`${what} API ${res.status}: ${body.slice(0, 300)}`, 502);
    }
    return res;
  }

  abstract getFile(path: string): Promise<string>;
  abstract getBytes(path: string): Promise<Uint8Array>;
  abstract putFile(path: string, content: string | Uint8Array, message: string, sha?: string): Promise<void>;
  abstract deleteFile(path: string, message: string, sha?: string): Promise<void>;
  abstract listTree(): Promise<TreeEntry[]>;
  abstract listHooks(): Promise<unknown[]>;
  abstract createHook(url: string, events?: string[]): Promise<void>;
  abstract deleteHooks(): Promise<boolean>;

  async listDir(path: string): Promise<TreeEntry[]> {
    const prefix = path.replace(/^\/+|\/+$/g, "");
    const tree = await this.listTree();
    const out: TreeEntry[] = [];
    const seen = new Set<string>();
    for (const item of tree) {
      if (prefix) {
        if (!item.path.startsWith(prefix + "/")) continue;
      }
      const rel = prefix ? item.path.slice(prefix.length + 1) : item.path;
      const first = rel.split("/")[0];
      if (!first || seen.has(first)) continue;
      seen.add(first);
      const isDirect = !rel.includes("/");
      out.push({
        path: prefix ? `${prefix}/${first}` : first,
        type: isDirect ? item.type : "dir",
        size: isDirect ? item.size : undefined,
        sha: isDirect ? item.sha : undefined,
      });
    }
    return out;
  }

  async build(): Promise<boolean> {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* GitHub                                                             */
/* ------------------------------------------------------------------ */

export class GitHubProvider extends BaseProvider {
  readonly name = "github";
  private base: string;
  private repo: string;
  private headers: Record<string, string>;

  constructor(params: ProviderParams, env: Env) {
    super(params, env);
    this.base = (env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
    this.repo = (params.repo || "").replace(/^\/+|\/+$/g, "");
    this.headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "qexo-workers",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    // Empty token = public read-only mode. Sending `Bearer ` would 401, so the
    // header is only attached when a token is configured.
    if (params.token) this.headers.Authorization = `Bearer ${params.token}`;
  }

  private api(path: string): string {
    return `${this.base}/repos/${this.repo}${path}`;
  }

  private encodePath(path: string): string {
    return path
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
  }

  /** Reads one file. A 404 is reported as "file not found", not as a raw API dump. */
  private async readContent(
    path: string,
    headers: Record<string, string>,
    accept?: string,
  ): Promise<Response> {
    const repoPath = this.toRepoPath(path);
    const res = await fetch(
      this.api(`/contents/${this.encodePath(repoPath)}?ref=${encodeURIComponent(this.branch)}`),
      { headers: accept ? { ...headers, Accept: accept } : headers },
    );
    if (res.status === 404) {
      throw new HttpError(
        `文件不存在：${repoPath}（仓库 ${this.repo || "未配置"}，分支 ${this.branch}）`,
        404,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HttpError(`GitHub API ${res.status}: ${body.slice(0, 300)}`, 502);
    }
    return res;
  }

  async getFile(path: string): Promise<string> {
    const res = await this.readContent(path, this.headers);
    const data: any = await res.json();
    if (Array.isArray(data)) throw new HttpError(`${path} 是目录`, 400);
    return new TextDecoder().decode(b64decode(data.content || ""));
  }

  async getBytes(path: string): Promise<Uint8Array> {
    const res = await this.readContent(path, this.headers, "application/vnd.github.raw");
    return new Uint8Array(await res.arrayBuffer());
  }

  private async shaOf(path: string): Promise<string | undefined> {
    try {
      const res = await this.req(
        this.api(`/contents/${this.encodePath(this.toRepoPath(path))}?ref=${encodeURIComponent(this.branch)}`),
        { headers: this.headers },
        "GitHub",
      );
      const data: any = await res.json();
      return data?.sha;
    } catch {
      return undefined;
    }
  }

  async putFile(path: string, content: string | Uint8Array | string, message: string, sha?: string): Promise<void> {
    const repoPath = this.toRepoPath(path);
    const body: Record<string, unknown> = {
      message,
      content: typeof content === "string" ? b64encode(new TextEncoder().encode(content)) : b64encode(content),
      branch: this.branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(this.api(`/contents/${this.encodePath(repoPath)}`), {
      method: "PUT",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return;
    // 404/409/422: the file does not exist yet or the sha is stale.
    if (res.status === 404 || res.status === 409 || res.status === 422) {
      const existing = await this.shaOf(path);
      if (existing && existing !== sha) {
        body.sha = existing;
        await this.req(
          this.api(`/contents/${this.encodePath(repoPath)}`),
          {
            method: "PUT",
            headers: { ...this.headers, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
          "GitHub",
        );
        return;
      }
    }
    const text = await res.text().catch(() => "");
    throw new HttpError(`GitHub API ${res.status}: ${text.slice(0, 300)}`, 502);
  }

  async deleteFile(path: string, message: string, sha?: string): Promise<void> {
    const repoPath = this.toRepoPath(path);
    const target = sha || (await this.shaOf(path));
    if (!target) throw new HttpError(`文件不存在: ${path}`, 404);
    await this.req(
      this.api(`/contents/${this.encodePath(repoPath)}`),
      {
        method: "DELETE",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ message, sha: target, branch: this.branch }),
      },
      "GitHub",
    );
  }

  async listTree(): Promise<TreeEntry[]> {
    const res = await this.req(
      this.api(`/git/trees/${encodeURIComponent(this.branch)}?recursive=1`),
      { headers: this.headers },
      "GitHub",
    );
    const data: any = await res.json();
    const out: TreeEntry[] = [];
    for (const item of data.tree || []) {
      const rel = this.fromRepoPath(item.path);
      if (rel === null) continue;
      out.push({
        path: rel,
        type: item.type === "tree" ? "dir" : "file",
        size: item.size,
        sha: item.sha,
      });
    }
    return out;
  }

  async listHooks(): Promise<unknown[]> {
    const res = await this.req(this.api(`/hooks`), { headers: this.headers }, "GitHub");
    return (await res.json()) as unknown[];
  }

  async createHook(url: string, events: string[] = ["push"]): Promise<void> {
    await this.req(
      this.api(`/hooks`),
      {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "web",
          active: true,
          events,
          config: { url, content_type: "json" },
        }),
      },
      "GitHub",
    );
  }

  async deleteHooks(): Promise<boolean> {
    const hooks = (await this.listHooks()) as any[];
    for (const hook of hooks) {
      await fetch(this.api(`/hooks/${hook.id}`), { method: "DELETE", headers: this.headers });
    }
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* GitLab                                                             */
/* ------------------------------------------------------------------ */

export class GitLabProvider extends BaseProvider {
  readonly name = "gitlab";
  private base: string;
  private project: string;
  private headers: Record<string, string>;

  constructor(params: ProviderParams, env: Env) {
    super(params, env);
    const origin = (params.url || "https://gitlab.com").replace(/\/+$/, "").replace(/\/api\/v4$/, "");
    this.base = `${origin}/api/v4`;
    this.project = encodeURIComponent(params.repo || "");
    this.headers = { "PRIVATE-TOKEN": params.token || "", "User-Agent": "qexo-workers" };
  }

  private fileUrl(path: string): string {
    return `${this.base}/projects/${this.project}/repository/files/${encodeURIComponent(this.toRepoPath(path))}`;
  }

  async getFile(path: string): Promise<string> {
    const res = await this.req(`${this.fileUrl(path)}/raw?ref=${encodeURIComponent(this.branch)}`, {
      headers: this.headers,
    }, "GitLab");
    return res.text();
  }

  async getBytes(path: string): Promise<Uint8Array> {
    const res = await this.req(`${this.fileUrl(path)}/raw?ref=${encodeURIComponent(this.branch)}`, {
      headers: this.headers,
    }, "GitLab");
    return new Uint8Array(await res.arrayBuffer());
  }

  async putFile(path: string, content: string | Uint8Array, message: string): Promise<void> {
    const payload = {
      branch: this.branch,
      content: typeof content === "string" ? content : b64encode(content),
      commit_message: message,
      encoding: typeof content === "string" ? "text" : "base64",
    };
    const create = await fetch(this.fileUrl(path), {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (create.ok) return;
    if (create.status === 400) {
      await this.req(
        this.fileUrl(path),
        {
          method: "PUT",
          headers: { ...this.headers, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        "GitLab",
      );
      return;
    }
    throw new HttpError(`GitLab API ${create.status}: ${(await create.text()).slice(0, 300)}`, 502);
  }

  async deleteFile(path: string, message: string): Promise<void> {
    await this.req(
      `${this.fileUrl(path)}?branch=${encodeURIComponent(this.branch)}&commit_message=${encodeURIComponent(message)}`,
      { method: "DELETE", headers: this.headers },
      "GitLab",
    );
  }

  async listTree(): Promise<TreeEntry[]> {
    const out: TreeEntry[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.req(
        `${this.base}/projects/${this.project}/repository/tree?ref=${encodeURIComponent(
          this.branch,
        )}&recursive=true&per_page=100&page=${page}`,
        { headers: this.headers },
        "GitLab",
      );
      const items = (await res.json()) as any[];
      for (const item of items) {
        const rel = this.fromRepoPath(item.path);
        if (rel === null) continue;
        out.push({ path: rel, type: item.type === "tree" ? "dir" : "file" });
      }
      if (items.length < 100) break;
    }
    return out;
  }

  async listHooks(): Promise<unknown[]> {
    const res = await this.req(`${this.base}/projects/${this.project}/hooks`, { headers: this.headers }, "GitLab");
    return (await res.json()) as unknown[];
  }

  async createHook(url: string, events: string[] = ["push"]): Promise<void> {
    await this.req(
      `${this.base}/projects/${this.project}/hooks`,
      {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ url, push_events: events.includes("push") }),
      },
      "GitLab",
    );
  }

  async deleteHooks(): Promise<boolean> {
    const hooks = (await this.listHooks()) as any[];
    for (const hook of hooks) {
      await fetch(`${this.base}/projects/${this.project}/hooks/${hook.id}`, {
        method: "DELETE",
        headers: this.headers,
      });
    }
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Gitea                                                              */
/* ------------------------------------------------------------------ */

export class GiteaProvider extends BaseProvider {
  readonly name = "gitea";
  private base: string;
  private repo: string;
  private headers: Record<string, string>;

  constructor(params: ProviderParams, env: Env) {
    super(params, env);
    const origin = (params.url || "").replace(/\/+$/, "").replace(/\/api\/v1$/, "");
    this.base = `${origin}/api/v1`;
    this.repo = (params.repo || "").replace(/^\/+|\/+$/g, "");
    this.headers = {
      Authorization: `token ${params.token || ""}`,
      "Content-Type": "application/json",
      "User-Agent": "qexo-workers",
    };
  }

  private contentUrl(path: string): string {
    const encoded = this.toRepoPath(path)
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    return `${this.base}/repos/${this.repo}/contents/${encoded}`;
  }

  async getFile(path: string): Promise<string> {
    const res = await this.req(`${this.contentUrl(path)}?ref=${encodeURIComponent(this.branch)}`, {
      headers: this.headers,
    }, "Gitea");
    const data: any = await res.json();
    return new TextDecoder().decode(b64decode(data.content || ""));
  }

  async getBytes(path: string): Promise<Uint8Array> {
    const res = await this.req(`${this.contentUrl(path)}?ref=${encodeURIComponent(this.branch)}`, {
      headers: { ...this.headers, Accept: "application/json" },
    }, "Gitea");
    const data: any = await res.json();
    return b64decode(data.content || "");
  }

  async putFile(path: string, content: string | Uint8Array, message: string, sha?: string): Promise<void> {
    const body: Record<string, unknown> = {
      content: typeof content === "string" ? b64encode(new TextEncoder().encode(content)) : b64encode(content),
      message,
      branch: this.branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(this.contentUrl(path), {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (res.ok) return;
    const text = await res.text().catch(() => "");
    throw new HttpError(`Gitea API ${res.status}: ${text.slice(0, 300)}`, 502);
  }

  async deleteFile(path: string, message: string, sha?: string): Promise<void> {
    let target = sha;
    if (!target) {
      const res = await this.req(`${this.contentUrl(path)}?ref=${encodeURIComponent(this.branch)}`, {
        headers: this.headers,
      }, "Gitea");
      const meta: any = await res.json();
      target = meta?.sha;
    }
    await this.req(this.contentUrl(path), {
      method: "DELETE",
      headers: this.headers,
      body: JSON.stringify({ sha: target, message, branch: this.branch }),
    }, "Gitea");
  }

  async listTree(): Promise<TreeEntry[]> {
    const out: TreeEntry[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.req(
        `${this.base}/repos/${this.repo}/git/trees/${encodeURIComponent(
          this.branch,
        )}?recursive=true&per_page=1000&page=${page}`,
        { headers: this.headers },
        "Gitea",
      );
      const data: any = await res.json();
      const items: any[] = data.tree || [];
      for (const item of items) {
        const rel = this.fromRepoPath(item.path);
        if (rel === null) continue;
        out.push({ path: rel, type: item.type === "tree" ? "dir" : "file", size: item.size, sha: item.sha });
      }
      if (items.length < 1000) break;
    }
    return out;
  }

  async listHooks(): Promise<unknown[]> {
    const res = await this.req(`${this.base}/repos/${this.repo}/hooks`, { headers: this.headers }, "Gitea");
    return (await res.json()) as unknown[];
  }

  async createHook(url: string, events: string[] = ["push"]): Promise<void> {
    await this.req(
      `${this.base}/repos/${this.repo}/hooks`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ type: "gitea", active: true, events, config: { url, content_type: "json" } }),
      },
      "Gitea",
    );
  }

  async deleteHooks(): Promise<boolean> {
    const hooks = (await this.listHooks()) as any[];
    for (const hook of hooks) {
      await fetch(`${this.base}/repos/${this.repo}/hooks/${hook.id}`, { method: "DELETE", headers: this.headers });
    }
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* R2 (replacement for Qexo's local filesystem provider)              */
/* ------------------------------------------------------------------ */

export class R2Provider extends BaseProvider {
  readonly name = "r2";

  private bucket(): R2Bucket {
    if (!this.env.R2) throw new HttpError("未绑定 R2 存储桶", 500);
    return this.env.R2;
  }

  private key(path: string): string {
    return this.toRepoPath(path).replace(/^\/+/, "");
  }

  async getFile(path: string): Promise<string> {
    const obj = await this.bucket().get(this.key(path));
    if (!obj) throw new HttpError(`文件不存在: ${path}`, 404);
    return obj.text();
  }

  async getBytes(path: string): Promise<Uint8Array> {
    const obj = await this.bucket().get(this.key(path));
    if (!obj) throw new HttpError(`文件不存在: ${path}`, 404);
    return new Uint8Array(await obj.arrayBuffer());
  }

  async putFile(path: string, content: string | Uint8Array, _message: string): Promise<void> {
    const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await this.bucket().put(this.key(path), body, {
      httpMetadata: { contentType: guessContentType(path) },
    });
  }

  async deleteFile(path: string): Promise<void> {
    const key = this.key(path);
    await this.bucket().delete(key);
    // Directory semantics: delete every object sharing the prefix.
    let cursor: string | undefined;
    do {
      const list = await this.bucket().list({ prefix: key.replace(/\/?$/, "/"), cursor });
      for (const obj of list.objects) await this.bucket().delete(obj.key);
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  }

  async listTree(): Promise<TreeEntry[]> {
    const out: TreeEntry[] = [];
    let cursor: string | undefined;
    do {
      const list = await this.bucket().list({ prefix: this.root, cursor, limit: 1000 });
      for (const obj of list.objects) {
        const rel = this.fromRepoPath(obj.key);
        if (rel) out.push({ path: rel, type: "file", size: obj.size });
      }
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    return out;
  }

  async listHooks(): Promise<unknown[]> {
    return [];
  }

  async createHook(): Promise<void> {
    throw new HttpError("R2 提供者不支持 WebHook", 400);
  }

  async deleteHooks(): Promise<boolean> {
    return false;
  }
}

export function guessContentType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return (
    {
      ".md": "text/markdown; charset=utf-8",
      ".yml": "text/yaml; charset=utf-8",
      ".yaml": "text/yaml; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".avif": "image/avif",
      ".ico": "image/x-icon",
    } as Record<string, string>
  )[ext] || "application/octet-stream";
}

export function createProvider(config: ProviderConfig, env: Env): VCSProvider {
  const name = (config?.provider || "").toLowerCase();
  const params = config?.params || {};
  switch (name) {
    case "github":
      return new GitHubProvider(params, env);
    case "gitlab":
      return new GitLabProvider(params, env);
    case "gitea":
      return new GiteaProvider(params, env);
    case "local":
    case "r2":
      return new R2Provider(params, env);
    default:
      throw new HttpError(`未知的 Provider: ${config?.provider}`, 400);
  }
}
