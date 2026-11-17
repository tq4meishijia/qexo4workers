# 项目交接手册 · qexo4workers

**Qexo → Cloudflare Workers 原生重写**

| 项 | 值 |
|---|---|
| 项目版本 | **1.6.0** |
| 交接日期 | 2026-11-14 |
| 代码仓库 | <https://github.com/tq4meishijia/qexo4workers> |
| 示例地址 | `https://qexo.example.com`（真实部署地址不入库；测试时用 `QEXO_BASE_URL` 指定） |
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
| S8 内容源体验 | ✅ 完成 | Fine-grained PAT 链接、密钥健康检查、仓库/分支下拉、已保存值回填与空值拦截 |
| S9 文档与仓库化 | ✅ 完成 | README / handoff / 架构图 / 截图资源 / GitHub 仓库 |
| S10 版本号统一 | ✅ 完成 | `package.json`、`package-lock.json`、`QEXO_VERSION`、README / handoff 与版本断言均为 `1.1.0` |
| S11 Agent 一键接入提示词 | ✅ 完成 | `src/ui/js/mcp-prompt.js` 纯函数 + 创建令牌弹窗自动生成 / 复制 + 结构规范文档 |

### 2.2 验收结果

| 套件 | 命令 | 结果 |
|---|---|---|
| 本地 API e2e | `npm test` | **58/58** |
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
| `src/ui/js/provider-form.js` | PAT 链接、密钥检测、仓库/分支下拉、已保存值回填与空值拦截（初始化向导与设置页复用） |
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
| 内容源表单回填已保存值 | 重开配置页应显示当前仓库与分支；清空字段仍由前后端明确拦截，避免静默沿用旧值 | 高 |
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

交接完成 · 项目版本 v1.1.0 · 正确性由本次交付的测试与线上冒烟结果担保

---

## 7. 浏览器全量 QA 补充（2026-11-14 晚）

本轮对 v1.0.0 管理后台做了 48 例真实浏览器操作验证（45 通过 / 2 失败 / 1 阻塞），随后完成修复与回归：**49/49、UI 13/13、API 58/58、构建通过**。

- **P1（已修复）**：`#/talks` 说说页整体渲染失败（`debounce is not defined`）→ `src/ui/js/social.js` import 补 `debounce`；后端 `/api/talks` 一直正常。
- **P2（已修复）**：弹窗遮罩拦截侧栏导航 → `core.js` 的 `renderRoute()` 关闭遗留弹窗 + `closeModal()` 保护 + Esc 关闭，`style.css` 提升 `.sidebar` 层级至 70（高于遮罩 60）。
- **P3（已处理）**：图床未配置引导条、toast 去重与上限、README/handoff 测试数字统一为 58/58、回归脚本新增 E4。
- **保留项**：匿名 `/api/me` 的 `default_admin` —— 登录页初始账号提示依赖该字段，风险继续由 README §7 标注。
- **工具偏差**：`ego-browser` CLI / ego lite 运行时在本机不可用，经用户确认改用 `playwright-core` + 本机 Edge；ego 版复跑脚本状态仍为 **NOT RUN**。

引用（不重复正文）：

- 完整用例表、偏差、修复清单与回归证据：`docs/ego-browser-test-report.md`（§0 状态更新、§11 修复与回归）
- 机器可读结果：`test/out/browser-qa-report.json`
- 截图证据：`test/out/qa-*.png`
- 已执行脚本 / 服务栈 / ego 复跑脚本：`test/browser-qa.mjs`、`test/ego-serve.mjs`、`test/ego-qa.mjs`
- **版本**：该轮修复与版本字段同步为 **v1.0.1**（2026-11-15），对应 Git 标签 `v1.0.1`；历史记录保留不改。
- 待办（已由 v1.1.0 关闭）：线上 Worker 一度仍为修复前版本，见下方 §8。

---

## 8. v1.1.0 发布（2026-11-15）

