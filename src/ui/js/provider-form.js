/**
 * Shared content-source fields.
 *
 * GitHub gets a dedicated form: PAT application link, a token health check and
 * repository/branch pickers fed by the GitHub API. Other providers keep the
 * generic key/value inputs generated from the server-side parameter schema.
 */

import { api, esc, toast } from "./core.js";

const PAT_PARAMS = {
  name: "Qexo Workers",
  description: "Qexo Workers blog content source (Contents: read/write)",
  expires_in: "90",
  contents: "write",
};

/**
 * Fine-grained token creation page. GitHub honours `name`, `description`,
 * `expires_in` and permission params, but cannot prefill repository selection —
 * the user must pick "Only select repositories" themselves.
 */
export const PAT_URL =
  "https://github.com/settings/personal-access-tokens/new?" +
  Object.entries(PAT_PARAMS)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
const PAT_HELP =
  "https://docs.github.com/zh/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens";

const REPO_CACHE = new Map(); // token placeholder -> { login, repos, at }

function genericFields(defs, params) {
  return Object.entries(defs || {}).map(([key, def]) => `
    <label class="field"><span>${esc(def.description || key)}</span>
      <input data-param="${esc(key)}" value="${esc(params[key] ?? "")}" placeholder="${esc(def.placeholder || "")}" />
    </label>`).join("");
}

/** Placeholder is always an empty value: an untouched form must never look filled. */
const REPO_PLACEHOLDER = "— 请选择 GitHub 仓库（必填）—";
const BRANCH_PLACEHOLDER = "— 请选择分支（必填）—";
const BRANCH_NO_REPO = "— 待选择分支（请先选择仓库）—";

function repoOptions(repos, current) {
  const rows = [`<option value="">${REPO_PLACEHOLDER}</option>`];
  for (const r of repos) {
    const notes = [r.private ? "私有" : "", r.push === false ? "只读" : ""].filter(Boolean);
    rows.push(
      `<option value="${esc(r.full_name)}" ${r.full_name === current ? "selected" : ""}>${esc(r.full_name)}${
        notes.length ? `（${notes.join(" · ")}）` : ""
      }</option>`,
    );
  }
  if (current && !repos.some((r) => r.full_name === current)) {
    rows.push(`<option value="${esc(current)}" selected>${esc(current)}（手动填写）</option>`);
  }
  return rows.join("");
}

function branchOptions(branches, current) {
  const rows = [`<option value="">${BRANCH_PLACEHOLDER}</option>`];
  for (const b of branches) {
    rows.push(
      `<option value="${esc(b.name)}" ${b.name === current ? "selected" : ""}>${esc(b.name)}${b.protected ? "（受保护）" : ""}</option>`,
    );
  }
  if (current && !branches.some((b) => b.name === current)) {
    rows.push(`<option value="${esc(current)}" selected>${esc(current)}（手动填写）</option>`);
  }
  return rows.join("");
}

