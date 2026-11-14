# MCP 接入（AI Agent）

Qexo Workers 内置 **Model Context Protocol** 服务端，WorkBuddy、Claude Desktop、Cursor 等支持 MCP 的 agent 可以直接读取与改写你的博客，无需再手工调 API。

## 1. 端点与协议

| 项 | 值 |
|---|---|
| 端点 | `https://<你的域名>/mcp` |
| 传输 | Streamable HTTP（单端点，POST JSON-RPC 2.0） |
| 协议版本 | `2025-06-18`（默认）、`2025-03-26`、`2024-11-05` |
| 响应格式 | `application/json`（不启用 SSE 流；GET 返回 405，符合规范） |
| 会话 | 无状态，不签发 `Mcp-Session-Id`（规范允许） |
| 鉴权 | `Authorization: Bearer qx_mcp_...` |

> 说明：MCP 2026-07-28 版改为「请求体携带 `_meta` 元数据、取消 initialize 握手」的新模型，目前主流客户端仍使用 2025-06-18 握手；本实现以 2025-06-18 为基线，并对更早版本做兼容。
> 对未列出的版本号，服务端按 2025-06-18 协商而不是返回 400——这是与规范的一处有意偏差，目的是让新客户端至少能完成握手并在失败时给出可读错误。

## 2. 创建令牌

后台 → **MCP 接入** → 创建令牌：

- `read`：读取文章、页面、配置、图床、友链、说说、统计；
- `write`：在 read 之上允许新建/修改/发布/删除、保存配置、上传图片、触发部署。

令牌形如 `qx_mcp_<64 hex>`，只在创建时显示一次；服务端仅存 SHA-256。可随时吊销，吊销后客户端下一次调用即 401。

## 3. 客户端配置

### 3.1 WorkBuddy

编辑 `~/.workbuddy/mcp.json`（Windows：`C:\Users\<你>\.workbuddy\mcp.json`）：

```json
{
  "mcpServers": {
    "qexo": {
      "type": "http",
      "url": "https://qexo.example.com/mcp",
      "headers": {
        "Authorization": "Bearer qx_mcp_xxxxxxxx"
      }
    }
  }
}
```

保存后在「连接器 → 自定义 MCP」中点击 **信任** 启用。之后可以直接对 agent 说：

- 「列出我博客里最近的文章」
- 「把 source/_drafts/hello.md 发布」
- 「给《Cloudflare Workers 冷启动》加一段结尾并保存」

### 3.2 仅支持 stdio 的客户端（Claude Desktop 等）

仓库自带零依赖桥接脚本 `mcp/stdio-bridge.mjs`，把 stdio 的 JSON-RPC 转发到远端 `/mcp`：

```json
{
  "mcpServers": {
    "qexo": {
      "command": "node",
      "args": ["C:/path/to/qexo-workers/mcp/stdio-bridge.mjs"],
      "env": {
        "QEXO_MCP_URL": "https://qexo.example.com/mcp",
        "QEXO_MCP_TOKEN": "qx_mcp_xxxxxxxx"
      }
    }
  }
}
```

### 3.3 连通性自测

