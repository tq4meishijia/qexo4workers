/**
 * Agent onboarding prompt generator for Qexo MCP.
 *
 * Pure, DOM-free module: it can be imported by the admin SPA and by Node tests.
 * The prompt is generated exactly once — right after a token is created, because
 * the server only stores the token's SHA-256 and never shows it again.
 */

/** Fixed structure. Order is part of the public contract (see docs/mcp.md). */
export const PROMPT_SECTIONS = Object.freeze([
  "1. 连接信息",
  "2. 标准配置（HTTP MCP，优先使用）",
  "3. 客户端适配规则",
  "4. 可用功能清单",
  "5. 使用说明",
  "6. 安全与排错",
]);

/** Format rules, kept as data so docs and tests can assert the same contract. */
export const PROMPT_SPEC = Object.freeze({
  version: "1.0",
  format: "Markdown（纯文本，无 HTML）",
  headings: "一级标题 1 个；二级标题 6 个，顺序与 PROMPT_SECTIONS 一致",
  codeBlocks: "配置一律放在 ```json 代码块；命令行放在 ```bash 代码块，均为可直接解析的内容",
  facts: "连接信息用表格；功能清单用分组列表；适配规则用表格",
  required: [
    "令牌明文",
    "接入地址（endpoint）",
    "传输与协议版本",
    "HTTP 配置参数（type/url/headers）",
    "stdio 回退配置",
    "纯 HTTP 回退调用示例",
    "功能列表（18 工具，按 read/write 分组）",
    "作用域说明",
    "使用说明与首条验证指令",
    "安全约束与排错",
    "完成回执",
  ],
  rules: [
    "令牌只出现在第 1 节表格与第 2 节配置块；其它示例统一用 $QEXO_MCP_TOKEN 占位",
    "所有信息自包含，agent 无需追问、无需外部文档即可完成接入",
    "不同客户端的差异集中在第 3 节，键名 servers / mcpServers 均给出处理",
    "生成结果可直接复制，不依赖服务端二次请求",
  ],
});

function code(value) {
  return `\`${String(value).replace(/`/g, "'")}\``;
}

function toolLines(tools, scope) {
  const rows = tools.filter((t) => t.scope === scope);
  if (!rows.length) return ["- （无）"];
  return rows.map((t) => `- ${code(t.name)} — ${String(t.description || "").replace(/[\r\n]+/g, " ")}`);
}

/**
 * @param {object} ctx
 * @param {string} ctx.token          plaintext token (shown once)
 * @param {string} ctx.endpoint       full /mcp URL
 * @param {string[]} ctx.scopes       e.g. ["read"] or ["read","write"]
 * @param {Array<{name:string,description:string,scope:string}>} ctx.tools
 * @param {string[]} [ctx.protocols]  negotiated protocol versions
 * @param {string} [ctx.appVersion]   server version
 * @param {string} [ctx.bridgePath]   stdio bridge path placeholder
 * @param {string} [ctx.serverName]   MCP server key (default qexo)
 */
