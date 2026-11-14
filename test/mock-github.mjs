#!/usr/bin/env node
/**
 * Mock GitHub REST API used by the end-to-end suite.
 *
 * Implements the subset Qexo-Workers touches (contents, git trees, hooks,
 * workflow dispatch) over a real directory, so a "Git repository as content
 * storage" can be exercised without network credentials.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8788);
const ROOT = path.resolve(process.env.REPO_ROOT || "test/out/repo");
const TOKEN = process.env.TOKEN || "mock-token";

const stats = { requests: 0, byPath: {} };
const hooks = [];

function blobSha(buf) {
  return crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");
}

function listFiles(dir = ROOT, base = "") {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push({ path: rel, type: "tree", sha: crypto.createHash("sha1").update(`tree:${rel}`).digest("hex") });
      out.push(...listFiles(full, rel));
    } else {
      const buf = fs.readFileSync(full);
      out.push({ path: rel, type: "blob", sha: blobSha(buf), size: buf.length });
    }
  }
  return out;
}

function safePath(p) {
  const clean = path.normalize(p).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.join(ROOT, clean);
  if (!full.startsWith(ROOT)) throw new Error("path escape");
  return full;
}

function send(res, status, data) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  stats.requests++;
  stats.byPath[url.pathname] = (stats.byPath[url.pathname] || 0) + 1;

  if (url.pathname === "/__stats") return send(res, 200, stats);
  if (url.pathname === "/__files") return send(res, 200, listFiles());
  if (url.pathname === "/__reset") {
    stats.requests = 0;
    stats.byPath = {};
    return send(res, 200, { ok: true });
  }

  if (!url.pathname.startsWith("/__") && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { message: "Requires authentication" });
  }

  // account + repository discovery (used by the admin content-source form)
  if (url.pathname === "/user" && req.method === "GET") {
    return send(res, 200, { login: "mock-user", name: "Mock User" });
  }

  if (url.pathname === "/user/repos" && req.method === "GET") {
    const page = Number(url.searchParams.get("page") || 1);
    const rows = [
      {
        full_name: "demo/blog",
        private: false,
        default_branch: "main",
        updated_at: "2026-11-14T02:00:00Z",
        permissions: { push: true },
      },
      {
        full_name: "demo/notes",
        private: true,
        default_branch: "trunk",
        updated_at: "2026-11-12T08:30:00Z",
        permissions: { push: false },
      },
    ];
    return send(res, 200, page === 1 ? rows : []);
  }

  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!repoMatch) return send(res, 404, { message: "Not Found" });
  const rest = repoMatch[3] || "";
  const fullName = `${repoMatch[1]}/${repoMatch[2]}`;

  // GET /repos/:owner/:repo
  if (rest === "" && req.method === "GET") {
    const notes = fullName === "demo/notes";
    return send(res, 200, {
      full_name: fullName,
      default_branch: notes ? "trunk" : "main",
      private: notes,
      permissions: { push: !notes },
    });
  }

  // GET /repos/:owner/:repo/branches
  if (rest === "/branches" && req.method === "GET") {
    const map = { "demo/blog": ["main", "dev"], "demo/notes": ["trunk"] };
    const names = map[fullName] || ["main"];
    return send(
      res,
      200,
      names.map((name, i) => ({ name, protected: i === 0, commit: { sha: `mock-${name}-sha` } })),
    );
  }

  // git trees
  if (/^\/git\/trees\//.test(rest) && req.method === "GET") {
    return send(res, 200, { sha: "mock-tree", truncated: false, tree: listFiles() });
  }

  // hooks
  if (rest === "/hooks" && req.method === "GET") return send(res, 200, hooks);
  if (rest === "/hooks" && req.method === "POST") {
    const body = await readBody(req);
    const hook = { id: Date.now(), active: true, events: body.events || ["push"], config: body.config || {} };
    hooks.push(hook);
    return send(res, 201, hook);
  }
  if (/^\/hooks\/\d+$/.test(rest) && req.method === "DELETE") {
    const id = Number(rest.split("/").pop());
    const idx = hooks.findIndex((h) => h.id === id);
    if (idx >= 0) hooks.splice(idx, 1);
    return send(res, 204, "");
  }

  // workflow dispatch
  if (/^\/actions\/workflows\/.+\/dispatches$/.test(rest) && req.method === "POST") {
    return send(res, 204, "");
  }

  // contents
  if (rest.startsWith("/contents/")) {
    const rel = decodeURIComponent(rest.slice("/contents/".length));
    const full = safePath(rel);

    if (req.method === "GET") {
      if (!fs.existsSync(full)) return send(res, 404, { message: "Not Found" });
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        const entries = fs.readdirSync(full, { withFileTypes: true }).map((e) => {
          const childFull = path.join(full, e.name);
          const buf = e.isFile() ? fs.readFileSync(childFull) : null;
          return {
            name: e.name,
            path: `${rel}/${e.name}`,
            sha: buf ? blobSha(buf) : crypto.createHash("sha1").update(`tree:${rel}/${e.name}`).digest("hex"),
            size: buf ? buf.length : 0,
            type: e.isDirectory() ? "dir" : "file",
          };
        });
        return send(res, 200, entries);
      }
      const buf = fs.readFileSync(full);
      return send(res, 200, {
        name: path.basename(rel),
        path: rel,
        sha: blobSha(buf),
        size: buf.length,
        content: buf.toString("base64").replace(/(.{60})/g, "$1\n"),
        encoding: "base64",
        type: "file",
      });
    }

    if (req.method === "PUT") {
      const body = await readBody(req);
      const exists = fs.existsSync(full);
      if (exists && !body.sha) return send(res, 422, { message: "sha wasn't supplied" });
      if (exists && body.sha) {
        const current = blobSha(fs.readFileSync(full));
        if (current !== body.sha) return send(res, 409, { message: "sha does not match" });
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const content = Buffer.from(body.content || "", "base64");
      fs.writeFileSync(full, content);
      return send(res, exists ? 200 : 201, {
        content: { path: rel, sha: blobSha(content), size: content.length },
        commit: { sha: crypto.randomBytes(20).toString("hex"), message: body.message },
      });
    }

    if (req.method === "DELETE") {
      const body = await readBody(req);
      if (!fs.existsSync(full)) return send(res, 404, { message: "Not Found" });
      const current = blobSha(fs.readFileSync(full));
      if (body.sha && body.sha !== current) return send(res, 409, { message: "sha does not match" });
      fs.unlinkSync(full);
      return send(res, 200, { commit: { sha: crypto.randomBytes(20).toString("hex") } });
    }
  }

  return send(res, 404, { message: `Unhandled ${req.method} ${url.pathname}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-github listening on http://127.0.0.1:${PORT}, repo=${ROOT}`);
});
