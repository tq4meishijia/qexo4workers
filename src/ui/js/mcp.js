/* MCP integration: tokens, connection snippets, tool catalog. */

import { api, confirmDialog, copyText, esc, fmtDate, icon, openModal, route, setTitle, toast } from "./core.js";

function snippet(endpoint, token) {
  return JSON.stringify(
    {
      mcpServers: {
        qexo: {
          type: "http",
          url: endpoint,
          headers: { Authorization: `Bearer ${token || "<YOUR_TOKEN>"}` },
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
          args: ["<path-to>/mcp/stdio-bridge.mjs"],
          env: {
            QEXO_MCP_URL: endpoint,
            QEXO_MCP_TOKEN: token || "<YOUR_TOKEN>",
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
          <li>创建令牌并复制（仅显示一次）</li>
          <li>把配置片段写入客户端的 MCP 配置</li>
          <li>在客户端信任/启用该服务器</li>
          <li>对 agent 说「列出我的博客文章」</li>
        </ol>
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
  document.getElementById("copy-snippet").onclick = () => copyText(document.getElementById("snippet").textContent);

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
              showToken(res.token, scopes);
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

  function showToken(token, scopes) {
    openModal({
      title: "令牌已创建",
      body: `<p class="hint">仅显示这一次。复制后写入客户端配置。</p>
        <label class="field"><span>Token</span>
          <input id="new-token-value" readonly value="${esc(token)}" class="mono" /></label>
        <label class="field"><span>HTTP 配置</span>
          <textarea id="new-token-config" rows="9" class="mono" readonly>${esc(snippet(endpoint, token))}</textarea></label>
        <p class="hint">权限：${scopes.join(" / ")}</p>`,
      buttons: [
        {
          label: "复制 Token",
          cls: "ghost",
          onClick: () => copyText(token),
        },
        {
          label: "复制完整配置",
          cls: "primary",
          onClick: () => copyText(document.getElementById("new-token-config").value),
        },
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
    copyText(
      `curl -s ${endpoint} -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer <YOUR_TOKEN>" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    );
}

route("/mcp", renderMcp);