```bash
curl -s https://qexo.example.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $QEXO_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 3.4 Agent 配置提示词（一键接入）

**生成时机**：在后台「MCP 接入」创建令牌成功的同时，由前端纯函数 `src/ui/js/mcp-prompt.js` 自动生成。因为服务端只存令牌的 SHA-256，明文与提示词都**只在创建弹窗中出现一次**，关闭后无法重新生成，需重建令牌。弹窗提供「复制 Agent 配置提示词」「复制 HTTP 配置」「仅复制 Token」三个按钮，复制逻辑带 `document.execCommand` 回退，非安全上下文也能使用。

复制后可直接把整段文本发给任意 AI agent（WorkBuddy、Claude、Cursor 或其它支持 MCP 的助手），对方无需再追问任何信息即可完成接入。

#### 内容要素

| 要素 | 具体值 / 来源 |
|---|---|
| 令牌 | `qx_mcp_<64 hex>`，明文，仅在第 1 节表格与第 2 节配置块出现两次 |
| 接入地址 | `/api/mcp` 返回的 `endpoint`（优先 `PUBLIC_ORIGIN`，否则请求域名） |
| 传输与协议 | Streamable HTTP / JSON-RPC 2.0；`2025-06-18`，兼容 `2025-03-26`、`2024-11-05` |
| 配置参数 | `mcpServers.qexo.type = http`、`url`、`headers.Authorization`、`headers.Accept` |
| 客户端适配 | `servers` 键名替换、`transport: streamable-http`、stdio 桥接配置、纯 HTTP JSON-RPC 回退 |
| 功能列表 | 18 个工具，按 `read` / `write` 分组，名称与描述来自 `/api/mcp` 的 `tools` |
| 作用域说明 | 当前令牌 `read` / `read + write`；只读令牌明确写出 `Insufficient scope` 属预期 |
| 使用说明 | 写入配置 → 信任/启用 → 首条验证指令 → 常用指令 → `delete_file` 必须 `confirm: true` |
| 安全与排错 | 明文令牌保管、401/403/429 处理、连通性自测命令 |
| 完成回执 | 要求 agent 回复「已连接 Qexo MCP，可用工具 N 个」 |

#### 结构与格式规范（v1.0）

提示词为**纯 Markdown、无 HTML**，固定 6 个二级标题，顺序不可调换：

| # | 章节 | 承载内容 |
|---|---|---|
| 1 | 连接信息 | 表格 + 令牌 / 端点 / 协议 / 作用域 / 服务端版本 |
| 2 | 标准配置（HTTP MCP，优先使用） | 可直接解析的 `json` 代码块 + 各客户端写入位置 |
| 3 | 客户端适配规则 | 适配表格 + stdio `json` 回退 + 纯 HTTP `bash` 回退 |
| 4 | 可用功能清单 | 只读/写入工具分组列表，含数量与描述 |
| 5 | 使用说明 | 有序步骤、验证指令、写操作约束 |
| 6 | 安全与排错 | 明文警告、错误码处理、连通性自测 |

格式规则：

1. 一级标题 1 个；二级标题 6 个，顺序与 `PROMPT_SECTIONS` 常量一致。
2. 配置一律放在带语言标签的代码块（`json` / `bash`），保证可解析、可整段复制。
3. 连接信息用表格，功能清单用分组列表，适配规则用表格；中文叙述 + 英文标识符原样保留。
4. 令牌只出现在第 1 节与第 2 节；其它示例统一用 `$QEXO_MCP_TOKEN` 占位，由 agent 从提示词内部自行代入。
5. 自包含：不引用外部文档、不要求用户补充信息；任何不适用的客户端都有第 3 节的回退方案。
6. 末尾附生成规范说明与完成回执要求，便于 agent 确认接入结果。

#### 适配不同 AI agent

| 客户端 | 提示词中的对应方案 |
|---|---|
| WorkBuddy | 第 2 节配置写入 `~/.workbuddy/mcp.json`，再点「信任」 |
| Claude Desktop / Cursor（新版 HTTP MCP） | 第 2 节配置写入各自 MCP 配置文件，重启或刷新 |
| 配置键为 `servers` 的客户端 | 第 3 节：把 `mcpServers` 改成 `servers`，其余不变 |
| 需要显式传输字段 | 第 3 节：增加 `"transport": "streamable-http"` |
| 仅支持 stdio 的客户端 | 第 3 节：使用 `mcp/stdio-bridge.mjs` 桥接配置 |
| 无法写配置文件、只能发 HTTP 请求 | 第 3 节：`tools/list` 的 JSON-RPC `curl` 示例，agent 可直接调用 |

> 提示词包含明文令牌，只发给信任的 agent；不要粘贴到公开仓库、群聊或日志。泄露后在后台吊销该令牌并重新创建。

## 4. 工具目录（18 个）

| 工具 | 权限 | 说明 |
|---|---|---|
| `qexo_overview` | read | 内容源、平台、文章/草稿/页面数量、PV/UV |
| `list_posts` | read | 列表 + 搜索 + 状态过滤 |
| `get_post` | read | front-matter 与正文 |
| `list_pages` | read | 独立页面列表 |
| `list_configs` | read | 配置文件列表 |
| `get_config` | read | 配置全文 |
| `list_images` | read | 图床记录 |
| `list_friends` | read | 友链（含隐藏） |
| `list_talks` | read | 说说分页 |
| `get_statistics` | read | PV/UV 与热门页面 |
| `create_post` | write | 新建（默认草稿，`publish=true` 直接发布） |
| `update_post` | write | 改正文/front-matter/发布状态 |
| `publish_post` | write | 草稿 → 正式 |
| `unpublish_post` | write | 正式 → 草稿 |
| `delete_file` | write | 删除，必须 `confirm=true` |
| `save_config` | write | 保存配置，YAML/JSON 先校验 |
| `upload_image` | write | base64 或 URL 上传到已配置图床 |
| `trigger_deploy` | write | 触发 Pages/Vercel/自定义构建 |

**资源**：`qexo://status`、`qexo://posts`、`qexo://config/<urlencoded path>`，支持 `resources/list` 与 `resources/read`。
**提示词**：`write_post`（参数 `topic`、`tone`、`publish`），可直接在客户端选择。