- **内容**：设置页新增「外观」标签，6 套面板主题一键切换；选择通过 Cookie `qexo_ui_style` 持久化，刷新／重新访问自动恢复，缺失或无效值回退默认主题 `midnight`。主题集中配置在 `src/ui/js/style-library.js` 的 `THEMES` 数组，其余 token 由 `buildTokens()` 派生。
- **版本字段**：`package.json`、`package-lock.json`（根与 `packages[""]`）、`src/store.ts` 的 `QEXO_VERSION`、README 徽章／版本表／页脚、`src/ui/js/mcp-prompt.js` 与 `mcp.js` 的回退值、`test/e2e.mjs`（2 处）、`test/prod-smoke.mjs`、`test/prod-ui.mjs` 的版本断言，全部同步为 `1.1.0`。历史报告与 `test/fixture/repo/package.json` 的基线版本按原样保留。
- **验证**：`npm test` 58/58、`npm run test:ui` 17/17、`test/browser-qa.mjs` 49/49、`npm run deploy:dry` 通过。
- **发布**：提交推送至 `main`，附注标签 `v1.1.0`；执行 `npm run deploy` 部署 Worker，关闭 §7 遗留的部署待办。

---

## 9. 内容源已保存值回填修复（2026-11-15）

- **现象**：配置好内容源后再次打开「设置 → 内容源」，仓库与分支下拉只显示占位项；已保存的仓库/分支仅以一行灰色说明出现，控件中看不到当前内容源。
- **根因**：`src/ui/js/provider-form.js` 把「默认留空」写成硬编码（初始 `repoOptions([], "")` 与空分支下拉），`applyRepos()` 明确禁止加载选项时填充字段。后端 `/api/settings` 已返回未掩码的 repo / branch（只掩码 token 类字段），数据链路无缺口，属纯前端回填缺失。
- **改动**：
  - `src/ui/js/provider-form.js`：已保存值作为真实 option 渲染并选中（标注「当前配置」）；列表刷新保留选中；密钥有效时自动载入该仓库的完整分支列表并保留当前分支；显式切换仓库清空旧分支，用请求序号丢弃过期分支响应；说明文字改为「已自动回填，可直接保存」。
  - `src/ui/js/settings.js`：切换仓库类型后切回已配置类型时恢复已保存值，切到其它类型仍从空表单开始。
  - `src/api-app.ts`：仅修正 `saveProvider` 中「表单从不预填」的过时注释。空 repo/branch 仍由前后端明确拒绝，token 仍由 `mergeSecrets` 保留，安全语义未变。
  - 测试：`test/ui-smoke.mjs`、`test/browser-qa.mjs`、`test/prod-ui.mjs` 相应断言改为「回填 + 刷新保持 + 切换仓库清空分支」，保留空值保存拦截覆盖。
  - 文档：`README.md`、`docs/deploy.md`、本文件 §2.4 / §2.5 同步；`docs/test-report.md` §10 与 `docs/ego-browser-test-report.md` §11.4 追加历史注记，历史验收数字不改。
- **验证**：`npm test` 58/58、`npm run test:ui` 18/18、`node test/browser-qa.mjs` 49/49、`npx tsc --noEmit` 通过、`npm run deploy:dry` 通过（470.85 KiB / gzip 100.11 KiB）。
- **发布**：本修复随 `v1.1.1` 提交推送（见 §10）。
- **未竟事项**：线上 Worker 仍为旧版，部署后需跑 `npm run test:prod` 与 `node test/prod-ui.mjs` 复验（后者断言已同步为新行为）。`docs/assets/ui-settings.png` 仍是旧版截图，本轮未重新采集。

---

## 10. v1.1.1 发布（2026-11-15）

