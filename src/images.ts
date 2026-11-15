/**
 * Image hosts. Qexo shipped 8 providers; the ones that need raw TCP or vendor
 * SDKs (FTP / Upyun / DogeCloud) cannot run on Workers and are intentionally
 * replaced by R2 + S3-compatible + custom HTTP hosts.
 */

import { HttpError, b64encode, hex, utf8ToB64, type Env } from "./lib";
import { guessContentType, type ProviderConfig, type ProviderParams } from "./vcs";
import { Store } from "./store";

export interface UploadResult {
  url: string;
  deleteConfig: Record<string, unknown>;
}

export interface ImageHost {
  upload(file: File, bytes: Uint8Array): Promise<UploadResult>;
  remove?(config: Record<string, unknown>): Promise<string>;
}

/**
 * Standalone image-host option: writes into the content-source repository and
 * reuses its credentials. Existing hosts keep their own parameter sets.
 */
export const CONTENT_SOURCE_IMAGE_HOST = "GitHub 内容源";
export const DEFAULT_IMAGE_DIR = "img-qexo";
export const DEFAULT_CDN_PRESET = "raw";

/** `{repo}` is owner/repo, `{branch}` is the content-source branch. */
export const GITHUB_CDN_PRESETS = [
  { id: "raw", label: "GitHub 原始 raw（默认）", template: "https://raw.githubusercontent.com/{repo}/{branch}" },
  { id: "jsdelivr", label: "jsDelivr（国际）", template: "https://cdn.jsdelivr.net/gh/{repo}@{branch}" },
  { id: "jsdelivr-fastly", label: "jsDelivr Fastly", template: "https://fastly.jsdelivr.net/gh/{repo}@{branch}" },
  { id: "jsdelivr-gcore", label: "jsDelivr Gcore", template: "https://gcore.jsdelivr.net/gh/{repo}@{branch}" },
  { id: "statically", label: "Statically", template: "https://cdn.statically.io/gh/{repo}/{branch}" },
  { id: "gitmirror", label: "GitMirror 镜像", template: "https://raw.gitmirror.com/{repo}/{branch}" },
];

export const IMAGE_HOSTS = ["关闭", "R2", "GitHub", CONTENT_SOURCE_IMAGE_HOST, "S3", "Custom"] as const;

export interface ImageHostParamDef {
  description: string;
  placeholder: string;
  options?: { value: string; label: string; template?: string }[];
}

export const IMAGE_HOST_PARAMS: Record<string, Record<string, ImageHostParamDef>> = {
  R2: {
    public_base: { description: "公开访问前缀", placeholder: "留空则使用本站 /api/images/file" },
  },
  GitHub: {
    token: { description: "GitHub 密钥", placeholder: "ghp_xxx" },
    repo: { description: "仓库", placeholder: "username/repo" },
    branch: { description: "分支", placeholder: "main" },
    path: { description: "图片目录", placeholder: "source/images" },
    cdn: { description: "访问前缀", placeholder: "https://cdn.jsdelivr.net/gh/user/repo@main" },
  },
  [CONTENT_SOURCE_IMAGE_HOST]: {
    path: { description: "上传目录（内容源仓库根目录下）", placeholder: DEFAULT_IMAGE_DIR },
    cdn_preset: {
      description: "访问前缀（公共 CDN）",
      placeholder: "默认 GitHub 原始 raw",
      options: GITHUB_CDN_PRESETS.map((p) => ({ value: p.id, label: p.label, template: p.template })),
    },
    cdn_custom: {
      description: "自定义前缀（可选，优先级最高）",
      placeholder: "https://cdn.example.com/{repo}/{branch}",
    },
  },
  S3: {
    endpoint: { description: "Endpoint", placeholder: "s3.us-east-1.amazonaws.com" },
    bucket: { description: "Bucket", placeholder: "my-bucket" },
    region: { description: "Region", placeholder: "us-east-1" },
    access_key_id: { description: "AccessKeyId", placeholder: "AKIA..." },
    secret_access_key: { description: "SecretAccessKey", placeholder: "***" },
    path_style: { description: "Path style", placeholder: "true / false" },
    public_base: { description: "公开访问前缀", placeholder: "https://cdn.example.com" },
  },
  Custom: {
    endpoint: { description: "上传地址", placeholder: "https://img.example.com/upload" },
    field: { description: "文件字段名", placeholder: "file" },
    headers: { description: "附加请求头(JSON)", placeholder: '{"Authorization":"Bearer x"}' },
    url_path: { description: "响应 URL 路径", placeholder: "data.url" },
  },
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : ".bin";
}

function objectKey(name: string): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const rand = hex(crypto.getRandomValues(new Uint8Array(8)));
  return `images/${yyyy}/${mm}/${rand}${extOf(name)}`;
}

