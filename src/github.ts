/**
 * GitHub account/repository discovery for the content-source form.
 *
 * These helpers only *read* metadata: they validate a token, list the repos it
 * can reach and the branches of one repo. They never persist the token — the
 * caller passes it straight from the request or from the saved provider config.
 */

import type { Env } from "./lib";

const DEFAULT_BASE = "https://api.github.com";

export interface GithubRepoSummary {
  full_name: string;
  private: boolean;
  default_branch: string;
  updated_at: string;
  push: boolean;
}

export interface GithubBranchSummary {
  name: string;
  protected: boolean;
}

export interface RepoListResult {
  login: string;
  name: string;
  repos: GithubRepoSummary[];
  truncated: boolean;
}

export interface BranchListResult {
  repo: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  push: boolean;
  branches: GithubBranchSummary[];
  truncated: boolean;
}

/** Upstream-visible error: message is shown verbatim in the admin UI. */
export class GithubApiError extends Error {
  constructor(message: string, readonly upstream = 502) {
    super(message);
    this.name = "GithubApiError";
  }
}

function apiBase(env: Env): string {
  return (env.GITHUB_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
}

function headers(token: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "qexo-workers",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function describe(res: Response, body: string): string {
  let detail = "";
  try {
    detail = String(JSON.parse(body)?.message || "").slice(0, 200);
  } catch {
    detail = body.slice(0, 200);
  }
  if (res.status === 401) return "GitHub 密钥无效或已过期（401），请检查是否复制完整";
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
      const when = reset ? new Date(reset * 1000).toISOString().slice(11, 16) + " UTC" : "稍后";
      return `GitHub 接口限流（403），请在 ${when} 后重试`;
    }
    return `GitHub 拒绝访问（403）：${detail || "令牌缺少读取仓库的权限"}`;
  }
  if (res.status === 404) return "资源不存在或令牌无权访问（404）";
  return `GitHub API ${res.status}${detail ? `：${detail}` : ""}`;
}

async function ghGet(env: Env, token: string, path: string): Promise<{ body: any; res: Response }> {
  let res: Response;
  try {
    res = await fetch(`${apiBase(env)}${path}`, { headers: headers(token) });
  } catch (e: any) {
    throw new GithubApiError(`无法连接 GitHub API：${e?.message || e}`, 502);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GithubApiError(describe(res, text), res.status);
  }
  const body = await res.json().catch(() => null);
  return { body, res };
}

function asRepo(raw: any): GithubRepoSummary | null {
  const full = String(raw?.full_name || "").trim();
  if (!full.includes("/")) return null;
  return {
    full_name: full,
    private: !!raw.private,
    default_branch: String(raw.default_branch || "main"),
    updated_at: String(raw.updated_at || raw.pushed_at || ""),
    push: raw?.permissions?.push !== false,
  };
}

/** Validates the token and lists every repository it can see (up to 300). */
export async function listGithubRepos(token: string, env: Env): Promise<RepoListResult> {
  const me = await ghGet(env, token, "/user");
  const login = String(me.body?.login || "");
  const name = String(me.body?.name || "");

  const repos: GithubRepoSummary[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (let page = 1; page <= 3; page++) {
    const query = `?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`;
    const { body } = await ghGet(env, token, `/user/repos${query}`);
    const rows: any[] = Array.isArray(body) ? body : [];
    for (const row of rows) {
      const repo = asRepo(row);
      if (!repo || seen.has(repo.full_name)) continue;
      seen.add(repo.full_name);
      repos.push(repo);
    }
    if (rows.length < 100) break;
    if (page === 3) truncated = true;
  }

  return { login, name, repos, truncated };
}

function assertRepo(repo: string): string {
  const clean = repo.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(clean)) {
    throw new GithubApiError("仓库格式应为 owner/repo", 400);
  }
  return clean;
}

/** Returns the branch list and the repo metadata (default branch, write access). */
export async function listGithubBranches(token: string, repo: string, env: Env): Promise<BranchListResult> {
  const full = assertRepo(repo);
  const meta = await ghGet(env, token, `/repos/${full}`);
  const info = meta.body || {};

  const branches: GithubBranchSummary[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (let page = 1; page <= 3; page++) {
    const { body } = await ghGet(env, token, `/repos/${full}/branches?per_page=100&page=${page}`);
    const rows: any[] = Array.isArray(body) ? body : [];
    for (const row of rows) {
      const name = String(row?.name || "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      branches.push({ name, protected: !!row?.protected });
    }
    if (rows.length < 100) break;
    if (page === 3) truncated = true;
  }

  return {
    repo: full,
    full_name: String(info.full_name || full),
    default_branch: String(info.default_branch || "main"),
    private: !!info.private,
    push: info?.permissions?.push !== false,
    branches,
    truncated,
  };
}
