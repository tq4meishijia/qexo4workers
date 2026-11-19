/**
 * Content domain: posts / drafts / pages / config files on top of a VCS
 * provider. Mirrors hexoweb/libs/platforms/core.py + functions.py behaviour.
 */

import YAML from "yaml";
import { HttpError, nowSec, type Env } from "./lib";
import { getPlatform, resolveSavePath, type PlatformConfig, type Section } from "./platforms";
import { Store, cacheDel, cacheGet, cacheSet } from "./store";
import { createProvider, type ProviderConfig, type TreeEntry, type VCSProvider } from "./vcs";

export type ContentKind = "post" | "draft" | "page" | "config";

const KIND_TO_SECTION: Record<ContentKind, keyof PlatformConfig> = {
  post: "posts",
  draft: "drafts",
  page: "pages",
  config: "configs",
};

/* ------------------------------------------------------------------ */
/* Abbrlink (byte-for-byte port of get_crc16 / get_crc32)              */
/* ------------------------------------------------------------------ */

export function crc16(input: string): number {
  let a = 0xffff;
  const b = 0xa001;
  for (let i = 0; i < input.length; i++) {
    a ^= input.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      const last = a % 2;
      a >>= 1;
      if (last === 1) a ^= b;
    }
  }
  const s = a.toString(16).padStart(4, "0");
  // Qexo concatenates the two hex bytes then parses them back as an integer.
  return parseInt(s.slice(0, 2) + s.slice(2, 4), 16);
}

let CRC_TABLE: number[] | null = null;
export function crc32(input: string): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  const bytes = new TextEncoder().encode(input);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function abbrlink(alg: string, rep: string, seed = String(nowSec())): string {
  const normalized = seed.replace(/\./g, "0");
  if (alg === "crc32") return rep === "hex" ? crc32(normalized).toString(16) : String(crc32(normalized));
  if (alg === "crc16") return rep === "hex" ? crc16(normalized).toString(16) : String(crc16(normalized));
  return "";
}

/* ------------------------------------------------------------------ */
/* Front matter                                                       */
/* ------------------------------------------------------------------ */

export interface FrontMatterResult {
  data: Record<string, unknown>;
  body: string;
  hadFrontMatter: boolean;
}

export function parseFrontMatter(raw: string): FrontMatterResult {
  const text = raw.replace(/^\uFEFF/, "");
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end === -1) return { data: {}, body: text, hadFrontMatter: false };
    const head = text.slice(3, end).replace(/^\r?\n/, "");
    let body = text.slice(end + 4);
    body = body.replace(/^\r?\n/, "");
    let data: Record<string, unknown> = {};
    try {
      const parsed = YAML.parse(head, { logLevel: "silent" });
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
    } catch {
      data = {};
    }
    return { data, body, hadFrontMatter: true };
  }
  if (text.startsWith(";;;")) {
    const end = text.indexOf(";;;", 3);
    if (end === -1) return { data: {}, body: text, hadFrontMatter: false };
    const head = text.slice(3, end);
    const body = text.slice(end + 3).replace(/^\r?\n/, "");
    try {
      const parsed = JSON.parse(head);
      return { data: parsed && typeof parsed === "object" ? parsed : {}, body, hadFrontMatter: true };
    } catch {
      return { data: {}, body, hadFrontMatter: true };
    }
  }
  return { data: {}, body: text, hadFrontMatter: false };
}