/** A custom prefix only wins when it is a well-formed http(s) URL without whitespace. */
export function normalizeCustomPrefix(value: string | undefined): string {
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

/** Precedence: valid custom prefix > selected preset > GitHub raw. */
export function resolveImageBase(params: ProviderParams, repo: string, branch: string): string {
  const chosen = params.cdn_preset || DEFAULT_CDN_PRESET;
  const preset = GITHUB_CDN_PRESETS.find((p) => p.id === chosen) || GITHUB_CDN_PRESETS[0];
  const template = normalizeCustomPrefix(params.cdn_custom) || preset.template;
  return template.replace(/\{repo\}/g, repo).replace(/\{branch\}/g, branch).replace(/\/+$/, "");
}

export function resolveImageDir(params: ProviderParams): string {
  return String(params.path || "").trim().replace(/^\/+|\/+$/g, "") || DEFAULT_IMAGE_DIR;
}

/* ------------------------------------------------------------------ */
/* R2                                                                 */
/* ------------------------------------------------------------------ */

class R2Host implements ImageHost {
  constructor(private env: Env, private params: ProviderParams) {}

  async upload(file: File, bytes: Uint8Array): Promise<UploadResult> {
    if (!this.env.R2) throw new HttpError("未绑定 R2 存储桶", 500);
    const key = objectKey(file.name);
    await this.env.R2.put(key, bytes, { httpMetadata: { contentType: file.type || guessContentType(key) } });
    const base = (this.params.public_base || "").replace(/\/+$/, "");
    const url = base ? `${base}/${key}` : `/api/images/file/${key}`;
    return { url, deleteConfig: { provider: "R2", key } };
  }

  async remove(config: Record<string, unknown>): Promise<string> {
    if (this.env.R2 && config.key) await this.env.R2.delete(String(config.key));
    return "已删除 R2 对象";
  }
}

/* ------------------------------------------------------------------ */
/* GitHub                                                             */
/* ------------------------------------------------------------------ */

class GitHubHost implements ImageHost {
  constructor(private params: ProviderParams) {}

  async upload(file: File, bytes: Uint8Array): Promise<UploadResult> {
    const repo = (this.params.repo || "").replace(/^\/+|\/+$/g, "");
    const branch = this.params.branch || "main";
    const dir = (this.params.path || "source/images").replace(/^\/+|\/+$/g, "");
    const key = `${dir}/${objectKey(file.name)}`;
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${key}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.params.token || ""}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "qexo-workers",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: `Upload ${file.name} by Qexo`, content: b64encode(bytes), branch }),
    });
    if (!res.ok) throw new HttpError(`GitHub 上传失败 ${res.status}: ${(await res.text()).slice(0, 200)}`, 502);
    const cdn = (this.params.cdn || "").replace(/\/+$/, "");
    const url = cdn ? `${cdn}/${key}` : `https://raw.githubusercontent.com/${repo}/${branch}/${key}`;
    return { url, deleteConfig: { provider: "GitHub", repo, branch, path: key, token: true } };
  }

  async remove(config: Record<string, unknown>): Promise<string> {
    const repo = String(config.repo || "");
    const path = String(config.path || "");
    const branch = String(config.branch || "main");
    const token = this.params.token || "";
    const head = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "qexo-workers" },
    });
    if (!head.ok) return "远程文件不存在";
    const meta: any = await head.json();
    const sha = meta?.sha;
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "qexo-workers",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: `Delete ${path} by Qexo`, sha, branch }),
    });
    return res.ok ? "已删除远程文件" : `删除失败 ${res.status}`;
  }
}

/* ------------------------------------------------------------------ */
/* Content-source GitHub (standalone image-host option)                */
/* ------------------------------------------------------------------ */

class ContentSourceGitHubHost implements ImageHost {
  constructor(private params: ProviderParams, private env: Env) {}

  /** Credentials always come from the saved provider, never from this form. */
  private async source(): Promise<{ token: string; repo: string; branch: string }> {
    const cfg = await new Store(this.env).getJSON<ProviderConfig>("PROVIDER", { provider: "", params: {} });
    if (cfg.provider !== "github") throw new HttpError("内容源不是 GitHub，无法使用「GitHub 内容源」图床", 400);
    const repo = String(cfg.params?.repo || "").trim();
    const branch = String(cfg.params?.branch || "").trim();
    const token = String(cfg.params?.token || "").trim();
    if (!repo || !branch) throw new HttpError("内容源仓库或分支未配置，请先在「设置 → 内容源」保存", 400);
    if (!token) throw new HttpError("内容源 GitHub 密钥为空，请先在「设置 → 内容源」配置", 400);
    return { token, repo, branch };
  }

  private apiBase(): string {
    return (this.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "qexo-workers",
      "Content-Type": "application/json",
    };
  }

  async upload(file: File, bytes: Uint8Array): Promise<UploadResult> {
    const { token, repo, branch } = await this.source();
    const key = `${resolveImageDir(this.params)}/${objectKey(file.name)}`;
    const res = await fetch(`${this.apiBase()}/repos/${repo}/contents/${key}`, {
      method: "PUT",
      headers: this.headers(token),
      body: JSON.stringify({ message: `Upload ${file.name} by Qexo`, content: b64encode(bytes), branch }),
    });
    if (!res.ok) throw new HttpError(`GitHub 上传失败 ${res.status}: ${(await res.text()).slice(0, 200)}`, 502);
    return {
      url: `${resolveImageBase(this.params, repo, branch)}/${key}`,
      deleteConfig: { provider: CONTENT_SOURCE_IMAGE_HOST, repo, branch, path: key },
    };
  }

