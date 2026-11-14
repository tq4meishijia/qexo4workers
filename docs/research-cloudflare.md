# Cloudflare Workers 能力边界调研

> 依据：Cloudflare 官方文档（2026-11 抓取），条目均给出文档页面。所有限额以 **Free 计划** 为准，Paid 计划差异单独标注。

## 1. 计算与请求模型

| 维度 | Free | Paid | 对 Qexo 的影响 |
|---|---|---|---|
| 请求数 | 100,000 / 天（UTC 零点重置） | 不限 | 管理后台 + 主题公开接口共用；按 3,000 次后台页面浏览/天估算仍有余量 |
| CPU 时间 | **10 ms / 请求** | 默认 30 s，可调至 5 min | 最硬的约束。禁止在热路径做大文件 YAML 解析、Markdown 全量渲染、图片转码 |
| 内存 | 128 MB / isolate | 同 | 足够；不能把整仓库读进内存 |
| 墙钟时间 | HTTP 请求无硬上限（客户端保持连接） | 同 | 可以等待 GitHub API 慢响应；`waitUntil` 最多延长 30 s |
| 子请求 | **50 / 请求** | 10,000 | 决定 Git API 调用策略：必须用一次 tree 拉全量，禁止逐文件探测 |
| 同时出站连接 | 6 | 6 | 并发上传/删除要限流（本实现 `mapLimit` 未在热路径使用） |
| Worker 体积 | 64 MiB（未压缩） | 同 | 本实现 bundle ≈ 200 KiB，i18n 词典走静态资源 |
| 启动时间 | 1 s | 同 | 全局作用域不做重活；`yaml` 解析延迟到请求内 |
| 环境变量 | 64 个 / 5 KB 每个 | 128 个 | Token 用 `wrangler secret`，不放 vars |
| 静态资源 | 20,000 文件 / 单文件 25 MiB | 100,000 | 管理端 SPA + 7 语言词典远低于上限 |

来源：<https://developers.cloudflare.com/workers/platform/limits/>

**结论**：Qexo 的 Django 同步模型（每请求多次 ORM 查询 + 模板渲染 + PyGithub 多轮调用）无法直接照搬。必须做到「一次请求 ≤ 3 次 D1 查询 + ≤ 2 次 Git 调用」。

## 2. 存储产品

### D1（关系型，SQLite 语义）

- Free：**5,000,000 行读 / 天**、**100,000 行写 / 天**、5 GB 总量、单库 500 MB
- 单次调用最多 **50 条查询**；SQL 语句 ≤ 100 KB；单行 ≤ 2 MB；绑定参数 ≤ 100
- 单库单线程，写延迟毫秒级；建议用 `batch()` 摊薄开销
- 不支持存储过程/触发器生态，`LIKE` 模式 ≤ 50 字节

来源：<https://developers.cloudflare.com/d1/platform/limits/>、<https://developers.cloudflare.com/d1/platform/pricing/>

**用途**：用户、会话、设置、内容索引、图片元数据、友链、说说、通知、PV/UV、部署日志。全部为小行，10 万行/天的写入额度对应约 3 万次页面浏览统计。

### KV

- Free：**100,000 读 / 天**、**1,000 写 / 天**、1 GB、单值 25 MiB
- 最终一致（跨机房最长 60 s），同 key 写 1 次/秒

来源：<https://developers.cloudflare.com/kv/platform/limits/>

**结论**：KV 的 1,000 次写/天不适合做内容缓存（一次保存要失效多个 key）。本实现把它列为**可选**绑定，缓存主用 D1 `cache` 表 + isolate 内存，KV 缺失时功能不降级。

### R2

- Free：10 GB-月、Class A 100 万次/月、Class B 1,000 万次/月、出网免费
- 与 Workers 同账号零出口费用

来源：<https://developers.cloudflare.com/r2/pricing/>

**用途**：原生图床 + `local` Provider 的替代实现（Qexo 的本地文件系统在 Workers 不存在）。

### Pages

- Free：**500 次构建/月**、同时 1 个构建、单站点 20,000 文件、单文件 25 MiB、构建超时 20 min
- Git 集成：push 即构建；也可用 Deploy Hook 触发

来源：<https://developers.cloudflare.com/pages/platform/limits/>