## 5. 协议行为

| 请求 | 行为 |
|---|---|
| `initialize` | 返回 `protocolVersion`（回显客户端版本）、`capabilities.tools/resources/prompts`、`serverInfo` |
| `notifications/initialized` | `202 Accepted`，空响应体 |
| `tools/list` | 18 个工具，含 `inputSchema` 与 `annotations.readOnlyHint/destructiveHint` |
| `tools/call` | 成功返回 `content`（文本）+ `structuredContent`（结构化）；工具内错误返回 `isError:true` |
| `resources/list` / `read` | 配置与状态资源 |
| `prompts/list` / `get` | 写作提示词 |
| 未知方法 | JSON-RPC `-32601` |
| 参数错误 | `-32602` |
| 解析失败 | `-32700`（HTTP 400） |
| 令牌无效 | HTTP 401 + `WWW-Authenticate: Bearer` |
| 批量请求 | 拒绝（2025-06-18 已移除 JSON-RPC batch） |

权限不足返回**工具错误**（`isError:true`，文案 `Insufficient scope: write required`），而不是 JSON-RPC 错误，便于模型向用户解释原因。

## 6. 安全

1. **仅 HTTPS**：Bearer 令牌明文传输只允许在 TLS 下；本地验收用 `http://127.0.0.1`。
2. **最小权限**：默认只发 `read`；需要 agent 代写时再单独创建 `write` 令牌，可命名为「写作助手」以便审计。
3. **删除需二次确认**：`delete_file` 强制 `confirm=true`，避免模型误删。
4. **可吊销 + 最近使用时间**：后台可见每个令牌的最后调用时间（每小时最多更新一次，节省 D1 写额度）。
5. **Origin 校验**：拒绝 `Origin: null` 与非 http(s) 来源；远程客户端通常不带 Origin。
6. **叠加 Access**：如需更强控制，可在 Cloudflare Access 对 `/mcp` 再加一层 SSO/Passkey，令牌仍作为第二因素。
7. **审计**：MCP 写入沿用与后台相同的逻辑，仓库提交信息为 `Save Post … by Qexo`，可在 Git 历史中追溯。

## 7. 成本

| 操作 | Git 调用 | D1 写 |
|---|---|---|
| `tools/list` / `initialize` | 0 | 0（令牌 last_used 每小时最多 1 次） |
| `list_posts`（缓存有效） | 0 | 0 |
| `get_post` | 1 | 0 |
| `create_post` / `update_post` | 1–2 | 2–4 |
| `upload_image` | 0（R2） | 1 |

MCP 调用与后台共用同一套免费额度；单次工具调用远低于 50 子请求与 10 ms CPU 预算。

## 8. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 401 Unauthorized | 令牌错/已吊销/被停用 | 重新创建令牌；确认 MCP 处于「已启用」 |
| 405 Method Not Allowed | 客户端发 GET 建 SSE | 本服务不提供 SSE 流，改用 POST；多数客户端会自动回退 |
| `-32601 Method not found` | 客户端用了未实现的方法 | 只支持上表方法；`logging/setLevel` 等可选方法未实现 |
| 工具返回 `Insufficient scope` | 用了 read 令牌调写工具 | 换 write 令牌 |
| 工具返回 `GitHub API 403: rate limit exceeded` | 内容源未配置 Token，Cloudflare 出口共享匿名配额 | 在「设置 → 内容源」填入 GitHub PAT |
| `尚未配置内容源` | Provider 未配置 | 先在「设置 → 内容源」完成配置 |
| `deploy is not configured` | 未配置部署方式 | 在「设置 → 部署」填写 Hook，或忽略该工具 |
| 客户端看不到服务器 | 配置未信任 / URL 错 | 检查 `mcp.json` 路径与 `/mcp` 后缀；在客户端点「信任」 |
