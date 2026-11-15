/**
 * Settings / cache / i18n storage layer.
 *
 * Settings live in D1 (source of truth) with a short-lived per-isolate cache so
 * that a request does not issue a query per setting. Writes bump a version row
 * and clear the local cache; other isolates converge within the TTL.
 */

import type { Env } from "./lib";
import { nowSec } from "./lib";

export const QEXO_VERSION = "1.1.0";
export const QEXO_STATIC = "4.0.1";

export const DEFAULT_SETTINGS: Record<string, string> = {
  ABBRLINK_ALG: "crc16",
  ABBRLINK_REP: "dec",
  CDN_PREV: "https://unpkg.com/qexo-static@{version}/qexo",
  INIT: "2",
  QEXO_ICON: "https://unpkg.com/qexo-static@4.0.1/qexo/images/icon.png",
  QEXO_LOGO: "https://unpkg.com/qexo-static@4.0.1/qexo/images/qexo.png",
  QEXO_LOGO_DARK: "https://unpkg.com/qexo-static@4.0.1/qexo/images/qexo-dark.png",
  QEXO_NAME: "博客管理面板",
  QEXO_SPLIT: "-",
  VDITOR_EMOJI: "{}",
  WEBHOOK_APIKEY: "",
  VERCEL_TOKEN: "",
  PROJECT_ID: "",
  ALLOW_FRIEND: "否",
  LAST_LOGIN: "",
  IMG_HOST: '{"type":"关闭","params":{}}',
  ONEPUSH: "",
  PROVIDER: "",
  STATISTIC_ALLOW: "否",
  STATISTIC_DOMAINS: "",
  FRIEND_RECAPTCHA: "否",
  RECAPTCHA_TOKEN: "",
  LOGIN_RECAPTCHA_SITE_TOKEN: "",
  LOGIN_RECAPTCHA_SERVER_TOKEN: "",
  LOGIN_RECAPTCHAV2_SITE_TOKEN: "",
  LOGIN_RECAPTCHAV2_SERVER_TOKEN: "",
  POST_SIDEBAR:
    '[{"search":"title","name":"标题","icon":"fas fa-heading"},{"search":"abbrlink","name":"缩写","icon":"fas fa-id-card"},{"search":"date","name":"发布于","icon":"fas fa-globe-americas"},{"search":"updated","name":"更新于","icon":"fas fa-calendar-alt"},{"search":"tags","name":"标签","icon":"fas fa-tags"},{"search":"categories","name":"分类","icon":"fas fa-folder-open"}]',
  PAGE_SIDEBAR:
    '[{"search":"title","name":"标题","icon":"fas fa-heading"},{"search":"date","name":"发布于","icon":"fas fa-globe-americas"},{"search":"updated","name":"更新于","icon":"fas fa-calendar-alt"}]',
  TALK_SIDEBAR: "[]",
  ALL_CDN_PREV:
    '[{"name":"CNPM(国内)","url":"https://registry.npmmirror.com/qexo-static/{version}/files/qexo"},{"name":"Jsdelivr(国际)","url":"https://cdn.jsdelivr.net/npm/qexo-static@{version}/qexo"},{"name":"Unpkg(国际)","url":"https://unpkg.com/qexo-static@{version}/qexo"}]',
  ALL_UPDATES:
    '[{"name":"master","url":"https://github.com/Qexo/Qexo/tarball/master/"},{"name":"dev","url":"https://github.com/Qexo/Qexo/tarball/dev/"}]',
  UPDATE_FROM: "false",
  JUMP_UPDATE: "false",
  AUTO_EXCERPT_CONFIG:
    '{"method":"本地","auto":"关闭","save_key":"excerpt","params":{"save_key":"excerpt","length":"200"}}',
  LANGUAGE: "zh_CN",
  DEPLOY_KIND: "",
  DEPLOY_WEBHOOK: "",
  DEPLOY_TOKEN: "",
  DEPLOY_REPO: "",
  DEPLOY_WORKFLOW: "",
  DEPLOY_REF: "main",
  MCP_TOKENS: "[]",
  MCP_ENABLED: "是",
  DEFAULT_ADMIN_PASSWORD: "0",
};

interface MemEntry {
  value: string;
  at: number;
}

const MEM = new Map<string, MemEntry>();
const MEM_TTL = 15; // seconds

let defaultsReady = false;

export class Store {
  constructor(private env: Env) {}

  private async ensureDefaults(): Promise<void> {
    if (defaultsReady) return;
    const stmts = Object.entries(DEFAULT_SETTINGS).map(([name, content]) =>
      this.env.DB.prepare("INSERT OR IGNORE INTO settings (name, content, updated_at) VALUES (?, ?, ?)").bind(
        name,
        content,
        nowSec(),
      ),
    );
    await this.env.DB.batch(stmts);
    defaultsReady = true;
  }

