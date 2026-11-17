#!/usr/bin/env node
/**
 * 版本门禁 / Release notes 提取。
 *
 * 子命令：
 *   detect   解析当前版本与基线版本，判定「版本确实变化且尚未发布」后置位
 *   notes    从 CHANGELOG.md 提取指定版本的段落，写入 release-notes.md
 *
 * 版本来源全部通过环境变量配置（括号内为默认值）：
 *   VERSION_FILE       版本所在文件            (package.json)
 *   VERSION_KIND       json | regex            (json)
 *   VERSION_JSON_PATH  json 模式的取值路径      (version)
 *   VERSION_REGEX      regex 模式的匹配正则     ((?<=QEXO_VERSION\\s*=\\s*")[0-9]+\\.[0-9]+\\.[0-9]+)
 *   TAG_PREFIX         标签前缀                (v)
 *   BASE_REF           基线 commit             (空 → 自动 HEAD^)
 *   HEAD_REF           目标 commit             (HEAD)
 *   FORCE              忽略「版本未变化」       (false)
 *   SKIP_REMOTE_CHECK  本地调试跳过 tag 查询     (0)
 *   CHECK_RELEASE      追加 gh release 检查     (0)
 *   CHANGELOG_FILE     变更记录文件            (CHANGELOG.md)
 *
 * 退出码：0 = 判定完成（无论是否发布）；非 0 = 配置或读取错误。
 */

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const env = process.env;
const VERSION_FILE = env.VERSION_FILE || "package.json";
const VERSION_KIND = (env.VERSION_KIND || "json").toLowerCase();
const VERSION_JSON_PATH = env.VERSION_JSON_PATH || "version";
const VERSION_REGEX =
  env.VERSION_REGEX || '(?<=QEXO_VERSION\\s*=\\s*")[0-9]+\\.[0-9]+\\.[0-9]+';
const TAG_PREFIX = env.TAG_PREFIX || "v";
const CHANGELOG_FILE = env.CHANGELOG_FILE || "CHANGELOG.md";

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function notice(msg) {
  console.log(`::notice::${msg}`);
  console.log(msg);
}
function warn(msg) {
  console.log(`::warning::${msg}`);
  console.log(msg);
}
function fail(msg) {
  console.log(`::error::${msg}`);
  console.error(msg);
  process.exit(1);
}

/** 读取指定 ref 的文件内容；ref 为空时读工作区。 */
function readAt(ref, file) {
  if (!ref) {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  }
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function pickJson(text, dottedPath) {
  let node = JSON.parse(text);
  for (const key of dottedPath.split(".").filter(Boolean)) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node == null ? undefined : String(node);
}

function parseVersion(text) {
  if (text == null) return "";
  if (VERSION_KIND === "json") {
    const value = pickJson(text, VERSION_JSON_PATH);
    return value ? value.trim() : "";
  }
  if (VERSION_KIND === "regex") {
    const m = new RegExp(VERSION_REGEX).exec(text);
    if (!m) return "";
    // 优先第 1 个捕获组；无捕获组时取整体匹配。
    return (m[1] ?? m[0] ?? "").trim();
  }
  fail(`VERSION_KIND 只支持 json 或 regex，收到：${VERSION_KIND}`);
}

function readVersion(ref) {
  const text = readAt(ref, VERSION_FILE);
  if (text == null) return "";
  try {
    return parseVersion(text);
  } catch (e) {
    fail(`解析 ${ref || "工作区"}:${VERSION_FILE} 的版本失败：${e.message}`);
  }
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function remoteTagExists(tag) {
  if (env.SKIP_REMOTE_CHECK === "1") return false;
  try {
    return git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).length > 0;
  } catch (e) {
    // 网络或权限问题不能当作「未发布」，否则会重复发布。
    fail(`查询远端标签失败，拒绝在状态未知时发布：${e.message}`);
  }
}

function releaseExists(tag) {
  if (env.CHECK_RELEASE !== "1") return false;
  try {
    execFileSync("gh", ["release", "view", tag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function writeOutputs(pairs) {
  const body = Object.entries(pairs)
    .map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, " ")}`)
    .join("\n");
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, body + "\n");
  else console.log(`[outputs]\n${body}`);
}

function detect() {
  const headRef = env.HEAD_REF || "HEAD";
  const version = readVersion(headRef);
  if (!version) fail(`未能从 ${VERSION_FILE}（${VERSION_KIND}）解析出版本号，请检查 VERSION_JSON_PATH / VERSION_REGEX`);
  if (!SEMVER.test(version)) fail(`版本号不是合法的 X.Y.Z：${version}`);

  let baseRef = (env.BASE_REF || "").trim();
  if (!baseRef || /^0+$/.test(baseRef)) {
    try {
      baseRef = git(["rev-parse", `${headRef}^`]);
      notice(`基线为空（首次推送或手动触发），回退到 ${headRef}^ = ${baseRef.slice(0, 7)}`);
    } catch {
      baseRef = "";
      warn("没有可用的基线提交，将仅按「标签是否已存在」判定");
    }
  }

  const previous = baseRef ? readVersion(baseRef) : "";
  const changed = Boolean(version) && version !== previous;
  const tag = `${TAG_PREFIX}${version}`;
  const published = remoteTagExists(tag) || releaseExists(tag);
  const forced = String(env.FORCE || "false") === "true";
  const release = (changed || forced) && !published;

  let reason;
  if (published) reason = `标签 ${tag} 已存在，该版本已发布过，跳过`;
  else if (!changed && !forced) reason = `版本未变化（${previous || "无基线"} → ${version}），跳过`;
  else if (!changed && forced) reason = `版本未变化（${previous || "无基线"} → ${version}），按 force 强制发布`;
  else reason = `版本 ${previous || "无基线"} → ${version}，且 ${tag} 未发布，执行发布`;

  if (release) notice(reason);
  else warn(reason);

  writeOutputs({
    version,
    previous: previous || "",
    tag,
    changed,
    published,
    release,
    reason,
  });
}

function extractNotes(version) {
  if (!version) fail("notes 子命令需要版本号：node .github/scripts/version-gate.mjs notes 1.2.3");
  const file = CHANGELOG_FILE;
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  let body = "";
  if (text) {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => new RegExp(`^##\\s+${TAG_PREFIX}?${version.replace(/\./g, "\\.")}(?:\\s|$)`).test(line));
    if (start >= 0) {
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((line) => /^##\s+/.test(line));
      body = (end >= 0 ? rest.slice(0, end) : rest).join("\n").trim();
    }
  }
  if (body) {
    fs.writeFileSync("release-notes.md", body + "\n");
    notice(`已从 ${file} 提取 ${version} 的变更记录（${body.length} 字符）`);
  } else {
    fs.writeFileSync("release-notes.md", "");
    warn(`${file} 中没有 ${version} 的段落，将由 gh release --generate-notes 生成`);
  }
}

const command = process.argv[2];
if (command === "detect") detect();
else if (command === "notes") extractNotes(process.argv[3] || env.VERSION || readVersion(""));
else fail(`未知子命令：${command || "(空)"}，可用：detect / notes`);
