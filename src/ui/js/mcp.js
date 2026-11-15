/* MCP integration: tokens, connection snippets, agent onboarding prompt, tool catalog. */

import { api, confirmDialog, esc, fmtDate, icon, openModal, route, setTitle, state, toast } from "./core.js";
import { buildAgentPrompt, PROMPT_SECTIONS, PROMPT_SPEC } from "./mcp-prompt.js";

const TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";

/** Clipboard API with a selection fallback, so copying works on non-secure origins too. */
async function copyAny(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, "ok");
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    ta.remove();
    toast(copied ? label : "复制失败，请手动选择文本", copied ? "ok" : "err");
    return copied;
  }
}

function snippet(endpoint, token) {
  return JSON.stringify(
    {
      mcpServers: {
        qexo: {
          type: "http",
          url: endpoint,
          headers: { Authorization: `Bearer ${token || TOKEN_PLACEHOLDER}` },
        },
      },
    },
    null,
    2,
  );
}

function stdioSnippet(endpoint, token) {
  return JSON.stringify(
    {
      mcpServers: {
        qexo: {
          command: "node",
          args: ["<仓库根目录>/mcp/stdio-bridge.mjs"],
          env: {
            QEXO_MCP_URL: endpoint,
            QEXO_MCP_TOKEN: token || TOKEN_PLACEHOLDER,
          },
        },
      },
    },
    null,
    2,
  );
}

