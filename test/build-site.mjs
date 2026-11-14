#!/usr/bin/env node
/**
 * "hexo-lite": a deterministic local stand-in for `hexo generate`.
 *
 * The real Pages pipeline runs Hexo (see docs/deploy.md). For the offline
 * acceptance run we only need to prove that whatever Qexo wrote to the Git
 * repository is buildable content: front matter parses, Markdown renders and
 * pages land in public/.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const repo = path.resolve(process.argv[2] || "test/out/repo");
const out = path.resolve(process.argv[3] || "test/out/public");

function walk(dir, base = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

function splitFrontMatter(raw) {
  if (!raw.startsWith("---")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: raw };
  const head = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  return { data: YAML.parse(head) || {}, body };
}

function inline(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function markdown(src) {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inCode = false;
  let list = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        html.push("</code></pre>");
        inCode = false;
      } else {
        html.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html.push(line.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "\n");
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!list) {
        html.push("<ul>");
        list = true;
      }
      html.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (list) {
      html.push("</ul>");
      list = false;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      html.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }
    if (!line.trim()) continue;
    html.push(`<p>${inline(line)}</p>`);
  }
  if (list) html.push("</ul>");
  if (inCode) html.push("</code></pre>");
  return html.join("\n");
}

function layout(title, body) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{max-width:760px;margin:40px auto;font:16px/1.7 system-ui;padding:0 16px;color:#222}
h1,h2,h3{line-height:1.3}code{background:#f2f4f7;padding:2px 5px;border-radius:4px}
pre{background:#0f172a;color:#e2e8f0;padding:14px;border-radius:8px;overflow:auto}
blockquote{border-left:3px solid #3b82f6;margin:0;padding:4px 14px;color:#555}</style></head>
<body>${body}</body></html>`;
}

if (!fs.existsSync(repo)) {
  console.error(`repo not found: ${repo}`);
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
// Incremental clean: only remove pages that disappeared since the last build.
// (Avoids deleting the whole tree, which is expensive and unnecessary.)
let previous = [];
try {
  previous = JSON.parse(fs.readFileSync(path.join(out, "build.json"), "utf8")).posts || [];
} catch {
  previous = [];
}

const postsDir = path.join(repo, "source/_posts");
const files = fs.existsSync(postsDir) ? walk(postsDir) : [];
const build = [];
const keep = new Set();

for (const rel of files.filter((f) => f.endsWith(".md"))) {
  const raw = fs.readFileSync(path.join(postsDir, rel), "utf8");
  const { data, body } = splitFrontMatter(raw);
  const slug = rel.replace(/\.md$/, "").replace(/\//g, "-");
  const title = String(data.title || slug);
  const page = layout(title, `<h1>${inline(title)}</h1><div class="meta">${data.date || ""}</div>${markdown(body)}`);
  fs.mkdirSync(path.join(out, "posts"), { recursive: true });
  fs.writeFileSync(path.join(out, "posts", `${slug}.html`), page);
  keep.add(slug);
  build.push({ slug, title, date: String(data.date || ""), tags: data.tags || [] });
}

for (const old of previous) {
  if (!keep.has(old.slug)) {
    const stale = path.join(out, "posts", `${old.slug}.html`);
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
  }
}

// Pages
const about = path.join(repo, "source/about/index.md");
if (fs.existsSync(about)) {
  const { data, body } = splitFrontMatter(fs.readFileSync(about, "utf8"));
  fs.mkdirSync(path.join(out, "about"), { recursive: true });
  fs.writeFileSync(path.join(out, "about", "index.html"), layout(String(data.title || "About"), `<h1>${inline(String(data.title || "About"))}</h1>${markdown(body)}`));
}

const indexBody = `<h1>${(YAML.parse(fs.readFileSync(path.join(repo, "_config.yml"), "utf8")) || {}).title || "Blog"}</h1>
<ul>${build.map((b) => `<li><a href="/posts/${b.slug}.html">${inline(b.title)}</a> <small>${b.date}</small></li>`).join("")}</ul>`;
fs.writeFileSync(path.join(out, "index.html"), layout("Home", indexBody));

fs.writeFileSync(path.join(out, "build.json"), JSON.stringify({ posts: build, built_at: new Date().toISOString() }, null, 2));
console.log(`built ${build.length} posts -> ${path.relative(process.cwd(), out)}`);
