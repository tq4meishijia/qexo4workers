# 迁移映射与功能对齐

## 1. 模块级映射

| Qexo（Python/Django） | Workers 实现 | 说明 |
|---|---|---|
| `core/urls.py` 路由 | `src/index.ts`（自研 Router） | 零依赖，正则匹配，兼容原有路径 |
| `hexoweb/models.py` | `migrations/0001_init.sql` + `src/store.ts` | 10 张表合并为 13 张（含 sessions/cache/rate_limits/deploy_logs） |
| `functions.py::get_setting*` | `Store` 类 | isolate 内存 15 s TTL + D1 真源；写入即失效 |
| `functions.py::update_caches` | `cache` 表 + `cacheGet/cacheSet` | 30 s TTL 的 tree 快照 |
| `functions.py::get_post_details` | `content.ts::parseFrontMatter` | 支持 `---` / `;;;` 与模板变量 |
| `functions.py::get_crc16/32` | `content.ts::crc16/crc32` | 逐字节复刻（含 Qexo 的字节拼接与 dec/hex 差异） |
| `functions.py::verify_provider` | `ContentService.verify` | 检查 `_config.yml`、`package.json`、`source/`、`themes/`、`index.html` |
| `libs/platforms/core.py` | `content.ts::ContentService` | 目录扫描、发布/转草稿、重命名、配置读写 |
| `libs/platforms/configs/*.py` | `platforms.ts` | 7 个平台配置逐字段搬运（名称大小写也对齐：`Vuepress`/`Vitepress`） |
| `libs/platforms/providers/gitHub.py` | `vcs.ts::GitHubProvider` | Contents + Trees API；sha 复用，避免额外 GET |
| `gitLab.py` / `gitEa.py` | `GitLabProvider` / `GiteaProvider` | REST v4 / v1，分页拉 tree |
| `local.py`（磁盘） | `R2Provider` | 同一路径语义，对象存储替代文件系统 |
| `libs/image/providers/*` | `images.ts` | R2 / GitHub / S3(SigV4) / Custom；`关闭` 保留 |
| `libs/onepush/*` | `api-public.ts::notify` | Telegram / ServerChan / Bark / Custom |
| `core/session_engine.py` | `auth.ts` | 签名 Cookie + D1 会话 + CSRF 双提交 |
| `decorators.py` | `auth.ts` + `index.ts` 高阶函数 | `authed` / `staff` / `token` 三层 |
| `pub.py` | `api-public.ts` | 25 个公开接口，路径与 JSON 字段保持 |
| `api.py` | `api-app.ts` | 41 个管理接口 + 兼容别名 |
| `templates/*.html` | `src/ui/`（原生 SPA） | 功能等价，去掉 Argon/CDN 依赖 |
| `libs/i18n/*` | `src/ui/locales/*.json` | 7 份词典用脚本原样导出，服务端 `translator()` 复用 |
| `init.py` 四步向导 | `apiInitStep` + `#/init` | 步进值 INIT 2→3→4→5→6 一致 |
| `libs/elevator`（自升级） | `wrangler deploy` / Git 集成 | 仅保留版本检查 |
| `run_online_script`（exec Python） | — | 移除（平台不可行 + 最小权限） |

## 2. 功能对齐矩阵

图例：✅ 原生实现 ｜ 🔁 等价替代 ｜ ⛔ 平台不可行（已给替代路径）