function githubFields(params) {
  const token = params.token || "";
  const savedRepo = params.repo || "";
  const savedBranch = params.branch || "";
  const stored = token.includes("******");
  const savedInfo = savedRepo || savedBranch
    ? `<div class="picker-note" id="gh-saved-info">当前已保存：仓库 ${esc(savedRepo || "未设置")} · 分支 ${esc(savedBranch || "未设置")}。为避免误用旧值，下方两项默认留空，保存前请重新选择。</div>`
    : "";
  return `
    <div class="field">
      <div class="field-head">
        <span>GitHub 密钥</span>
        <span class="field-tools">
          <button type="button" class="link-btn" id="gh-check">检测密钥</button>
          <a class="field-link" id="gh-pat-link" href="${PAT_URL}" target="_blank" rel="noopener noreferrer"
             title="点击后在新标签页打开 GitHub Fine-grained token 创建页，不会提交或离开当前表单">申请 Fine-grained PAT ↗</a>
        </span>
      </div>
      <input id="gh-token" data-param="token" type="password" autocomplete="off" spellcheck="false"
             value="${esc(token)}" placeholder="github_pat_…" />
      <small>密钥用于读取仓库、提交文章与触发部署，只保存在本服务端，不会回显。尚未申请时点右上角
        <b>申请 Fine-grained PAT</b>，会在 GitHub 新标签页打开官方创建页，已预填名称、90 天有效期与
        <b>Contents: Read &amp; write</b>。仓库范围无法通过链接预填，请在页面中选择
        <b>Only select repositories</b>，只勾选你的博客仓库。
        <a href="${PAT_HELP}" target="_blank" rel="noopener noreferrer">权限说明</a></small>
      <small class="pat-why">最小权限的意义：令牌只覆盖选中的博客仓库；即使泄露，也无法读取你其它私有仓库，并会在 90 天后自动过期。</small>
      <details class="scope-help">
        <summary>对照申请页：最小权限清单</summary>
        <ul>
          <li><b>Repository access</b>：Only select repositories → 只勾选博客仓库</li>
          <li><b>Contents</b>：Read and write（必需：读写文章、页面与配置文件）</li>
          <li><b>Metadata</b>：Read（GitHub 自动附带，无需勾选）</li>
          <li><b>Webhooks</b>：Read and write（仅“自动配置 WebHook”时需要）</li>
          <li><b>Actions</b>：Read and write（仅用 GitHub Actions 工作流部署时需要）</li>
        </ul>
        <p>默认链接只预填 Contents 读写，不预填 Webhooks / Actions；请按实际用途逐项添加，避免一次性授予多余权限。</p>
      </details>
      <div class="picker-status${stored ? " loading" : ""}" id="gh-token-status">${
        stored ? '<span class="spin"></span><span>已保存密钥，正在读取授权仓库…</span>' : "填写密钥后点击「检测密钥」，将自动读取该密钥可访问的仓库"
      }</div>
    </div>
    ${savedInfo}
    <div class="row">
      <div class="field">
        <div class="field-head">
          <span>GitHub 仓库</span>
          <span class="field-tools">
            <button type="button" class="link-btn" id="gh-repos-refresh">刷新列表</button>
            <button type="button" class="link-btn" id="gh-repo-manual">手动输入</button>
          </span>
        </div>
        <select id="gh-repo" data-param="repo">${repoOptions([], "")}</select>
        <input id="gh-repo-manual-input" value="" placeholder="手动填写 owner/repo（必填）" hidden />
        <div class="picker-status" id="gh-repo-status">${
          stored ? "正在读取授权仓库…" : "未选择仓库；填写密钥并检测后，从下拉中明确选择"
        }</div>
      </div>
      <div class="field">
        <div class="field-head">
          <span>项目分支</span>
          <span class="field-tools">
            <button type="button" class="link-btn" id="gh-branches-refresh">刷新列表</button>
            <button type="button" class="link-btn" id="gh-branch-manual">手动输入</button>
          </span>
        </div>
        <select id="gh-branch" data-param="branch"><option value="">${BRANCH_NO_REPO}</option></select>
        <input id="gh-branch-manual-input" value="" placeholder="手动填写分支名（必填）" hidden />
        <div class="picker-status" id="gh-branch-status">未选择分支；请先选择仓库，再从下拉中明确选择</div>
      </div>
    </div>
    <label class="field"><span>博客路径</span>
      <input data-param="path" value="${esc(params.path || "")}" placeholder="留空为根目录" />
      <small>博客位于仓库子目录时填写，例如 <code>blog</code></small>
    </label>`;
}

/** HTML for the provider parameter block. */
export function providerFieldsHtml(meta, params = {}) {
  if (meta?.name !== "github") return genericFields(meta?.params, params);
  return githubFields(params);
}