**用途**：博客前端托管与自动构建（验收环境即模拟此链路）。

## 3. 运行时能力与缺口

| 能力 | Workers | Qexo 依赖 | 处置 |
|---|---|---|---|
| HTTP 客户端 | `fetch`，无连接复用控制 | `requests` / PyGithub | 直接替换；注意 50 子请求预算 |
| 加密 | WebCrypto（SHA/HMAC/PBKDF2/AES/ECDSA） | Django PBKDF2、hashlib | 已用 PBKDF2-SHA256 100k 次 + HMAC 签名 Cookie |
| 文件系统 | ❌ 无 | 本地 Provider、备份、pip 升级 | 用 R2 替代；升级交给 `wrangler deploy` |
| 任意 TCP | ❌（除 `connect()` 到限定端口） | FTP 图床、SMTP 通知 | 不可迁移，改用 HTTP API |
| 长时间后台任务 | ❌（HTTP 无上限但随连接结束；`waitUntil` 30 s） | 同步阻塞构建 | 构建交给 Pages/CI，Worker 只发触发请求 |
| 常驻内存 | ❌（isolate 随时回收） | Django 全局 `_Provider` 缓存 | 改用 D1 + 30 s TTL 的 `cache` 表 |
| Python 运行时 | ❌ | Django、PyGithub、BeautifulSoup | 全量改写为 TypeScript |
| 定时任务 | Cron Triggers（Free 5 个/账号，CPU 10 ms） | 无 | 可选：清理过期会话 |
| WebSocket | ✅ | 无 | 未使用 |
| Node 兼容 | `nodejs_compat` 标志 | — | 已开启，便于 `yaml` 等纯 JS 包运行 |

## 4. 平台特有优势（迁移中主动利用）

1. **边缘缓存**：`caches.default` 缓存 `/pub/status`、`/pub/talks` 等公开响应，不占 D1 读额度。
2. **静态资源与 API 同源**：SPA 由 Assets 直接返回，只有 `/api/*`、`/pub/*` 进入 Worker，省 CPU。
3. **Cloudflare Access**：可对 `/api/*` 加一层 Zero Trust（含 Passkey/SSO），替代 Qexo 的 django-passkeys。
4. **Pages Deploy Hook / GitHub Actions**：替代 Qexo 的 Vercel 一键部署。
5. **D1 Time Travel**：Free 7 天任意时间点恢复，替代 Qexo 的手工备份（仍保留 JSON 导出）。

## 5. 不可迁移清单（明确边界）

| Qexo 功能 | 原因 | 替代 |
|---|---|---|
| `local` Provider（读写磁盘） | Workers 无文件系统 | `r2` Provider（同一套路径语义） |
| 本地一键升级（下载 tarball、`pip install`、重启进程） | 无进程/包管理 | `wrangler deploy` 或 Git 集成；保留版本检查 |
| 云端命令库（`exec` 远程 Python） | 无 Python、且任意代码执行违反最小权限 | 移除；运维动作改为部署流水线 |
| FTP / 又拍云 / DogeCloud 图床 | 需要 FTP/TCP 或厂商 SDK | R2 / S3 兼容 / Custom HTTP |
| SMTP 通知 | 无原始 TCP | HTTP 通知（Telegram、ServerChan、Bark、自定义 WebHook） |
| django-passkeys | 框架依赖 | Cloudflare Access（推荐）或后续用 WebCrypto 自建 WebAuthn |
| Vercel 文件级部署 | 平台专用 API | Pages Deploy Hook / Actions `workflow_dispatch` |

## 6. 对架构的硬性推论

1. **Git 是唯一内容源**，D1 只存索引与元数据；索引可随时重建（`/api/posts/refresh`）。
2. **每次保存 ≤ 2 次 Git 调用**：`PUT contents` 需要 sha 时先 `GET`，或复用 tree 中的 blob sha。
3. **tree 快照缓存 30 s**（D1 `cache` 表），列表页零 Git 调用。
4. **设置读走 isolate 内存 15 s TTL**，写时同步失效；跨 isolate 最坏 15 s 收敛，单管理员场景可接受。
5. **CPU 预算**：内容列表只查 D1（<1 ms）；YAML 解析仅发生在配置编辑/保存（一次性 2–5 ms）；登录 PBKDF2 走 WebCrypto 原生实现。