  async all(): Promise<Record<string, string>> {
    await this.ensureDefaults();
    const { results } = await this.env.DB.prepare("SELECT name, content FROM settings").all<{ name: string; content: string }>();
    const out: Record<string, string> = {};
    for (const row of results || []) out[row.name] = row.content;
    return out;
  }

  async get(name: string, fallback = ""): Promise<string> {
    const hit = MEM.get(name);
    if (hit && nowSec() - hit.at < MEM_TTL) return hit.value || fallback;
    const row = await this.env.DB.prepare("SELECT content FROM settings WHERE name = ?").bind(name).first<{
      content: string;
    }>();
    const value = row?.content ?? "";
    MEM.set(name, { value, at: nowSec() });
    return value || fallback;
  }

  async getJSON<T = unknown>(name: string, fallback: T): Promise<T> {
    const raw = await this.get(name);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  async set(name: string, content: string): Promise<void> {
    const value = content ?? "";
    await this.env.DB.prepare(
      "INSERT INTO settings (name, content, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
    )
      .bind(name, value, nowSec())
      .run();
    MEM.set(name, { value, at: nowSec() });
  }

  async setMany(values: Record<string, string>): Promise<void> {
    const stmts = Object.entries(values).map(([name, content]) =>
      this.env.DB.prepare(
        "INSERT INTO settings (name, content, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
      ).bind(name, content ?? "", nowSec()),
    );
    await this.env.DB.batch(stmts);
    for (const [k, v] of Object.entries(values)) MEM.set(k, { value: v ?? "", at: nowSec() });
  }

  invalidate(): void {
    MEM.clear();
  }
}

/* ------------------------------------------------------------------ */
/* D1-backed cache (survives isolates; used for VCS tree snapshots)    */
/* ------------------------------------------------------------------ */

export async function cacheGet(env: Env, name: string, ttl = 30): Promise<string | null> {
  const row = await env.DB.prepare("SELECT content, updated_at FROM cache WHERE name = ?").bind(name).first<{
    content: string;
    updated_at: number;
  }>();
  if (!row) return null;
  if (ttl > 0 && nowSec() - row.updated_at > ttl) return null;
  return row.content;
}

export async function cacheSet(env: Env, name: string, content: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO cache (name, content, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
  )
    .bind(name, content, nowSec())
    .run();
}

export async function cacheDel(env: Env, prefix = ""): Promise<void> {
  if (prefix) {
    await env.DB.prepare("DELETE FROM cache WHERE name LIKE ?").bind(prefix + "%").run();
  } else {
    await env.DB.prepare("DELETE FROM cache").run();
  }
}

/** Mirrors Qexo's delete_all_caches(): keeps nothing, clears settings memo too. */
export async function purgeAllCaches(env: Env): Promise<void> {
  await cacheDel(env);
  new Store(env).invalidate();
}

/* ------------------------------------------------------------------ */
/* i18n                                                               */
/* ------------------------------------------------------------------ */

export const LANGUAGES = ["zh_CN", "zh_TW", "en_US", "en_UK", "ja_JP", "ko_KR", "fr_FR"] as const;

const LOCALES = new Map<string, Record<string, string>>();
const LANG_NAMES: Record<string, string> = {
  zh_CN: "中文(简体)",
  zh_TW: "中文(繁體)",
  en_US: "English(US)",
  en_UK: "English(UK)",
  ja_JP: "日本語",
  ko_KR: "한국어",
  fr_FR: "Français",
};

export async function loadLocale(env: Env, lang: string): Promise<Record<string, string>> {
  const key = LANGUAGES.includes(lang as any) ? lang : "zh_CN";
  const hit = LOCALES.get(key);
  if (hit) return hit;
  try {
    const res = await env.ASSETS.fetch(new Request(`https://assets.local/locales/${key}.json`));
    if (res.ok) {
      const data = (await res.json()) as { data?: Record<string, string> };
      const dict = data.data || {};
      LOCALES.set(key, dict);
      return dict;
    }
  } catch {
    // fall through
  }
  return {};
}

export function makeT(dict: Record<string, string>) {
  return (key: string, ...args: unknown[]): string => {
    let template = dict[key] ?? key;
    for (const arg of args) template = template.replace("{}", String(arg));
    return template;
  };
}

export async function translator(env: Env, store: Store) {
  const lang = await store.get("LANGUAGE", "zh_CN");
  return makeT(await loadLocale(env, lang));
}

export function languageList(): { code: string; name: string }[] {
  return LANGUAGES.map((code) => ({ code, name: LANG_NAMES[code] || code }));
}