/** Reads the provider params from whichever layout is currently rendered. */
export function collectProviderParams() {
  const tokenEl = document.getElementById("gh-token");
  if (tokenEl) {
    const out = {};
    const put = (k, v) => {
      const val = String(v || "").trim();
      if (val) out[k] = val;
    };
    put("token", tokenEl.value);
    put("repo", document.getElementById("gh-repo-manual-input")?.hidden === false
      ? document.getElementById("gh-repo-manual-input").value
      : document.getElementById("gh-repo").value);
    put("branch", document.getElementById("gh-branch-manual-input")?.hidden === false
      ? document.getElementById("gh-branch-manual-input").value
      : document.getElementById("gh-branch").value);
    put("path", document.querySelector('[data-param="path"]')?.value);
    return out;
  }
  const generic = {};
  document.querySelectorAll("[data-param]").forEach((el) => {
    const v = el.value.trim();
    if (v) generic[el.dataset.param] = v;
  });
  return generic;
}

function setStatus(el, kind, text) {
  if (!el) return;
  el.className = "picker-status" + (kind ? ` ${kind}` : "");
  el.innerHTML = (kind === "loading" ? '<span class="spin"></span>' : "") + `<span>${esc(text)}</span>`;
}

/**
 * Wires the GitHub pickers. Returns a cleanup function so re-rendering the
 * provider block cannot leave timers or stale listeners behind.
 */