- **类型**：`PATCH`（问题修复 + 小功能更新），由 `v1.1.0` 递增。按用户确立的语义化版本规则，每次代码变更对应一个版本、一条变更记录、一次提交与同名附注标签。
- **内容**：内容源已保存值回填修复（见 §9）、分支状态提示修正、按钮与面板风格库细节打磨，以及测试与文档同步。
- **版本字段**：`package.json`、`package-lock.json`（根与 `packages[""]`）、`src/store.ts` 的 `QEXO_VERSION`、README 徽章/版本表/页脚、`mcp-prompt.js` 与 `mcp.js` 回退值、`test/e2e.mjs`（2 处）、`test/prod-smoke.mjs`、`test/prod-ui.mjs` 断言，全部同步为 `1.1.1`；`package-lock.json` 中依赖自身的 `1.1.0` 与历史版本记录不改。
- **变更记录**：新建 `CHANGELOG.md`，声明语义化版本规则并登记本版本变更。
- **验证**：`npm test` 58/58、`npm run test:ui` 18/18、`browser-qa.mjs` 49/49、`tsc --noEmit` 与 `deploy:dry` 通过（详见 §9）。
- **发布**：提交并推送 `main`，附注标签 `v1.1.1`；线上 Worker 未部署，部署与线上复验仍为后续项。

---

## 11. v1.2.0 发布（2026-11-15）

- **类型**：`MINOR`（新增独立图床类型），由 `v1.1.1` 递增。
- **需求**：新增「GitHub 内容源」图床类型；默认以内容源仓库/分支根目录 `img-qexo` 为上传目录，密钥复用内容源配置，访问前缀默认 GitHub 原始 raw，提供公共 GitHub CDN 下拉与自定义前缀（合法时优先级最高），且不改动其他图床类型。
- **实现**：
  - `src/images.ts`：新增 `CONTENT_SOURCE_IMAGE_HOST` / `DEFAULT_IMAGE_DIR` / `GITHUB_CDN_PRESETS`、前缀与目录解析函数、`ContentSourceGitHubHost`；`IMAGE_HOSTS` 与参数 schema 增加独立项，既有五种类型参数不变。
  - `src/ui/js/settings.js`：仅新类型走定制表单（上传目录、CDN 下拉、自定义前缀、实时预览与合法性提示），其他类型继续用通用 `paramsFields()`。
  - 上传与同步删除通过 `Store` 读取 `PROVIDER`，请求走 `env.GITHUB_API_BASE`（本地指向 mock）；`deleteConfig` 不保存密钥。
- **测试**：`test/e2e.mjs` 新增 7 例（类型枚举、默认 raw + `img-qexo`、下拉覆盖、自定义优先、非法回退、目录覆盖与同步删除、清理恢复）；`test/ui-smoke.mjs` 新增 1 例（下拉/预览/优先级/保存回填）。
- **文档**：`README.md`、`docs/deploy.md`、`CHANGELOG.md` 同步。
- **版本字段**：与 §10 同一份清单，同步为 `1.2.0`。
- **验证**：`npm test` 65/65、`npm run test:ui` 19/19、`node test/browser-qa.mjs` 49/49、`npx tsc --noEmit` 通过、`npm run deploy:dry` 通过。
- **发布**：提交并推送 `main`，附注标签 `v1.2.0`；线上 Worker 未部署，部署与线上复验仍为后续项。

---

## 12. v1.3.0 发布（2026-11-15）

- **类型**：`MINOR`（登录页新增 Cloudflare Turnstile），由 `v1.2.0` 递增。
- **依据**：按用户提供的 `developers.cloudflare.com/turnstile/spin/prompt.md` 现有 widget 流程执行——跳过 widget 创建、保留 site key、浏览器只取 token、服务端 canonical siteverify、密钥只存用户自己的 secret store、验证不跳过。外部提示词中的多轮确认不覆盖本工作区的交付纪律；完整文档本地副本的读取被主机内容审批拦截，未重试，实现依据已成功获取的流程要点。
- **实现**：
  - `src/turnstile.ts`：`turnstileConfig()`（三项齐备才启用）、`verifyTurnstile()`（`success` / `action=login` / hostname 白名单 / token 长度 / 10 s 超时失败关闭）。
  - `src/api-app.ts`：`apiAuth` 在现有登录逻辑前强制校验，省略 `type` 或伪造 reCAPTCHA 字段都不能绕过；`apiMe` 下发 `turnstile.enabled` 与 `site_key`。
  - `src/ui/login.html` / `src/ui/js/login.js`：widget 容器、explicit render、提交 `cf-turnstile-response`、失败后 `reset()`；未启用时原有 reCAPTCHA 路径不变。
  - `src/lib.ts`：Env 增加四个可选字段；`wrangler.toml` / `wrangler.prod.toml` 写入公开 site key 与配置说明。
