# 项目交接手册 · qexo4workers

**Qexo → Cloudflare Workers 原生重写**

| 项 | 值 |
|---|---|
| 项目版本 | **1.0.0** |
| 交接日期 | 2026-11-14 |
| 代码仓库 | <https://github.com/tq4meishijia/qexo4workers> |
| 在线实例 | <https://qexo-workers.tq4meishijia.workers.dev> |
| 当前 Worker 版本 | `6da1f4ae-5bac-4185-8207-8d37521eeded` |
| 云账号 | `tq4meishijia@gmail.com`（Account ID `92d3a579…`） |
| 许可证 | GPL-3.0-or-later（上游 Qexo 衍生作品） |

---

## 1. 交接背景

### 1.1 起因与目标

原版 [Qexo](https://github.com/Qexo/Qexo) 是 Django 应用，需要常驻 Python 进程与本地文件系统。目标环境是 Cloudflare Workers Free：无容器、无磁盘、单请求 10 ms CPU、50 个子请求、D1/KV/R2 均有日配额。因此本项目的任务不是"移植"，而是**在 Workers 约束下重写一个功能对齐的后台**，同时保持：

- Git 仓库仍是唯一内容源，正文不进数据库；
- `/pub/*` 主题接口路径、字段与 token 鉴权语义不变，现有 Hexo 主题无需改动；
- 管理端可独立部署、可被 AI Agent 调用（MCP）；
- 全部功能可本地验收，不依赖真实 Cloudflare 账号即可跑通 e2e。

### 1.2 调研结论（决定架构的硬约束）

| 平台限制 | 数值 | 影响 |
|---|---|---|
| Workers Free | 100,000 请求/天、10 ms CPU/请求、50 子请求/请求、128 MB | 不能逐目录请求 Git，不能装框架，不能常驻缓存 |
| D1 Free | 500 万行读 / 10 万行写 / 天、单库 500 MB | 索引落库，避免重复读 Git |
| KV Free | 1,000 写 / 天 | 不依赖 KV，缓存退回 D1 |
| R2 Free | 10 GB 存储、零出口费 | 替代原版本地磁盘 Provider 与图片存储 |
| Pages Free | 500 次构建 / 月 | 实际瓶颈，不适合每次保存都触发构建 |

### 1.3 原始资料

上游源码副本位于工作区 `research/qexo-src/`（15,544 行 Python，**仅本地参考，未纳入交付仓库**）；功能/路由清单见 `docs/qexo-inventory.md`，官方限额抓取结果见 `docs/research-cloudflare.md`。

---

## 2. 当前进展

### 2.1 里程碑

| 阶段 | 状态 | 交付物 |
|---|---|---|
| S1 调研与功能清单 | ✅ 完成 | `docs/research-cloudflare.md`、`docs/qexo-inventory.md`、`docs/quota-analysis.md` |
| S2 Workers 原生后端 | ✅ 完成 | `src/*.ts`（12 个模块）、`migrations/0001_init.sql`（14 张表）、`wrangler.toml` |
| S3 管理前端 | ✅ 完成 | `src/ui/` 原生 SPA、独立 `/login`、7 语言词典 |
| S4 测试环境 | ✅ 完成 | `test/mock-github.mjs`、`test/e2e.mjs`、`test/ui-smoke.mjs`、`test/build-site.mjs` |
| S5 MCP 接入 | ✅ 完成 | `src/mcp.ts`（18 工具）、`mcp/stdio-bridge.mjs`、`docs/mcp.md`、后台 `#/mcp` 页 |
| S6 线上部署 | ✅ 完成 | D1 `qexo`、KV `qexo-cache`、Worker 部署与线上冒烟 |
| S7 登录与默认账号 | ✅ 完成 | 自动建号、服务端 302 守卫、默认密码警示条 |
| S8 内容源体验 | ✅ 完成 | Fine-grained PAT 链接、密钥健康检查、仓库/分支下拉、默认留空语义 |
| S9 文档与仓库化 | ✅ 完成 | README / handoff / 架构图 / 截图资源 / GitHub 仓库 |
| S10 版本号统一 | ✅ 完成 | `package.json`、`package-lock.json`、`QEXO_VERSION`、README / handoff 均为 `1.0.0` |
| S11 Agent 一键接入提示词 | ✅ 完成 | `src/ui/js/mcp-prompt.js` 纯函数 + 创建令牌弹窗自动生成 / 复制 + 结构规范文档 |

### 2.2 验收结果

| 套件 | 命令 | 结果 |
|---|---|---|
| 本地 API e2e | `npm test` | **56/56** |
| 本地浏览器 UI | `npm run test:ui` | **13/13** |
| 线上 API 冒烟 | `npm run test:prod` | **15/15，0 跳过** |
| 线上浏览器 | `node test/prod-ui.mjs` | **7/7** |
| 生产构建 | `npm run deploy:dry` | 470.85 KiB / gzip 100.11 KiB，启动约 7 ms |

线上已配置真实 Fine-grained PAT 与博客仓库 `tq4meishijia/hexo`，密钥检测返回 11 个可访问仓库、4 个分支；内容索引读到 2 篇文章、18 个配置。详见 `docs/test-report.md` 第 8 节。

### 2.3 线上资源清单

| 资源 | 标识 | 备注 |
|---|---|---|
| Worker | `qexo-workers` | 版本见页首；`wrangler.prod.toml` 为生产配置 |
| D1 | `qexo` / `e67e85cb-…`（APAC） | 迁移 `0001_init.sql` 已应用 |
| KV | `qexo-cache` / `e0892d23…` | 可选绑定，缺失不降级失败 |
| R2 | **未开通**（API 10042） | 生产配置未绑定；图床走 GitHub / S3 / Custom |
| Pages | 未由本项目创建 | 需连接博客源码仓库，见 `docs/deploy.md` |

### 2.4 关键实现索引

| 模块 | 职责 |
|---|---|
| `src/index.ts` | 自研 Router + `authed` / `staff` / `token` 中间件、页面守卫、41 个管理接口与旧路径别名 |
| `src/content.ts` | tree 索引、front-matter（`---` / `;;;`）、abbrlink（crc16/crc32 逐字节复刻）、发布/转草稿/重命名 |
| `src/vcs.ts` | GitHub（Contents + Trees、sha 复用）、GitLab、Gitea、R2 四个 Provider |
| `src/github.ts` | `/user` 校验、授权仓库分页（最多 300）、默认分支与分支列表 |
| `src/platforms.ts` | 7 种博客平台的目录 / 后缀 / 脚手架配置 |
| `src/store.ts` | 设置 15 s 内存缓存、D1 `cache` 30 s tree 快照 |
| `src/auth.ts` | PBKDF2-SHA256 100k、HMAC Cookie、CSRF 双提交、限流、reCAPTCHA |
| `src/mcp.ts` | Streamable HTTP、18 工具、资源/提示词、SHA-256 令牌与作用域 |
| `src/ui/js/mcp-prompt.js` | 与 DOM 解耦的提示词生成器：固定 6 段结构、11 项必备要素、令牌仅出现两次、HTTP/stdio/纯 HTTP 三套适配方案；Node 可直接单测 |
| `src/ui/js/provider-form.js` | PAT 链接、密钥检测、仓库/分支下拉、默认留空与空值拦截（初始化向导与设置页复用） |
| `src/api-app.ts` | 管理 API；`mergeSecrets` 只合并凭据字段，空 repo/branch 不回填 |

### 2.5 重要设计决策

| 决策 | 理由 | 可逆性 |
|---|---|---|
| 索引落 D1 而非每次读 Git | 列表/搜索零 Git 调用，规避 10 ms CPU 与 50 子请求限制 | 可清缓存重建 |
| GitHub Trees API 一次拉全量 | 逐目录请求会在大仓库触发子请求上限 | 可换分页策略 |
| 独立 `wrangler.prod.toml` | 避免把 `local-dev` 占位 ID 带到线上；R2 未开通时可只改生产配置 | 高 |
| MCP 令牌与登录会话分离 | Agent 使用独立可吊销凭据，不共享管理员 Cookie | 高 |
| 工具级越权返回 `isError` 而非 JSON-RPC error | 模型能读懂原因并向用户解释 | 高 |
| 页面守卫放在 Worker（`run_worker_first`） | 未登录 302 前不下发 SPA 空壳，避免"先加载再跳" | 高 |
| 内容源表单默认留空 | 避免用户误以为旧值已填写；空值由前后端明确拦截 | 高 |
| PAT 默认指向 Fine-grained 创建页 | 最小权限：单仓库 + 逐项权限 + 90 天过期 | 高 |

---

## 3. 待办事项

> 以下均为**已完成主体工作之后的后续项**，不阻塞当前交付。

| 优先级 | 事项 | 现状 | 验收标准 |
|---|---|---|---|
| P0 | 修改初始密码 | 线上仍为公开默认值，控制台持续警示 | 「账户」页改密后警示条消失，`/api/me` 的 `default_admin` 为 `false` |
| P0 | 固定 `SESSION_SECRET` | 首次登录自动生成并写入 D1，功能正常 | `wrangler secret put SESSION_SECRET` 后重新登录成功，旧会话按预期失效 |
| P1 | MCP 客户端联调 | 服务端 18 工具已验收，客户端未接 | WorkBuddy `~/.workbuddy/mcp.json` 信任后 `list_posts` 返回真实文章 |
| P1 | 创建 Pages 项目 | 未创建 | 连接博客源码仓库，`npm install && npx hexo generate` 输出 `public`；保存文章后自动重建 |
| P1 | 真实 Hexo 构建 | 本地 `build-site.mjs` 为等价简化实现 | 用真实主题与插件跑通 `hexo generate`，首页与文章页正常 |
| P2 | 开通并绑定 R2 | 账号未开通（10042） | 控制台开通 → 建桶 → 生产配置加 `[[r2_buckets]]` → 重新部署 → 图床上传可用 |
| P2 | Cloudflare Access | 未配置 | 对 `/` 与 `/api/*` 启用 Passkey/OTP，未授权请求被拦截 |
| P2 | 配额观测 | 未做生产压测 | 上线一周后记录 Workers 请求、D1 行读写、Pages 构建次数，接近 80% 时评估升级 |
| P3 | 可选增强 | 未做 | KV 冷启动缓存、图片 WebP 转换、Cron 清理过期会话、CI 自动跑 `npm test` |

---

## 4. 已知问题与边界

| # | 现象 | 影响 | 规避 / 说明 |
|---|---|---|---|
| 1 | R2 未开通（API 10042） | `r2` 图床与 `r2` 内容源线上不可用 | 生产配置不绑定 R2；图床用 GitHub / S3 / Custom；开通后加回绑定 |
| 2 | GitHub 匿名请求 403 | 未配 PAT 时公开仓库也读不到 | Cloudflare 出口 IP 共享 60 次/小时/IP 配额，**线上必须配 PAT**；空 Token 只读模式仅适合本地 |
| 3 | 默认密码为公开值 | 公网部署存在被接管风险 | 立即改密；建议叠加 Cloudflare Access；控制台已有常驻警示条 |
| 4 | `SESSION_SECRET` 未显式固定 | 自动生成值存于 D1，轮换时需重新登录 | 用 `wrangler secret put` 固定；不影响当前功能 |
| 5 | Passkey 未在应用层实现 | 与上游功能不完全对齐 | 用 Cloudflare Access 替代（边缘 Passkey/SSO），见迁移矩阵 #4 |
| 6 | 部分上游能力物理不可行 | FTP / 又拍 / Doge 图床（需 TCP）、云端 Python 脚本执行 | 已给出 HTTP / 部署流水线替代，见 `docs/migration-mapping.md` |
| 7 | MCP 协议基线 | 2026-07-28 的 `_meta` 新模型未实现 | 以 2025-06-18 握手为基线，兼容 2025-03-26 / 2024-11-05；主流客户端可正常接入 |
| 8 | 本地构建脚本非真实 Hexo | 不渲染主题与插件 | 上线前必须跑真实 `hexo generate`，见待办 P1 |
| 9 | 未验证真实账号 D1/R2/Pages 绑定全流程 | R2 与 Pages 链路仅按文档推演 | R2 开通、Pages 创建后按 `docs/deploy.md` 复跑 |
| 10 | 测试报告中的线上数字随配置变化 | 真实仓库已替换示例仓库 | 断言已改为按结构校验（如 `repo.includes("/")`），不再硬编码示例仓库名 |

---

## 5. 后续维护建议

### 5.1 日常运维

- 每次改动先本地跑 `npm test` + `npm run test:ui`，再 `npm run deploy:dry`，最后 `npm run deploy`；部署后用 `npm run test:prod` 与 `node test/prod-ui.mjs` 复验。
- 修改 D1 schema 时新增 `migrations/000N_*.sql`，本地与生产分别执行 `db:local` / `db:remote`，不要直接改 `0001_init.sql`。
- 前端 JS/CSS 由 Assets 直出；改动后浏览器需强制刷新（Ctrl+Shift+R）以避开缓存。

### 5.2 密钥与凭据

- GitHub PAT：使用 Fine-grained，只勾选博客仓库与 `Contents: Read and write`；设置 90 天到期并**定期轮换**。轮换后在「设置 → 内容源」粘贴新值并点「检测密钥」，确认仓库与分支下拉重新加载后再保存。
- MCP 令牌：只存 SHA-256，按 read/write 最小作用域签发；不用的令牌及时在 `#/mcp` 吊销。
- 会话密钥：用 `wrangler secret put SESSION_SECRET` 固定，不写入任何配置文件。
- **绝不提交**：`test/out/deploy-credentials.txt`、`.dev.vars`、任何 `github_pat_` / `qx_mcp_` 明文。它们已被 `.gitignore` 忽略；提交前用 `git status --short` 复核。

### 5.3 配额与成本

- 关注 Workers 请求数、D1 行读写、Pages 构建次数；Pages 500 次构建/月是最先触顶的资源。
- 密钥检测会调用 GitHub `/user` + 分页 `/user/repos`（最多 3 页）+ 分支接口；浏览器端有 60 秒内存缓存，避免反复点击消耗配额。
- 需要扩容量时按 `docs/quota-analysis.md` 第 5 节评估 Workers Paid / D1 付费档。

### 5.4 备份与回滚

- 后台「设置 → 高级」可导出 JSON 备份（设置、友链、说说、自定义字段等）；正文始终在 Git 仓库，仓库历史即天然备份。
- Worker 版本可在 Cloudflare 控制台回滚到上一 Version ID；数据库结构变更需同步回退迁移，避免不兼容。
- 站点构建失败时先查 Pages 构建日志，再核对内容源仓库的 `_config.yml` 与 `package.json`。

### 5.5 升级与协作

- 上游 Qexo 更新时，先对照 `docs/qexo-inventory.md` 判断新增功能是否受 Workers 限制；可行性评估参考 `docs/migration-mapping.md`。
- 新增 MCP 工具时：在 `src/mcp.ts` 注册 `TOOLS` 并声明 `scope`；提示词功能清单由 `/api/mcp` 动态读取，无需改 `mcp-prompt.js`，但需同步 `docs/mcp.md` 工具表与 `test/e2e.mjs` 用例数。
- 新增 API 时：在 `src/index.ts` 注册路由并复用 `authed` / `staff` / `token` 中间件，写操作必须校验 CSRF。
- 文档数字（测试通过数、版本号、包体）随版本更新，统一维护在 `README.md`、`docs/test-report.md`、本文件三处。

---

## 6. 快速定位

| 需求 | 去哪里 |
|---|---|
| 装起来跑一遍 | `README.md` 第 3 节 |
| 部署到自己的账号 | `docs/deploy.md` |
| 配 GitHub Token / 内容源 | `README.md` 第 4.4 节、`docs/deploy.md` 第 5.1 节 |
| 接 AI Agent | `docs/mcp.md` |
| 查验收证据 | `docs/test-report.md`、`docs/assets/` |
| 查功能对齐与缺口 | `docs/migration-mapping.md` |
| 查架构决策 | 本文件第 2.5 节、`docs/research-cloudflare.md` |
| 查配额推导 | `docs/quota-analysis.md` |
| 查线上故障 | `docs/deploy.md` 故障排查表、`docs/test-report.md` 第 8 节 |

---

交接完成 · 项目版本 v1.0.0 · 正确性由本次交付的测试与线上冒烟结果担保