export function buildAgentPrompt(ctx) {
  const {
    token,
    endpoint,
    scopes = ["read"],
    tools = [],
    protocols = ["2025-06-18", "2025-03-26", "2024-11-05"],
    appVersion = "1.6.1",
    bridgePath = "<仓库根目录>/mcp/stdio-bridge.mjs",
    serverName = "qexo",
  } = ctx;
  if (!token || !endpoint) throw new Error("buildAgentPrompt: token and endpoint are required");

  const primary = protocols[0];
  const scopeText = scopes.join(" + ") || "read";
  const canWrite = scopes.includes("write");
  const readTools = toolLines(tools, "read");
  const writeTools = toolLines(tools, "write");
  const readCount = tools.filter((t) => t.scope === "read").length;
  const writeCount = tools.filter((t) => t.scope === "write").length;

  const httpConfig = JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          type: "http",
          url: endpoint,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json, text/event-stream",
          },
        },
      },
    },
    null,
    2,
  );

  const stdioConfig = JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          command: "node",
          args: [bridgePath],
          env: {
            QEXO_MCP_URL: endpoint,
            QEXO_MCP_TOKEN: "$QEXO_MCP_TOKEN",
          },
        },
      },
    },
    null,
    2,
  );

  const lines = [
    "# Qexo MCP 接入配置（请直接执行）",
    "",
    "你是一个支持 MCP（Model Context Protocol）的 AI agent。下面给出接入 Qexo 博客后台所需的**全部信息**。请按第 2 节写入配置，按第 3 节选择与你客户端匹配的变体，启用后用第 5 节的第一条指令验证。若某项不适用于你的客户端，采用第 3 节的回退方案，不要返回来向我追问缺失信息。",
    "",
    `## ${PROMPT_SECTIONS[0]}`,
    "",
    "| 项 | 值 |",
    "| --- | --- |",
    `| 服务名称 | ${code(serverName)} |`,
    `| 端点 URL | ${code(endpoint)} |`,
    "| 传输 | Streamable HTTP，POST JSON-RPC 2.0（单端点，无状态） |",
    `| 协议版本 | ${code(primary)}${protocols.length > 1 ? `（兼容 ${protocols.slice(1).map(code).join(" / ")}）` : ""} |`,
    "| 鉴权 | `Authorization: Bearer <令牌>` |",
    `| 令牌（仅本次可见） | ${code(token)} |`,
    `| 令牌作用域 | ${code(scopeText)} |`,
    `| 服务端版本 | ${code(appVersion)} |`,
    "| 附加能力 | `resources/list`、`resources/read`、`prompts/list`、`write_post` 提示词 |",
    "",
    "可选请求头：`Accept: application/json, text/event-stream`、`MCP-Protocol-Version: " + primary + "`（多数客户端自动添加）。服务端不签发 `Mcp-Session-Id`；`GET /mcp` 返回 405 属正常行为。",
    "",
    `## ${PROMPT_SECTIONS[1]}`,
    "",
    "把以下内容合并到你的 MCP 配置文件（标准键名 `mcpServers`；若客户端使用 `servers`，见第 3 节）：",
    "",
    "```json",
    httpConfig,
    "```",
    "",
    "写入位置：",
    "",
    "- WorkBuddy：`~/.workbuddy/mcp.json`（Windows：`C:\\Users\\<用户名>\\.workbuddy\\mcp.json`），保存后在「连接器 → 自定义 MCP」点击「信任」。",
    "- Claude Desktop / Cursor / 其它 MCP 客户端：各自的 MCP 配置文件，保存后重启或刷新服务器列表。",
    "- 已存在其它服务器时，只把 `qexo` 这一项合并进现有对象，不要覆盖整个文件。",
    "",
    `## ${PROMPT_SECTIONS[2]}`,
    "",
    "| 客户端情况 | 处理方式 |",
    "| --- | --- |",
    "| 标准 HTTP MCP（WorkBuddy、Cursor、Claude 新版等） | 直接使用第 2 节配置 |",
    "| 配置键名为 `servers` 而非 `mcpServers` | 把键名改成 `servers`，其余字段不变 |",
    "| 需要显式传输字段 | 增加 `\"transport\": \"streamable-http\"` |",
    "| 仅支持 stdio（Claude Desktop 旧版等） | 使用下方桥接配置，并把 `$QEXO_MCP_TOKEN` 替换为第 1 节令牌、`args` 替换为本机脚本路径 |",
    "| 无法修改配置文件、只能发 HTTP 请求 | 使用下方 JSON-RPC 调用示例，把 `$QEXO_MCP_TOKEN` 设为第 1 节令牌 |",
    "",
    "stdio 回退（桥接脚本在本项目 `mcp/stdio-bridge.mjs`，零依赖）：",
    "",
    "```json",
    stdioConfig,
    "```",
    "",
    "纯 HTTP 回退（不写配置文件，直接调用工具）：",
    "",
    "```bash",
    "export QEXO_MCP_TOKEN='<填入第 1 节的令牌>'",
    `curl -s '${endpoint}' \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "Accept: application/json, text/event-stream" \\',
    `  -H "MCP-Protocol-Version: ${primary}" \\`,
    '  -H "Authorization: Bearer $QEXO_MCP_TOKEN" \\',
    "  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'",
    "```",
    "",
    `## ${PROMPT_SECTIONS[3]}`,
    "",
    `当前令牌作用域：${code(scopeText)}。共 ${tools.length} 个工具，${canWrite ? "可调用全部工具" : "仅可调用下列只读工具；写工具会返回 `Insufficient scope`（预期行为）"}。`,
    "",
    `**只读工具（${readCount}）**`,
    "",
    ...readTools,
    "",
    `**写入工具（${writeCount}）**`,
    "",
    ...writeTools,
    "",
    `## ${PROMPT_SECTIONS[4]}`,
    "",
    "1. 写入配置并信任 / 启用 `qexo` 服务器（部分客户端需要重启）。",
    "2. 第一条验证指令：「列出我的博客文章，并告诉我总共有几篇」。成功后请回复「已连接 Qexo MCP，可用工具 N 个」。",
    "3. 常用指令：「读取某篇文章的正文」「新建一篇标题为 X 的草稿」「把草稿发布」「更新站点配置」「上传这张图片」「触发一次部署」。",
    "4. 删除文件必须显式确认：`delete_file` 传 `confirm: true`，否则工具会拒绝执行。",
    "5. 写操作会直接提交到 Git 博客仓库（可在提交历史追溯），并可能触发部署钩子；执行前请确认目标路径。",
    "6. 只读令牌不要尝试写工具；需要代写文章时请让我重新签发 write 令牌。",
    "",
    `## ${PROMPT_SECTIONS[5]}`,
    "",
    "- **本提示词包含明文令牌**：只发给你信任的 agent，不要粘贴到公开仓库、群聊或日志；泄露后到后台「MCP 接入」吊销并重建。",
    "- `401`：令牌错误或已吊销 → 重新创建令牌并更新配置。",
    "- `403 / Insufficient scope`：只读令牌调用了写工具 → 改用 write 令牌。",
    "- `429 / 读取仓库失败`：GitHub 接口限流 → 稍后重试。",
    "- 连接失败：确认端点可达、后台 MCP 开关为「已启用」、客户端已信任该服务器。",
    "- 连通性自测：`curl -s " + endpoint + " -H 'Authorization: Bearer $QEXO_MCP_TOKEN' -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"" + primary + "\",\"capabilities\":{},\"clientInfo\":{\"name\":\"check\",\"version\":\"1\"}}}'`。",
    "",
    "---",
    "",
    `生成规范：Qexo Agent Prompt v${PROMPT_SPEC.version} · ${PROMPT_SPEC.format} · 固定 ${PROMPT_SECTIONS.length} 段 · 配置块均为可直接解析的 JSON · 自包含（无需外部文档即可完成接入）。`,
  ];

  return lines.join("\n");
}