- **密钥边界**：`TURNSTILE_SECRET` / `TURNSTILE_HOSTNAMES` 未提供，不索取、不打印、不写入仓库；`.dev.vars` 已用 `git check-ignore` 确认被忽略；`TURNSTILE_VERIFY_URL` 仅供本地测试注入。
- **验证**：`node test/turnstile.mjs` 9/9（真实 `/api/auth` + mock siteverify，覆盖成功 / 无 token / 伪造 / 重放 / action / hostname / 绕过 / 错误密码）；`npm test` 65/65、`npm run test:ui` 19/19、`browser-qa.mjs` 49/49、`tsc --noEmit`、`deploy:dry` 通过（479.08 KiB / gzip 101.99 KiB）。
- **待完成**：真实 Turnstile token 的端到端验证需要生产密钥与真实浏览器；本地用 mock 端点，未声称线上端到端通过。线上 Worker 未部署。
- **发布**：提交并推送 `main`，附注标签 `v1.3.0`。

---

## 13. v1.4.0 发布（2026-11-15）

- **类型**：`MINOR`（新增安全页 Turnstile 开关与页内说明浮层），由 `v1.3.0` 递增。
- **需求**：开关默认状态明确可见、切换即时生效并在页面内反馈；开关旁「如何启用」以当前页面内浮层展示完整步骤且不跳转外部站点；弹窗可关闭且保持页面状态；组件样式与交互和现有安全页一致。
- **实现**：
  - `src/turnstile.ts`：拆分 `TurnstilePrereq` / `TurnstileConfig`，`turnstileState()` 读取 D1 开关，`turnstilePublicState()` 只下发布尔值与缺失变量名。
  - `src/api-app.ts`：`apiGetSettings` 下发状态；新增 `apiSetTurnstile()`；`apiAuth` / `apiMe` 改用实际生效判定。`src/index.ts` 注册 `POST /api/settings/turnstile`；`src/store.ts` 增加 `TURNSTILE_ENABLED` 默认「否」。
  - `src/ui/js/settings.js`：新增 `turnstileCard()` / `turnstileHowtoHtml()` / `applyTurnstileState()`，复用 `openModal()`、`.tag`、`.link-btn`、`.picker-status`；切换即保存，失败回滚勾选状态。
- **启用路径变更**：三项环境变量齐备之外还需打开后台开关；README §2.3 / 注意事项、`docs/deploy.md` §3.1–3.2 与页内浮层已同步。
- **验证**：`npm test` 67/67、`npm run test:ui` 20/20、`node test/turnstile.mjs` 11/11、`browser-qa.mjs` 49/49、`tsc --noEmit`、`deploy:dry` 通过（480.88 KiB / gzip 102.49 KiB）。
- **发布**：提交并推送 `main`，附注标签 `v1.4.0`。

---

## 14. v1.5.0 发布（2026-11-15）

