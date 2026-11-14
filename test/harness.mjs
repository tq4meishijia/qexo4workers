/**
 * Spawns the mock GitHub API plus `wrangler dev` with an isolated D1 state
 * directory, and waits until both are ready.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WRANGLER = path.resolve("node_modules/wrangler/bin/wrangler.js");
const STATE = path.resolve("test/.state");
const REPO = path.resolve("test/out/repo");

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}\n${out}`))));
  });
}

async function waitFor(url, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`timeout waiting for ${url}`);
}

function walkFiles(dir, base = "") {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

export async function startServers({ fresh = true } = {}) {
  if (fresh) {
    fs.rmSync(STATE, { recursive: true, force: true });
    // Sync the fixture over the repo and remove only files that no longer
    // belong to it. Avoids deleting the whole tree on every run.
    const fixture = path.resolve("test/fixture/repo");
    fs.mkdirSync(REPO, { recursive: true });
    fs.cpSync(fixture, REPO, { recursive: true, force: true });
    const expected = new Set(walkFiles(fixture));
    for (const rel of walkFiles(REPO)) {
      if (!expected.has(rel)) fs.unlinkSync(path.join(REPO, rel));
    }
  }

  await run(process.execPath, [WRANGLER, "d1", "migrations", "apply", "qexo", "--local", "--persist-to", STATE]);

  const mock = spawn(process.execPath, ["test/mock-github.mjs"], {
    env: { ...process.env, PORT: "8788", REPO_ROOT: REPO },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let mockLog = "";
  mock.stdout.on("data", (d) => (mockLog += d.toString()));
  mock.stderr.on("data", (d) => (mockLog += d.toString()));

  const dev = spawn(
    process.execPath,
    [
      WRANGLER,
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      "8787",
      "--persist-to",
      STATE,
      "--var",
      "GITHUB_API_BASE:http://127.0.0.1:8788",
      "--var",
      "PUBLIC_ORIGIN:http://127.0.0.1:8787",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let devLog = "";
  dev.stdout.on("data", (d) => (devLog += d.toString()));
  dev.stderr.on("data", (d) => (devLog += d.toString()));

  try {
    await waitFor("http://127.0.0.1:8787/api/init/state");
  } catch (e) {
    console.error("--- wrangler dev log ---\n" + devLog.slice(-4000));
    console.error("--- mock log ---\n" + mockLog);
    throw e;
  }

  return {
    base: "http://127.0.0.1:8787",
    mock: "http://127.0.0.1:8788",
    logs: () => ({ dev: devLog, mock: mockLog }),
    async stop() {
      dev.kill();
      mock.kill();
      await new Promise((r) => setTimeout(r, 400));
    },
  };
}