export function bindProviderFields(meta) {
  if (meta?.name !== "github") return () => {};

  const tokenEl = document.getElementById("gh-token");
  const repoEl = document.getElementById("gh-repo");
  const branchEl = document.getElementById("gh-branch");
  const repoManual = document.getElementById("gh-repo-manual-input");
  const branchManual = document.getElementById("gh-branch-manual-input");
  const tokenStatus = document.getElementById("gh-token-status");
  const repoStatus = document.getElementById("gh-repo-status");
  const branchStatus = document.getElementById("gh-branch-status");
  const checkBtn = document.getElementById("gh-check");
  const repoRefresh = document.getElementById("gh-repos-refresh");
  const branchRefresh = document.getElementById("gh-branches-refresh");
  const repoManualBtn = document.getElementById("gh-repo-manual");
  const branchManualBtn = document.getElementById("gh-branch-manual");

  const state = { repos: [], branches: [], login: "", loadingRepos: false, loadingBranches: false };
  let disposed = false;

  const tokenValue = () => tokenEl.value.trim();
  const currentRepo = () => (repoManual.hidden ? repoEl.value.trim() : repoManual.value.trim());
  const currentBranch = () => (branchManual.hidden ? branchEl.value.trim() : branchManual.value.trim());

  const fillRepos = () => {
    const current = currentRepo();
    repoEl.innerHTML = repoOptions(state.repos, current);
  };

  const fillBranches = (current) => {
    branchEl.innerHTML = branchOptions(state.branches, current);
  };

  const refreshBranches = async ({ auto = false } = {}) => {
    if (disposed || state.loadingBranches) return;
    const repo = currentRepo();
    if (!repo) {
      branchEl.innerHTML = `<option value="">${BRANCH_NO_REPO}</option>`;
      setStatus(branchStatus, "", "未选择分支；请先选择仓库");
      return;
    }
    state.loadingBranches = true;
    setStatus(branchStatus, "loading", `正在读取 ${repo} 的分支…`);
    try {
      const res = await api("/api/settings/github/branches", {
        method: "POST",
        body: { token: tokenValue(), repo },
      });
      if (disposed) return;
      state.branches = res.branches || [];
      fillBranches(currentBranch()); // never auto-select a branch
      const fallback = res.default_branch || "";
      if (!state.branches.length) {
        setStatus(branchStatus, "err", "该仓库没有可用分支（可能是空仓库）；可手动输入分支名");
      } else {
        setStatus(
          branchStatus,
          "ok",
          `已读取 ${state.branches.length} 个分支${res.truncated ? "（仅显示前 300 个）" : ""} · 默认 ${fallback || "main"}，请手动选择`,
        );
      }
    } catch (e) {
      if (disposed) return;
      setStatus(branchStatus, "err", `读取分支失败：${e.message}`);
      if (!auto) toast(e.message, "err");
    } finally {
      state.loadingBranches = false;
    }
  };

  const applyRepos = (res, { auto }) => {
    state.login = res.login || "";
    state.repos = res.repos || [];
    fillRepos();
    const suffix = res.truncated ? "（仅显示前 300 个）" : "";
    const who = state.login ? `@${state.login}` : "GitHub";
    setStatus(
      repoStatus,
      "ok",
      state.repos.length
        ? `已连接 ${who} · 共 ${state.repos.length} 个仓库${suffix}，请手动选择`
        : `已连接 ${who}，该账号暂无可访问仓库；可手动输入仓库`,
    );
    setStatus(
      tokenStatus,
      "ok",
      state.repos.length ? `密钥有效：${who}` : `密钥有效：${who}，但未返回仓库`,
    );
    // Loading options never fills the fields: both stay empty until the user
    // explicitly picks a repository and then a branch.
    if (currentRepo()) {
      refreshBranches({ auto: true });
    } else {
      branchEl.innerHTML = `<option value="">${BRANCH_NO_REPO}</option>`;
      setStatus(branchStatus, "", "未选择分支；请先选择仓库");
    }
  };

  const refreshRepos = async ({ auto = false, force = false } = {}) => {
    if (disposed || state.loadingRepos) return;
    const key = tokenValue();
    if (!force && key && REPO_CACHE.has(key)) {
      const hit = REPO_CACHE.get(key);
      if (Date.now() - hit.at < 60_000) {
        applyRepos({ login: hit.login, repos: hit.repos, truncated: hit.truncated }, { auto });
        return;
      }
    }
    state.loadingRepos = true;
    setStatus(repoStatus, "loading", "正在读取密钥可访问的仓库…");
    setStatus(tokenStatus, "loading", "正在校验密钥…");
    try {
      const res = await api("/api/settings/github/repos", { method: "POST", body: { token: key } });
      if (disposed) return;
      if (key) REPO_CACHE.set(key, { login: res.login, repos: res.repos || [], truncated: !!res.truncated, at: Date.now() });
      applyRepos(res, { auto });
    } catch (e) {
      if (disposed) return;
      const msg = e.message || "未知错误";
      setStatus(repoStatus, "err", `读取仓库失败：${msg}`);
      setStatus(tokenStatus, "err", `密钥检测失败：${msg}`);
      setStatus(branchStatus, "", "需要有效密钥后才能读取分支");
      if (!auto) toast(msg, "err");
    } finally {
      state.loadingRepos = false;
    }
  };

  const toggleManual = (which) => {
    const isRepo = which === "repo";
    const select = isRepo ? repoEl : branchEl;
    const input = isRepo ? repoManual : branchManual;
    const btn = isRepo ? repoManualBtn : branchManualBtn;
    const manual = input.hidden;
    if (manual) {
      input.value = select.value; // keeps the explicit empty state
      input.hidden = false;
      select.hidden = true;
      btn.textContent = "使用下拉";
      input.focus();
    } else {
      const value = input.value.trim();
      if (value) {
        if (!Array.from(select.options).some((o) => o.value === value)) {
          select.insertAdjacentHTML(
            "beforeend",
            `<option value="${esc(value)}">${esc(value)}（手动填写）</option>`,
          );
        }
        select.value = value;
      } else {
        select.value = "";
      }
      input.hidden = true;
      select.hidden = false;
      btn.textContent = "手动输入";
    }
  };

  const onRepoChange = () => refreshBranches({});
  const onTokenChange = () => {
    if (!tokenValue() || tokenValue().includes("******")) return;
    refreshRepos({ force: true });
  };

  checkBtn.addEventListener("click", () => refreshRepos({ force: true }));
  repoRefresh.addEventListener("click", () => refreshRepos({ force: true }));
  branchRefresh.addEventListener("click", () => refreshBranches({}));
  repoManualBtn.addEventListener("click", () => toggleManual("repo"));
  branchManualBtn.addEventListener("click", () => toggleManual("branch"));
  repoEl.addEventListener("change", onRepoChange);
  repoManual.addEventListener("change", onRepoChange);
  tokenEl.addEventListener("change", onTokenChange);

  if (tokenValue()) refreshRepos({ auto: true });

  return () => {
    disposed = true;
  };
}