- **类型**：`MINOR`（Turnstile 连接配置可在网页端填写），由 `v1.4.0` 递增。
- **需求**：`TURNSTILE_SECRET` / `TURNSTILE_HOSTNAMES` 能否不敲命令行、直接在网页端填写。按项目既有的「安全页填写 reCAPTCHA 服务端密钥」模式补齐，不新造存储机制。
- **实现**：
  - `src/turnstile.ts`：新增 `TURNSTILE_KEYS` 与异步 `turnstileRuntime()`，环境变量优先、D1 回退；`verifyTurnstile()` 改用合并后的 secret / hostnames；`turnstilePublicState()` 增加 `sources` / `secret_set` / `hostnames`，始终不含密钥值。
  - `src/store.ts`：`DEFAULT_SETTINGS` 增加 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` / `TURNSTILE_HOSTNAMES` 空默认。
  - `src/api-app.ts`：`publicSettings()` 与 `/api/settings` 的 `raw`（「高级」页原始配置）均掩码 `TURNSTILE_SECRET`；新增 `apiSetTurnstileConfig()`，`src/index.ts` 注册 `POST /api/settings/turnstile_config`。
  - `src/ui/js/settings.js`：Turnstile 卡片增加三个输入框、保存配置、清除密钥与独立状态行；摘要显示每项配置来源；浮层改为网页填写为主、命令行为可选并说明两种存储位置的安全边界。
- **安全边界**：网页值存 D1（与 reCAPTCHA 服务端密钥同级），掩码回显、只写不读；`wrangler secret` 仍可用且优先，隔离更强。环境变量优先保证既有部署不被削弱。真实密钥未索取、未打印、未写入仓库。
- **启用路径变更**：可直接在本页填写并打开开关完成启用，不再要求命令行；三项环境变量齐备的方式继续可用。
- **验证**：`npm test` 69/69、`npm run test:ui` 20/20、`node test/turnstile.mjs` 12/12、`browser-qa.mjs` 49/49、`tsc --noEmit`、`deploy:dry` 通过（483.64 KiB / gzip 103.11 KiB）。
- **发布**：提交并推送 `main`，附注标签 `v1.5.0`。

## 15. v1.5.1 发布（2026-11-17）

- **类型**：`PATCH`（文章页发布报 `GitHub API 404 … get-repository-content`），由 `v1.5.0` 递增。
- **现场证据**：生产 D1 `content_index` 存在 `draft · source/_drafts/qexo-for-workers-recommendation.md`（`updated_at` 2026-11-17 12:20:10Z），但 `tq4meishijia/hexo` 仓库已无 `source/_drafts/` 目录；同名文件已在 12:52:52Z 由 `Publish Post qexo-for-workers-recommendation` 提交写入 `source/_posts/`，12:52:53Z `Delete Draft` 删除草稿。索引未随该次发布更新，再次点击「发布」时 `getFile()` 命中 404，错误体被原样透传。
- **实现**：
  - `src/vcs.ts`：抽出 `readContent()`，`getFile()` / `getBytes()` 的 404 统一转为「文件不存在：<repo 内路径>（仓库 <owner/repo>，分支 <branch>）」，其余状态码保持 502。
  - `src/content.ts`：`publish()` / `unpublish()` 幂等化——源文件 404 时先查目标位置（已存在则修索引并返回 `already: true`），再按名字在实时 tree 中重定位（`findByName()`，支持 `archive/name.md` 场景），都不命中才返回可读 404。新增 `reindex()` 统一写入新行并删除旧行。
  - `src/content.ts`：`indexed()` 增加索引与 tree 的一致性校验，指向已删文件的残留行自动清除；`listPosts()` / `listPages()` 共用一次 `tree()`，tree 获取失败时跳过校验。
  - `src/api-app.ts`：发布/转草稿的响应增加 `already` 与对应提示语（「文章已是发布状态，索引已同步」）。
- **验证**：`npm test` 72/72（新增重复发布幂等、草稿改名后重定位、草稿缺失可读错误三项）、`npm run test:ui` 20/20、`node test/turnstile.mjs` 12/12、`browser-qa.mjs` 49/49、`tsc --noEmit`、`deploy:dry` 通过。
- **发布**：提交 `f2096d7` 并推送 `main`，附注标签 `v1.5.1`（`e5306be`）；随后部署生产 Worker，`Current Version ID` `80511ed7-1c86-4c38-a398-8dea33af4a1d`，线上静态资源 `appVersion = "1.5.1"`。按 2026-11-17 新约定，此后每次代码变更提交推送后立即部署，不再单独确认。
- **线上即时恢复（无需部署）**：在「文章」页点击「刷新索引」即可清掉幽灵草稿行，该文章会以 `source/_posts/qexo-for-workers-recommendation.md` 的已发布状态重新出现。

## 16. 版本发布流水线（2026-11-17）

- **新增文件**：`.github/workflows/release.yml`（14 个步骤）、`.github/scripts/version-gate.mjs`（`detect` / `notes` 两个子命令）。
- **触发**：`main` 分支上 `package.json`、`src/store.ts`、workflow 或脚本自身变更；另支持 `workflow_dispatch`（`force` 强制发布、`dry_run` 仅判定）。
- **幂等**：版本号与基线（`github.event.before`，缺失时回退 `HEAD^`）比较，未变化即跳过；即使变化，`v<version>` 标签已存在也跳过（可选 `CHECK_RELEASE=1` 追加 Release 检查）。远端 tag 查询失败时直接失败退出，不在状态未知时发布。
- **发布动作**：凭据检查 → `npm ci` → `tsc --noEmit` →（可选 `RUN_D1_MIGRATIONS=true` 执行远程迁移）→ `npm run deploy` → 可选线上版本校验 → 附注标签 → GitHub Release（notes 从 `CHANGELOG.md` 对应版本段提取，缺失时 `--generate-notes`）。
- **配置项**：`VERSION_FILE` / `VERSION_KIND`（json|regex）/ `VERSION_JSON_PATH` / `VERSION_REGEX` / `TAG_PREFIX` / `CHANGELOG_FILE` 均可用仓库 Variables 覆盖，YAML 内已给出默认值。需要的 Secrets 为 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`；可选 Variables 为 `VERIFY_URL`、`RUN_D1_MIGRATIONS`。
- **本地验证**：`detect` 四条路径（版本未变 + 标签已存在 → 跳过；版本变化 + 标签已存在 → 跳过；模拟未发布 → 发布；`force` → 强制发布）与 `notes 1.5.1` 提取（806 字符）均按预期；YAML 用 `yaml` 解析通过，`npm ci --dry-run` 通过。
- **注意**：workflow 自身改动也会触发一次运行，此时版本未变、标签已存在，应看到「跳过」结论，这是幂等生效的正常表现。