export function serializeFrontMatter(data: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(data, { lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" });
  const head = yaml.endsWith("\n") ? yaml : yaml + "\n";
  return `---\n${head}---\n${body.startsWith("\n") ? body.slice(1) : body}`;
}

/** Replaces the three template variables Qexo supports inside front matter. */
export function expandFrontMatterTemplate(raw: string, alg: string, rep: string): string {
  const link = abbrlink(alg, rep);
  const iso = new Date().toISOString();
  return raw.replace(/\{\{\s*date\s*\}\}/g, iso).replace(/\{\{\s*abbrlink\s*\}\}/g, link).replace(/\{\{\s*slug\s*\}\}/g, link);
}

export function excerptOf(content: string, length = 200): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_~\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > length ? plain.slice(0, length) + "..." : plain;
}

/* ------------------------------------------------------------------ */
/* Service                                                            */
/* ------------------------------------------------------------------ */

export interface PostListItem {
  name: string;
  fullname: string;
  path: string;
  size: number;
  status: boolean;
  date?: number;
  title?: string;
}

interface IndexRow {
  path: string;
  name: string;
  filename: string;
  size: number;
  status: number;
  date: number;
  title: string;
}

const TREE_TTL = 30;

export class ContentService {
  readonly provider: VCSProvider;
  readonly platform: PlatformConfig;
  private providerCfg: ProviderConfig;

  constructor(private env: Env, private store: Store, cfg: ProviderConfig) {
    this.providerCfg = cfg;
    this.provider = createProvider(cfg, env);
    this.platform = getPlatform(cfg.params.config);
  }

  static async create(env: Env, store: Store): Promise<ContentService> {
    const cfg = await store.getJSON<ProviderConfig>("PROVIDER", { provider: "", params: {} });
    if (!cfg || !cfg.provider) throw new HttpError("尚未配置内容源，请先在设置中完成 Provider 配置", 400);
    return new ContentService(env, store, cfg);
  }

  /* ---------------- tree ---------------- */

  async tree(refresh = false): Promise<TreeEntry[]> {
    if (!refresh) {
      const cached = await cacheGet(this.env, "vcs:tree", TREE_TTL);
      if (cached) {
        try {
          return JSON.parse(cached) as TreeEntry[];
        } catch {
          /* ignore */
        }
      }
    }
    const tree = await this.provider.listTree();
    await cacheSet(this.env, "vcs:tree", JSON.stringify(tree));
    return tree;
  }

  private sectionItems(tree: TreeEntry[], kind: ContentKind): PostListItem[] {
    const section = this.platform[KIND_TO_SECTION[kind]] as Section;
    const out: PostListItem[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < section.path.length; i++) {
      const base = (section.path[i] || "").replace(/^\/+|\/+$/g, "");
      const depth = section.depth[i] ?? -1;
      for (const entry of tree) {
        if (entry.type !== "file") continue;
        if (base && !entry.path.startsWith(base + "/")) continue;
        const rel = base ? entry.path.slice(base.length + 1) : entry.path;
        if (!rel) continue;
        if (depth >= 0 && rel.split("/").length - 1 > depth) continue;
        if (section.excludes?.length) {
          const segments = entry.path.split("/");
          if (section.excludes.some((ex) => segments.includes(ex))) continue;
        }
        const ext = section.type.find((t) => rel.endsWith(t));
        if (!ext) continue;
        const name = rel.slice(0, -ext.length);
        if (kind === "post" || kind === "draft") {
          if (seen.has(name)) continue;
          seen.add(name);
        }
        out.push({
          name,
          fullname: rel,
          path: entry.path,
          size: entry.size || 0,
          status: kind !== "draft",
        });
      }
    }
    return out;
  }

  /** Rebuilds the D1 index from the VCS tree. One API call, then one batch. */
  async refreshIndex(): Promise<{ posts: number; drafts: number; pages: number; configs: number }> {
    const tree = await this.tree(true);
    const kinds: ContentKind[] = ["post", "draft", "page", "config"];
    const counts = { posts: 0, drafts: 0, pages: 0, configs: 0 };
    const stmts: D1PreparedStatement[] = [];
    for (const kind of kinds) {
      const items = this.sectionItems(tree, kind);
      const keep = new Set(items.map((i) => i.path));
      const existing = await this.env.DB.prepare("SELECT path FROM content_index WHERE kind = ?")
        .bind(kind)
        .all<{ path: string }>();
      for (const row of existing.results || []) {
        if (!keep.has(row.path)) {
          stmts.push(this.env.DB.prepare("DELETE FROM content_index WHERE kind = ? AND path = ?").bind(kind, row.path));
        }
      }
      for (const item of items) {
        stmts.push(
          this.env.DB.prepare(
            "INSERT INTO content_index (kind, path, name, filename, size, status, date, title, front_matter, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, 0, '', '{}', ?) " +
              "ON CONFLICT(kind, path) DO UPDATE SET name=excluded.name, filename=excluded.filename, size=excluded.size, status=excluded.status",
          ).bind(kind, item.path, item.name, item.fullname, item.size, item.status ? 1 : 0, nowSec()),
        );
      }
      if (kind === "post") counts.posts = items.length;
      if (kind === "draft") counts.drafts = items.length;
      if (kind === "page") counts.pages = items.length;
      if (kind === "config") counts.configs = items.length;
    }
    if (stmts.length) await this.env.DB.batch(stmts);
    return counts;
  }

  private async indexed(kind: ContentKind, tree?: TreeEntry[] | null): Promise<PostListItem[]> {
    const select = () =>
      this.env.DB.prepare(
        "SELECT path, name, filename, size, status, date, title FROM content_index WHERE kind = ? ORDER BY date DESC, name ASC",
      )
        .bind(kind)
        .all<IndexRow>();

    let { results } = await select();
    if (!results || results.length === 0) {
      await this.refreshIndex();
      results = (await select()).results;
    }
    const rows = results || [];
    if (rows.length === 0) return [];

    // The D1 index can outlive the repository (a draft removed or published
    // outside this Worker). Drop rows whose file is gone so the list never
    // offers an entry that would 404 when published.
    if (tree) {
      const files = new Set(tree.filter((e) => e.type === "file").map((e) => e.path));
      const stale = rows.filter((r) => !files.has(r.path));
      if (stale.length) {
        await this.env.DB.batch(
          stale.map((r) =>
            this.env.DB.prepare("DELETE FROM content_index WHERE kind = ? AND path = ?").bind(kind, r.path),
          ),
        );
      }
      return rows
        .filter((r) => files.has(r.path))
        .map((r) => ({
          name: r.name,
          fullname: r.filename,
          path: r.path,
          size: r.size,
          status: r.status === 1,
          date: r.date,
          title: r.title,
        }));
    }
    return rows.map((r) => ({
      name: r.name,
      fullname: r.filename,
      path: r.path,
      size: r.size,
      status: r.status === 1,
      date: r.date,
      title: r.title,
    }));
  }

  async listPosts(search = ""): Promise<PostListItem[]> {
    const tree = await this.tree().catch(() => null);
    const [published, drafts] = await Promise.all([this.indexed("post", tree), this.indexed("draft", tree)]);
    let items = [...published, ...drafts];
    if (search) {
      const q = search.toUpperCase();
      items = items.filter((i) => i.name.toUpperCase().includes(q));
    }
    return items;
  }

  async listPages(search = ""): Promise<PostListItem[]> {
    const tree = await this.tree().catch(() => null);
    let items = await this.indexed("page", tree);
    if (search) {
      const q = search.toUpperCase();
      items = items.filter((i) => i.name.toUpperCase().includes(q));
    }
    return items;
  }

  async listConfigs(search = ""): Promise<PostListItem[]> {
    let items = await this.indexed("config");
    if (search) {
      const q = search.toUpperCase();
      items = items.filter((i) => i.name.toUpperCase().includes(q));
    }
    return items;
  }

  async counts() {
    const row = await this.env.DB.prepare(
      "SELECT kind, COUNT(*) AS n FROM content_index GROUP BY kind",
    ).all<{ kind: string; n: number }>();
    const out: Record<string, number> = { post: 0, draft: 0, page: 0, config: 0 };
    for (const r of row.results || []) out[r.kind] = r.n;
    return out;
  }

  /* ---------------- read ---------------- */

  async getFileRaw(path: string): Promise<string> {
    const cacheName = `file:${path}`;
    const cached = await cacheGet(this.env, cacheName, 20);
    if (cached !== null) return cached;
    const raw = await this.provider.getFile(path);
    await cacheSet(this.env, cacheName, raw);
    return raw;
  }

  async readPost(path: string): Promise<{ front_matter: Record<string, unknown>; content: string; title: string }> {
    const raw = await this.getFileRaw(path);
    const alg = await this.store.get("ABBRLINK_ALG", "crc16");
    const rep = await this.store.get("ABBRLINK_REP", "dec");
    const parsed = parseFrontMatter(expandFrontMatterTemplate(raw, alg, rep));
    const title = String(parsed.data.title || path.split("/").pop()?.replace(/\.[^.]+$/, "") || "未命名");
    return { front_matter: parsed.data, content: parsed.body, title };
  }

  /* ---------------- write ---------------- */

  private async targetFor(kind: ContentKind, name: string): Promise<string> {
    const section = this.platform[KIND_TO_SECTION[kind]] as Section;
    if (!section.save_path) throw new HttpError(kind === "draft" ? "当前配置不支持草稿" : "当前配置不支持此操作", 400);
    return resolveSavePath(section.save_path, name);
  }

  private async putFile(path: string, content: string, message: string): Promise<void> {
    await this.provider.putFile(path, content, message);
    await this.invalidate(path);
  }

  private async invalidate(path: string): Promise<void> {
    await cacheDel(this.env, "vcs:");
    await cacheDel(this.env, `file:${path}`);
    await cacheDel(this.env, "list:");
  }

  async savePost(
    name: string,
    content: string,
    frontMatter: Record<string, unknown>,
    path: string | undefined,
    status: boolean,
    autobuild = true,
  ): Promise<{ path: string; deployed: boolean }> {
    const payload = serializeFrontMatter(frontMatter, content);
    const published = await this.targetFor("post", name);
    const draft = this.platform.drafts.save_path ? await this.targetFor("draft", name) : null;

    let target = status ? published : draft;
    if (!target) throw new HttpError("当前配置不支持草稿", 400);
    if (path && path !== published && path !== draft) target = path;

    if (status && draft) {
      await this.provider.deleteFile(draft, `Delete Post Draft ${draft} by Qexo`).catch(() => undefined);
    }
    await this.provider.putFile(target, payload, `Save Post ${name} by Qexo`);
    await this.invalidate(target);
    if (draft && status) await this.invalidate(draft);

    const fmDate = frontMatter.date ? Date.parse(String(frontMatter.date)) / 1000 : NaN;
    await this.upsertIndex(status ? "post" : "draft", target, name, name, Number.isFinite(fmDate) ? fmDate : nowSec(), frontMatter);
    if (status && draft) await this.removeIndex("draft", draft);
    if (!status && published && path && path !== published) await this.removeIndex("post", path);

    const deployed = autobuild ? await this.maybeDeploy(`Save Post ${name}`) : false;
    return { path: target, deployed };
  }

  async savePage(path: string, content: string, frontMatter: Record<string, unknown>, autobuild = true) {
    const payload = serializeFrontMatter(frontMatter, content);
    await this.provider.putFile(path, payload, `Update Page ${path} by Qexo`);
    await this.invalidate(path);
    const fmDate = frontMatter.date ? Date.parse(String(frontMatter.date)) / 1000 : NaN;
    await this.upsertIndex("page", path, path.replace(/\.[^.]+$/, ""), path, Number.isFinite(fmDate) ? fmDate : nowSec(), frontMatter);
    const deployed = autobuild ? await this.maybeDeploy(`Update Page ${path}`) : false;
    return { path, deployed };
  }

  async newPost(name: string): Promise<{ path: string }> {
    const scaffold = await this.scaffold("draft");
    const path = await this.targetFor("draft", name);
    await this.provider.putFile(path, scaffold, `Create Draft ${name} by Qexo`);
    await this.invalidate(path);
    await this.upsertIndex("draft", path, name, name, nowSec(), {});
    return { path };
  }

  async newPage(name: string): Promise<{ path: string }> {
    const scaffold = await this.scaffold("page");
    const path = resolveSavePath(this.platform.pages.save_path || "source/${filename}.md", name);
    await this.provider.putFile(path, scaffold, `Create Page ${name} by Qexo`);
    await this.invalidate(path);
    await this.upsertIndex("page", path, name, path, nowSec(), {});
    return { path };
  }

  private async scaffold(kind: "post" | "draft" | "page"): Promise<string> {
    const section = this.platform[kind === "page" ? "pages" : kind === "draft" ? "drafts" : "posts"] as Section;
    if (!section.scaffold) return "";
    try {
      return await this.provider.getFile(section.scaffold);
    } catch {
      return "";
    }
  }

  /** Finds a post/draft by logical name in the live tree (ignores the cache). */
  private async findByName(kind: "post" | "draft", name: string): Promise<string | null> {
    try {
      const items = this.sectionItems(await this.tree(true), kind);
      // `name` keeps the relative sub-directory ("archive/moved-test"), so an
      // exact match is tried first and a basename match second.
      return (
        items.find((i) => i.name === name)?.path ||
        items.find((i) => basenameNoExt(i.path) === name)?.path ||
        null
      );
    } catch {
      return null;
    }
  }

  /** Writes the row for the new location and drops the row for the old one. */
  private async reindex(
    target: string,
    stalePath: string,
    name: string,
    kind: "post" | "draft",
    raw: string,
  ): Promise<void> {
    const parsed = parseFrontMatter(raw);
    await this.upsertIndex(kind, target, name, name, nowSec(), parsed.data);
    await this.removeIndex(kind === "post" ? "draft" : "post", stalePath);
  }

  async publish(path: string): Promise<{ path: string; already?: boolean }> {
    const name = basenameNoExt(path);
    const target = await this.targetFor("post", name);
    let source = path;
    let raw: string;
    try {
      raw = await this.provider.getFile(source);
    } catch {
      // The index can outlive its file: the draft may already have been
      // published, or deleted/renamed straight on GitHub. Resolve both cases
      // instead of leaking a raw 404 to the UI.
      const published = await this.provider.getFile(target).catch(() => null);
      if (published !== null) {
        await this.reindex(target, path, name, "post", published);
        await this.invalidate(target);
        return { path: target, already: true };
      }
      const relocated = await this.findByName("draft", name);
      if (!relocated) {
        throw new HttpError(
          `草稿不存在：${path}。文章索引可能已过期，请回到文章列表点击「刷新索引」后重试。`,
          404,
        );
      }
      source = relocated;
      raw = await this.provider.getFile(source);
    }

    await this.provider.putFile(target, raw, `Publish Post ${name} by Qexo`);
    await this.provider.deleteFile(source, `Delete Draft ${source} by Qexo`).catch(() => undefined);
    await this.invalidate(source);
    await this.invalidate(target);
    await this.reindex(target, source, name, "post", raw);
    await this.maybeDeploy(`Publish Post ${name}`);
    return { path: target };
  }

  async unpublish(path: string): Promise<{ path: string; already?: boolean }> {
    const name = basenameNoExt(path);
    const target = await this.targetFor("draft", name);
    let source = path;
    let raw: string;
    try {
      raw = await this.provider.getFile(source);
    } catch {
      const existing = await this.provider.getFile(target).catch(() => null);
      if (existing !== null) {
        await this.reindex(target, path, name, "draft", existing);
        await this.invalidate(target);
        return { path: target, already: true };
      }
      const relocated = await this.findByName("post", name);
      if (!relocated) {
        throw new HttpError(
          `文章不存在：${path}。文章索引可能已过期，请回到文章列表点击「刷新索引」后重试。`,
          404,
        );
      }
      source = relocated;
      raw = await this.provider.getFile(source);
    }

    await this.provider.putFile(target, raw, `Unpublish Post ${name} by Qexo`);
    await this.provider.deleteFile(source, `Delete Post ${source} by Qexo`).catch(() => undefined);
    await this.invalidate(source);
    await this.invalidate(target);
    await this.reindex(target, source, name, "draft", raw);
    await this.maybeDeploy(`Unpublish Post ${name}`);
    return { path: target };
  }

  async rename(oldPath: string, newPath: string): Promise<boolean> {
    if (oldPath === newPath) return false;
    const raw = await this.provider.getFile(oldPath);
    await this.provider.putFile(newPath, raw, `Rename ${oldPath} to ${newPath} by Qexo`);
    await this.provider.deleteFile(oldPath, `Rename ${oldPath} to ${newPath} by Qexo`);
    await this.invalidate(oldPath);
    await this.invalidate(newPath);
    await this.env.DB.prepare("DELETE FROM content_index WHERE path IN (?, ?)").bind(oldPath, newPath).run();
    await this.refreshIndex();
    await this.maybeDeploy(`Rename ${oldPath}`);
    return true;
  }

  async delete(path: string): Promise<boolean> {
    // D1 索引可能残留而仓库文件已被删除（大正文写入异常，或 GitHub 侧直接改删）。
    // 这种情况删除应幂等成功：清掉索引即可，不应因仓库 404 报错阻断用户。
    try {
      await this.provider.deleteFile(path, `Delete ${path} by Qexo`);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
    }
    await this.invalidate(path);
    await this.env.DB.prepare("DELETE FROM content_index WHERE path = ?").bind(path).run();
    await this.maybeDeploy(`Delete ${path}`);
    return true;
  }

  async saveConfig(path: string, content: string): Promise<void> {
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (ext === ".yml" || ext === ".yaml") {
      try {
        YAML.parse(content);
      } catch (e: any) {
        throw new HttpError(`YAML 解析失败: ${e?.message || e}`, 400);
      }
    } else if (ext === ".json") {
      try {
        JSON.parse(content);
      } catch (e: any) {
        throw new HttpError(`JSON 解析失败: ${e?.message || e}`, 400);
      }
    }
    await this.provider.putFile(path, content, `Update ${path} by Qexo`);
    await this.invalidate(path);
    await this.maybeDeploy(`Update ${path}`);
  }

  private async upsertIndex(
    kind: ContentKind,
    path: string,
    name: string,
    filename: string,
    date: number,
    fm: Record<string, unknown>,
  ): Promise<void> {
    const title = String(fm.title || name || "未命名");
    await this.env.DB.prepare(
      "INSERT INTO content_index (kind, path, name, filename, size, status, date, title, front_matter, updated_at) " +
        "VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(kind, path) DO UPDATE SET name=excluded.name, filename=excluded.filename, status=excluded.status, date=excluded.date, title=excluded.title, front_matter=excluded.front_matter, updated_at=excluded.updated_at",
    )
      .bind(kind, path, name, filename, kind === "draft" ? 0 : 1, date, title, JSON.stringify(fm), nowSec())
      .run();
  }

  private async removeIndex(kind: ContentKind, path: string): Promise<void> {
    await this.env.DB.prepare("DELETE FROM content_index WHERE kind = ? AND path = ?").bind(kind, path).run();
  }

  /* ---------------- verification ---------------- */

  async verify(): Promise<{
    status: number;
    hexo?: string;
    config_hexo?: string | boolean;
    indexhtml?: number;
    source?: number;
    theme_dir?: number;
    package?: string | boolean;
  }> {
    const root = await this.provider.listDir("");
    let indexhtml = 0;
    let source = 0;
    let themeDir = 0;
    let pkg = "" as string | boolean;
    let configHexo = "" as string | boolean;
    for (const item of root) {
      if (item.path === "index.html" && item.type === "file") indexhtml = 1;
      if (item.path === "source" && item.type === "dir") source = 1;
      if (item.path === "themes" && item.type === "dir") themeDir = 1;
      if (item.path === "package.json" && item.type === "file") pkg = "package.json";
      if (item.path === "_config.yml" && item.type === "file") configHexo = "_config.yml";
    }
    let hexo = "";
    if (pkg) {
      try {
        const data = JSON.parse(await this.provider.getFile("package.json"));
        hexo = data?.dependencies?.hexo || data?.hexo?.version || "";
      } catch {
        /* ignore */
      }
    }
    const status = hexo && configHexo && !indexhtml && source && pkg ? 1 : 0;
    return {
      status,
      hexo,
      config_hexo: configHexo,
      indexhtml,
      source,
      theme_dir: themeDir,
      package: pkg,
    };
  }

  /* ---------------- deploy hook ---------------- */

  private async maybeDeploy(reason: string): Promise<boolean> {
    const kind = await this.store.get("DEPLOY_KIND");
    const hook = await this.store.get("DEPLOY_WEBHOOK");
    if (!kind || !hook) return false;
    try {
      let url = hook;
      let body: Record<string, unknown> | undefined;
      if (kind === "github-actions") {
        const repo = await this.store.get("DEPLOY_REPO");
        const workflow = await this.store.get("DEPLOY_WORKFLOW");
        const ref = await this.store.get("DEPLOY_REF", "main");
        const token = await this.store.get("DEPLOY_TOKEN");
        url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;
        body = { ref, inputs: {} };
        await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "qexo-workers",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } else {
        await fetch(url, { method: "POST", body: JSON.stringify({ reason }) });
      }
      await this.env.DB.prepare("INSERT INTO deploy_logs (id, time, target, status, message) VALUES (?, ?, ?, 1, ?)")
        .bind(crypto.randomUUID(), Date.now() / 1000, kind, reason)
        .run();
      return true;
    } catch (e: any) {
      await this.env.DB.prepare("INSERT INTO deploy_logs (id, time, target, status, message) VALUES (?, ?, ?, 0, ?)")
        .bind(crypto.randomUUID(), Date.now() / 1000, kind, `${reason}: ${e?.message || e}`)
        .run();
      return false;
    }
  }
}

function basenameNoExt(path: string): string {
  const base = path.split("/").pop() || path;
  return base.replace(/\.[^.]+$/, "");
}
