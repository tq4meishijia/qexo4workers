// Long-running local stack for ego-browser manual QA.
// Keeps mock GitHub (:8788) + wrangler dev (:8787) alive in one process.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WRANGLER = path.resolve("node_modules/wrangler/bin/wrangler.js");
const STATE = path.resolve("test/.ego-state");
const REPO = path.resolve("test/out/ego-repo");
const FIXTURE = path.resolve("test/fixture/repo");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}\n${out}`))));
  });
}

async function waitFor(url, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`timeout waiting for ${url}`);
}

// Copy fixture into an isolated repo directory. Never deletes existing trees.
fs.mkdirSync(REPO, { recursive: true });
fs.cpSync(FIXTURE, REPO, { recursive: true, force: true });
await run([WRANGLER, "d1", "migrations", "apply", "qexo", "--local", "--persist-to", STATE]);

const mock = spawn(process.execPath, ["test/mock-github.mjs"], {
  env: { ...process.env, PORT: "8788", REPO_ROOT: REPO },
  stdio: ["ignore", "pipe", "pipe"],
});
const dev = spawn(process.execPath, [
  WRANGLER, "dev", "--local", "--ip", "127.0.0.1", "--port", "8787",
  "--persist-to", STATE,
  "--var", "GITHUB_API_BASE:http://127.0.0.1:8788",
  "--var", "PUBLIC_ORIGIN:http://127.0.0.1:8787",
], { stdio: ["ignore", "pipe", "pipe"] });

for (const [name, child] of [["mock", mock], ["dev", dev]]) {
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`[${name}:err] ${d}`));
}

await waitFor("http://127.0.0.1:8787/api/init/state");
console.log("EGO_STACK_READY http://127.0.0.1:8787");

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { dev.kill(); mock.kill(); process.exit(0); });
}
await new Promise(() => {});