| # | 功能 | 状态 | 实现/替代 |
|---|---|---|---|
| 1 | 初始化向导（4 步） | ✅ | 语言/管理员/内容源/部署 |
| 2 | 用户名密码登录 | ✅ | PBKDF2-SHA256 100k + 会话 Cookie |
| 3 | reCAPTCHA v2/v3 | ✅ | 服务端 `siteverify`，前端动态加载 |
| 4 | Passkey 登录 | 🔁 | 推荐 Cloudflare Access（Zero Trust 免费 50 用户，支持 Passkey/SSO）；应用层未内置 WebAuthn |
| 5 | 文章 CRUD | ✅ | 新建/编辑/草稿/发布/转草稿/重命名/删除 |
| 6 | 草稿与发布互转 | ✅ | 写正式目录 + 删草稿，或反向 |
| 7 | 页面 CRUD | ✅ | 路径直写，支持嵌套 |
| 8 | front-matter 编辑 | ✅ | 独立字段 + 其他字段 JSON |
| 9 | abbrlink（crc16/crc32） | ✅ | 算法与输出格式完全对齐 |
| 10 | 自动摘要 | ✅ | 本地算法 + 保存时按配置注入 |
| 11 | 配置扫描/编辑 | ✅ | YAML/JSON 语法校验，TOML/JS/TS 原样保存 |
| 12 | 7 种博客平台 | ✅ | 路径/深度/扩展名/脚手架全量搬运 |
| 13 | GitHub/GitLab/Gitea | ✅ | 统一 Provider 接口 |
| 14 | 本地 Provider | 🔁 | R2 Provider |
| 15 | 图床上传/删除 | ✅ | R2、GitHub、S3、Custom；FTP/又拍/Doge/CFImgBed ⛔ |
| 16 | 图床元数据 | ✅ | D1 `images`，含 `delete_config` 同步删除 |
| 17 | 友链 CRUD/显隐 | ✅ | 含公开列表 `/pub/friends` |
| 18 | 友链申请 + 验证码 | ✅ | 限流 5 次/小时 + 通知 |
| 19 | 说说 CRUD/分页 | ✅ | `/pub/talks` 字段对齐 |
| 20 | 说说点赞（IP 去重） | ✅ | `/pub/like_talk`，返回 `action` |
| 21 | PV/UV 统计 | ✅ | 域名白名单，`site_pv/page_pv/site_uv` |
| 22 | 站内通知 | ✅ | 列表/新增/删除/清空 |
| 23 | OnePush 推送 | 🔁 | 4 个 HTTP 通道；SMTP/QQ 等 ⛔ |
| 24 | WebHook 自动创建 | ✅ | GitHub/GitLab/Gitea hooks |
| 25 | WebHook 收包清缓存 | ✅ | `/api/webhook?token=`，SHA-256 比对 |
| 26 | 自定义字段 | ✅ | `/api/custom` + `/pub/get_custom` |
| 27 | 侧边栏/摘要/CDN/abbrlink 设置 | ✅ | 原字段名保留 |
| 28 | 导入/导出 | ✅ | JSON 备份，保留原表结构字段 |
| 29 | 自动修复配置 | ✅ | 补默认项，返回修复数量 |
| 30 | 缓存清理 | ✅ | D1 cache + 内存 + Cache API |
| 31 | 版本检查 | ✅ | GitHub Releases，6 h 缓存 |
| 32 | 一键自升级 | 🔁 | `wrangler deploy` / Git 集成 |
| 33 | 云端脚本执行 | ⛔ | 移除（无 Python，且不宜远程执行任意代码） |
| 34 | 多语言（7 种） | ✅ | 词典原样保留；新 SPA 界面中英双语，其余语言回退英文 |
| 35 | 部署触发 | ✅ | Pages Hook / Vercel Hook / Actions dispatch / 自定义 |
| 36 | 主题公开接口 | ✅ | `/pub/*` 路径与字段不变，含 token 鉴权 |
| 37 | MCP / AI Agent 接入 | ✅＋ | 上游无此能力；本实现新增 `/mcp`，18 个工具、read/write 令牌、资源与提示词 |

**覆盖率**：37 项中 ✅ 30 项（含 1 项新增能力）、🔁 5 项、⛔ 2 项。所有 ⛔ 项均属平台物理限制，且均给出可落地的替代方案。

## 3. 接口兼容策略

1. **路径不变**：`/api/save_post`、`/api/set_hexo`、`/pub/get_posts` 等原样保留；新增 REST 风格路径（`/api/posts`、`/api/friends`）供新 SPA 使用。
2. **表单兼容**：`readBody` 同时接受 `application/json`、`x-www-form-urlencoded`、`multipart/form-data`；旧脚本用表单提交也能工作。
3. **响应信封不变**：`{ status: boolean, msg: string, ... }`；列表额外保留 `posts/pages/configs/images/friends/talks` 等原字段名。
4. **密钥不回显**：`PROVIDER.params.token`、`IMG_HOST` 敏感项返回 `******`，提交时若为掩码则沿用旧值。
5. **鉴权语义不变**：`/pub/*` 的 `token` 参数与 `WEBHOOK_APIKEY` 的 SHA-256 比对；`/api/webhook` 同样。

## 4. 新增能力（上游没有）

### MCP 服务端（`src/mcp.ts`）

- 端点 `/mcp`，Streamable HTTP（2025-06-18），JSON-RPC 2.0，无状态（不签发 session）。
- 18 个工具：10 个只读 + 8 个写入；`tools/call` 返回 `content` 文本 + `structuredContent`。
- 资源 `qexo://status`、`qexo://posts`、`qexo://config/<path>`；提示词 `write_post`。
- 令牌 `qx_mcp_*` 仅存 SHA-256，支持 read/write 作用域、吊销、最近使用时间（每小时最多写一次）。
- stdio 客户端通过 `mcp/stdio-bridge.mjs` 桥接；详见 `docs/mcp.md`。

设计取舍：不复用 `WEBHOOK_APIKEY`（那是给 `/pub/*` 的单密钥），因为 agent 需要独立吊销与最小权限；不实现 SSE 服务端推送，因为本服务的工具调用均为短请求，JSON 响应更省 CPU 与连接数。

## 5. 有意变更（需在升级说明中告知）

| 变更 | 原因 | 影响 |
|---|---|---|
| 静态资源不再从 `qexo-static` CDN 加载 | 自包含 SPA，减少外部依赖 | `CDN_PREV` 仅作为历史设置保留 |
| Passkey 由应用层移到 Access 层 | 避免在 Worker 内实现完整 WebAuthn 验证链 | 需在 Cloudflare 控制台配置 Access 策略 |
| `local` Provider 改名为 `r2` | 无文件系统 | 老配置 `provider: local` 自动映射到 R2 |
| 云端脚本功能移除 | 平台不可行 | 原「高级 → 云端命令」入口不再提供 |