  async remove(config: Record<string, unknown>): Promise<string> {
    const { token } = await this.source();
    const repo = String(config.repo || "");
    const branch = String(config.branch || "");
    const key = String(config.path || "");
    if (!repo || !key) return "删除信息不完整";
    const head = await fetch(`${this.apiBase()}/repos/${repo}/contents/${key}?ref=${encodeURIComponent(branch)}`, {
      headers: this.headers(token),
    });
    if (!head.ok) return "远程文件不存在";
    const meta: any = await head.json();
    const res = await fetch(`${this.apiBase()}/repos/${repo}/contents/${key}`, {
      method: "DELETE",
      headers: this.headers(token),
      body: JSON.stringify({ message: `Delete ${key} by Qexo`, sha: meta?.sha, branch }),
    });
    return res.ok ? "已删除远程文件" : `删除失败 ${res.status}`;
  }
}

/* ------------------------------------------------------------------ */
/* S3 compatible (AWS SigV4)                                          */
/* ------------------------------------------------------------------ */

class S3Host implements ImageHost {
  constructor(private params: ProviderParams) {}

  private async sign(key: Uint8Array | string, msg: string): Promise<Uint8Array> {
    const raw = typeof key === "string" ? new TextEncoder().encode(key) : key;
    const cryptoKey = await crypto.subtle.importKey("raw", raw as unknown as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(msg));
    return new Uint8Array(sig);
  }

  async upload(file: File, bytes: Uint8Array): Promise<UploadResult> {
    const endpoint = (this.params.endpoint || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const bucket = this.params.bucket || "";
    const region = this.params.region || "us-east-1";
    const accessKey = this.params.access_key_id || "";
    const secretKey = this.params.secret_access_key || "";
    const pathStyle = String(this.params.path_style || "false") === "true";
    const key = objectKey(file.name);
    const host = pathStyle ? endpoint : `${bucket}.${endpoint}`;
    const canonicalUri = pathStyle ? `/${bucket}/${key}` : `/${key}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = hex(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest)),
    )}`;
    let signingKey = await this.sign(`AWS4${secretKey}`, dateStamp);
    signingKey = await this.sign(signingKey, region);
    signingKey = await this.sign(signingKey, "s3");
    signingKey = await this.sign(signingKey, "aws4_request");
    const signature = hex(await this.sign(signingKey, stringToSign));

    const res = await fetch(`https://${host}${canonicalUri}`, {
      method: "PUT",
      headers: {
        Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        "Content-Type": file.type || guessContentType(key),
      },
      body: bytes as unknown as BodyInit,
    });
    if (!res.ok) throw new HttpError(`S3 上传失败 ${res.status}: ${(await res.text()).slice(0, 200)}`, 502);
    const base = (this.params.public_base || `https://${host}`).replace(/\/+$/, "");
    return { url: `${base}/${key}`, deleteConfig: { provider: "S3", key } };
  }
}

/* ------------------------------------------------------------------ */
/* Custom HTTP                                                        */
/* ------------------------------------------------------------------ */

class CustomHost implements ImageHost {
  constructor(private params: ProviderParams) {}

  async upload(file: File, bytes: Uint8Array): Promise<UploadResult> {
    const endpoint = this.params.endpoint || "";
    if (!endpoint) throw new HttpError("未配置上传地址", 400);
    const field = this.params.field || "file";
    const form = new FormData();
    form.append(field, new Blob([bytes as any], { type: file.type || "application/octet-stream" }), file.name);
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(this.params.headers || "{}");
    } catch {
      headers = {};
    }
    const res = await fetch(endpoint, { method: "POST", headers, body: form });
    const text = await res.text();
    if (!res.ok) throw new HttpError(`上传失败 ${res.status}: ${text.slice(0, 200)}`, 502);
    let url = "";
    try {
      const data = JSON.parse(text);
      const path = this.params.url_path || "data.url";
      url = path.split(".").reduce<any>((acc, k) => (acc == null ? acc : acc[k]), data);
    } catch {
      url = text.trim();
    }
    if (!url) throw new HttpError("响应中未找到图片 URL", 502);
    return { url: String(url), deleteConfig: { provider: "Custom" } };
  }
}

export function getImageHost(type: string, params: ProviderParams, env: Env): ImageHost {
  switch (type) {
    case "R2":
      return new R2Host(env, params);
    case "GitHub":
      return new GitHubHost(params);
    case CONTENT_SOURCE_IMAGE_HOST:
      return new ContentSourceGitHubHost(params, env);
    case "S3":
      return new S3Host(params);
    case "Custom":
      return new CustomHost(params);
    case "关闭":
    case "":
      throw new HttpError("图床功能已关闭，请先在设置中配置图床", 400);
    default:
      throw new HttpError(`不支持的图床类型: ${type}`, 400);
  }
}

export function randomImageName(original: string): string {
  return `${Date.now()}-${hex(crypto.getRandomValues(new Uint8Array(3)))}${extOf(original)}`;
}

export { utf8ToB64 };