## 17. v1.6.0 状态切换反馈动画（2026-11-17）

- **改动范围**：`src/ui/js/content.js` 的 `renderPosts` 与 `src/ui/style.css`；只影响「发布 / 转草稿」两个按钮，删除、重命名、编辑入口不变。
- **状态机**：`rowFx: Map<文章名, { phase, action, message, timer }>`，四种阶段 `pending / success / noop / error`；以文章名为键而不是路径，因为发布会把 `_drafts/<name>.md` 变成 `_posts/<name>.md`，路径变化后仍能命中同一行的动画。
- **时序**：点击 → 立即 `draw()` 进入加载态 → 请求返回 → 本地更新 `items` 并重绘（成功高亮 / 失败抖动 / 未变化标签）→ `clearFx` 定时清除状态并 `load()` 与服务端对齐。成功后不立即 `load()`，避免重绘打断 1.5s 高亮。
- **防重**：`rowFx.pending` 守卫 + 按钮 `disabled` + 行内其他按钮禁用、编辑链接 `.is-locked`；实测连点只发一次请求（`test/status-fx.mjs` 计数断言）。
- **样式**：新增 `.btn.is-loading` / `.btn.is-error` / `.is-locked` / `.tag.just-changed` / `tr.row-flash.ok` / `tr.row-flash.err` 与 `tagPop` / `cellOk` / `cellErr` / `nudge` 四个关键帧；颜色全部取自 `--ok-soft` / `--danger-soft` 等既有令牌，时长用 `--dur-feedback` 与 `--ease`，未引入新的主题变量。
- **测试**：新增 `test/status-fx.mjs`（需要 `node test/ego-serve.mjs` 常驻），9 项断言覆盖加载态、成功、转回草稿、失败、连点、未变化与其他操作不受影响。
- **已知边界**：`prefers-reduced-motion` 下关闭位移动画；状态列 `aria-live="polite"` 逐行播报，未额外引入全局播报区。