async function renderMcp({ view }) {
  setTitle("MCP 接入", [{ text: "系统" }, { text: "MCP" }]);
  const data = await api("/api/mcp");
  const endpoint = data.endpoint;

  view.innerHTML = `
    <div class="grid cols-3">
      <div class="card" style="grid-column:span 2">
        <div class="card-head">
          <div><h3>Model Context Protocol 服务</h3>
            <div class="sub">让 WorkBuddy / Claude / Cursor 等 agent 直接读写你的博客</div></div>
          <span class="tag ${data.enabled ? "ok" : "warn"}">${data.enabled ? "已启用" : "已停用"}</span>
        </div>
        <dl class="kv">
          <dt>端点</dt><dd><code>${esc(endpoint)}</code></dd>
          <dt>传输</dt><dd>Streamable HTTP（POST JSON-RPC 2.0）</dd>
          <dt>协议版本</dt><dd>${data.protocols.join(" / ")}</dd>
          <dt>鉴权</dt><dd>Authorization: Bearer &lt;token&gt;</dd>
        </dl>
        <div class="flex mt">
          <button class="btn" id="toggle">${data.enabled ? "停用 MCP" : "启用 MCP"}</button>
          <button class="btn" id="curl">复制连通性测试命令</button>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>接入步骤</h3></div>
        <ol class="hint" style="line-height:1.9;padding-left:18px;margin:0">
          <li>创建令牌（明文仅显示一次）</li>
          <li>复制自动生成的 Agent 配置提示词，直接发给任意 AI agent</li>
          <li>agent 按提示词写入配置并信任 / 启用服务器</li>
          <li>用提示词内的首条指令验证接入</li>
        </ol>
        <details class="scope-help mt">
          <summary>Agent 提示词结构规范（v${PROMPT_SPEC.version}）</summary>
          <ul>
            ${PROMPT_SECTIONS.map((s) => `<li>${esc(s)}</li>`).join("")}
          </ul>
          <p>${PROMPT_SPEC.rules.map(esc).join("；")}。必备要素：${PROMPT_SPEC.required.map(esc).join("、")}。</p>
        </details>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div><h3>访问令牌</h3><div class="sub">令牌只存 SHA-256，创建后无法再次查看</div></div>
        <button class="btn primary sm" id="new-token">${icon("plus")} 创建令牌</button>
      </div>
      <div id="tokens"></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>客户端配置</h3></div>
      <div class="tabs" style="margin-bottom:12px">
        <button class="tab active" data-snippet="workbuddy">WorkBuddy / HTTP</button>
        <button class="tab" data-snippet="stdio">stdio 桥接</button>
      </div>
      <pre id="snippet" style="background:#0a1017;border:1px solid var(--border);border-radius:10px;padding:14px;overflow:auto;font-size:12.5px"></pre>
      <div class="flex">
        <button class="btn sm" id="copy-snippet">复制配置</button>
        <span class="hint">WorkBuddy：设置 → 连接器 → 自定义 MCP → 粘贴后点「信任」。</span>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>可用工具（${data.tools.length}）</h3>
        <div class="sub">read 令牌只能调用只读工具；write 令牌可修改仓库</div></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>工具</th><th>权限</th><th>说明</th></tr></thead>
        <tbody>${data.tools
          .map(
            (t) => `<tr><td class="mono">${esc(t.name)}</td>
            <td>${t.scope === "write" ? '<span class="tag warn">write</span>' : '<span class="tag info">read</span>'}</td>
            <td>${esc(t.description)}</td></tr>`,
          )
          .join("")}</tbody>
      </table></div>
    </div>`;

  const drawTokens = (tokens) => {
    const el = document.getElementById("tokens");
    if (!tokens.length) {
      el.innerHTML = `<div class="empty"><strong>还没有令牌</strong>创建后把配置贴到 AI 客户端即可</div>`;
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>名称</th><th>权限</th><th>创建时间</th><th>最近使用</th><th style="text-align:right">操作</th></tr></thead>
      <tbody>${tokens
        .map(
          (t) => `<tr>
          <td><strong>${esc(t.name)}</strong></td>
          <td>${t.scopes.map((s) => `<span class="tag ${s === "write" ? "warn" : "info"}">${esc(s)}</span>`).join(" ")}</td>
          <td>${fmtDate(t.created_at)}</td>
          <td>${t.last_used_at ? fmtDate(t.last_used_at) : "从未"}</td>
          <td class="actions"><button class="btn sm danger" data-revoke="${esc(t.id)}">吊销</button></td>
        </tr>`,
        )
        .join("")}</tbody></table></div>`;

    el.querySelectorAll("[data-revoke]").forEach((btn) => {
      btn.onclick = async () => {
        if (!(await confirmDialog("吊销后使用该令牌的 agent 会立即失去访问权限，确定继续？"))) return;
        try {
          await api("/api/mcp/tokens", { method: "DELETE", body: { id: btn.dataset.revoke } });
          toast("令牌已吊销", "ok");
          const next = await api("/api/mcp");
          drawTokens(next.tokens);
        } catch (e) {
          toast(e.message, "err");
        }
      };
    });
  };
  drawTokens(data.tokens);

  let snippetMode = "workbuddy";
  const renderSnippet = () => {
    document.getElementById("snippet").textContent =
      snippetMode === "workbuddy" ? snippet(endpoint, "") : stdioSnippet(endpoint, "");
    document.querySelectorAll("[data-snippet]").forEach((b) => b.classList.toggle("active", b.dataset.snippet === snippetMode));
  };
  renderSnippet();
  document.querySelectorAll("[data-snippet]").forEach((btn) => {
    btn.onclick = () => {
      snippetMode = btn.dataset.snippet;
      renderSnippet();
    };
  });
  document.getElementById("copy-snippet").onclick = () => copyAny(document.getElementById("snippet").textContent, "已复制配置片段");

  document.getElementById("new-token").onclick = () => {
    openModal({
      title: "创建 MCP 令牌",
      body: `
        <label class="field"><span>名称（便于识别客户端）</span><input id="t-name" placeholder="WorkBuddy 桌面" /></label>
        <label class="field"><span>权限</span>
          <div class="flex" style="gap:16px">
            <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="t-read" checked style="width:auto" /> <span style="margin:0">read（读取文章/配置/统计）</span></label>
            <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="t-write" style="width:auto" /> <span style="margin:0">write（新建/修改/发布/删除）</span></label>
          </div>
        </label>
        <p class="hint">建议先只给 read；需要 agent 代写文章时再创建 write 令牌。</p>`,
      buttons: [
        { label: "取消", cls: "ghost" },
        {
          label: "创建",
          cls: "primary",
          onClick: async () => {
            const scopes = [];
            if (document.getElementById("t-read").checked) scopes.push("read");
            if (document.getElementById("t-write").checked) scopes.push("write");
            if (!scopes.length) {
              toast("至少选择一个权限", "err");
              return false;
            }
            try {
              const res = await api("/api/mcp/tokens", {
                method: "POST",
                body: { name: document.getElementById("t-name").value || "AI Agent", scopes },
              });
              const prompt = buildAgentPrompt({
                token: res.token,
                endpoint: data.endpoint,
                scopes,
                tools: data.tools,
                protocols: data.protocols,
                appVersion: state.settings?.version || "1.3.0",
              });
              showToken(res.token, scopes, prompt);
              const next = await api("/api/mcp");
              drawTokens(next.tokens);
              return false;
            } catch (e) {
              toast(e.message, "err");
              return false;
            }
          },
        },
      ],
    });
  };

  function showToken(token, scopes, prompt) {
    openModal({
      title: "令牌已创建 · Agent 配置提示词",
      body: `<p class="hint">令牌与提示词仅显示这一次。推荐直接把下方提示词发给任意 AI agent，让它自行完成接入配置。</p>
        <label class="field"><span>Token</span>
          <input id="new-token-value" readonly value="${esc(token)}" class="mono" /></label>
        <label class="field"><span>Agent 配置提示词（${PROMPT_SECTIONS.length} 段固定结构 · 纯 Markdown）</span>
          <textarea id="new-agent-prompt" rows="14" class="mono" readonly>${esc(prompt)}</textarea>
          <small>含令牌、端点、配置参数、${esc(String(data.tools.length))} 个工具、客户端适配规则、使用说明与安全约束；可原样粘贴给 WorkBuddy / Claude / Cursor 等任意 agent。</small>
        </label>
        <details class="scope-help">
          <summary>单独查看 HTTP 配置片段</summary>
          <textarea id="new-token-config" rows="9" class="mono" readonly>${esc(snippet(endpoint, token))}</textarea>
        </details>
        <p class="picker-status err mt"><span>提示词包含明文令牌，请勿粘贴到公开仓库、群聊或日志；权限：${scopes.join(" / ")}。</span></p>`,
      buttons: [
        {
          label: "复制 Agent 配置提示词",
          cls: "primary",
          onClick: async () => {
            await copyAny(prompt, "已复制 Agent 配置提示词");
            return false;
          },
        },
        {
          label: "复制 HTTP 配置",
          cls: "ghost",
          onClick: async () => {
            await copyAny(snippet(endpoint, token), "已复制 HTTP 配置");
            return false;
          },
        },
        {
          label: "仅复制 Token",
          cls: "ghost",
          onClick: async () => {
            await copyAny(token, "已复制 Token");
            return false;
          },
        },
        { label: "完成", cls: "ghost" },
      ],
    });
  }

  document.getElementById("toggle").onclick = async () => {
    try {
      const res = await api("/api/mcp/toggle", { method: "POST", body: { enabled: !data.enabled } });
      toast(res.msg, "ok");
      await renderMcp({ view: document.getElementById("view") });
    } catch (e) {
      toast(e.message, "err");
    }
  };

  document.getElementById("curl").onclick = () =>
    copyAny(
      `curl -s ${endpoint} -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer ${TOKEN_PLACEHOLDER}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      "已复制连通性测试命令",
    );
}

route("/mcp", renderMcp);
