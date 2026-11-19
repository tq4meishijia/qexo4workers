# 变更记录

本项目遵循语义化版本 `MAJOR.MINOR.PATCH`：`MAJOR` 为不兼容变更，`MINOR` 为功能更新，`PATCH` 为问题修复或小功能更新。每次代码变更对应一个明确版本、一条本文件的记录、一次提交与同名附注标签（`vX.Y.Z`）。

版本字段集中在：`package.json`、`package-lock.json`（根与 `packages[""]`）、`src/store.ts` 的 `QEXO_VERSION`、README 徽章 / 版本表 / 页脚、`src/ui/js/mcp-prompt.js` 与 `mcp.js` 的回退值，以及 `test/e2e.mjs`、`test/prod-smoke.mjs`、`test/prod-ui.mjs` 的版本断言。

## v1.6.1 — 2026-11-19（PATCH）

**修复：删除「索引残留但仓库文件已不存在」的文章时报「文件不存在」**

- 根因：`delete()` 直接调用 `provider.deleteFile()`，GitHub 实现先以 `shaOf()` 查 sha；仓库侧文件已不存在时抛 `HttpError(..., 404)`，前端弹出「文件不存在: source/_posts/…」。D1 `content_index` 的残留行让这篇文章仍显示在列表中（v1.5.1 已为发布 / 转草稿做同类幂等自愈，删除路径当时未覆盖）。
- `delete()` 现在将 404 视为幂等成功：继续清理 D1 索引、失效缓存并触发部署；其他错误仍照常抛出。文章与页面删除共用该路径，一次覆盖两个入口。
- 顺带移除删除方法内重复执行的同一条索引 `DELETE` 语句（原 `entry?.kind === "page"` 分支），行为不变。

**验证**：新增 e2e「重复删除幽灵索引（文件已不在仓库）幂等成功」；`npm test` 73/73、`tsc --noEmit` 通过。

## v1.6.0 — 2026-11-17（MINOR）

**新增：文章发布 / 转草稿的行内状态反馈动画**

- 列表按文章名维护一次性反馈状态（pending / success / noop / error），只作用于「发布」与「转草稿」；删除、重命名等其他操作保持原样。
- **进行中**：按钮切换为「发布中 / 转回中」，显示 12px 旋转指示器、禁用并标记 `aria-busy="true"`；状态列同步显示中性「发布中」标签；该行的编辑、重命名、删除一并锁住，其他文章不受影响。
- **成功**：状态标签切换后播放 260ms 入场动画（`tagPop`），整行以成功色浅底高亮 1.5s，随后自动与服务端对齐。动画只改 `transform` / `opacity` / `background-color`，时长取自 `--dur-feedback` 与 `--ease`，主题切换时与按钮一起换档。
- **失败**：按钮恢复可点击并加错误描边 + 220ms 轻微横向抖动（`nudge`），状态列显示「失败」并带完整错误 tooltip，保留原有 toast；3.6s 后自动清除，可立即重试。
- **状态未变化**：后端返回 `already: true`，或本地比对状态与路径均未变时，只显示「未变化」中性标签与说明文案，不播放状态迁移与成功高亮。
- **连续点击**：同一文章在 pending 期间的再次提交被 JS 守卫直接忽略并提示「正在提交，请稍候」；按钮禁用 + 行内其他操作锁定形成双重保护。
- **无障碍与偏好**：状态列 `aria-live="polite"`；`prefers-reduced-motion: reduce` 下关闭入场与抖动动画，只保留减速的加载指示器。

**验证**：新增 `test/status-fx.mjs` 浏览器回归 9/9（加载态、成功态、转回草稿、请求失败、连续点击只提交一次、状态未变化、其他操作不受影响）；`npm test` 72/72、`npm run test:ui` 20/20、`browser-qa.mjs` 49/49、`tsc --noEmit` 通过。

## v1.5.1 — 2026-11-17（PATCH）

**修复：文章页点击「发布」时报 `GitHub API 404 … get-repository-content`**

- 根因：文章索引（D1 `content_index`）可能比仓库活得更久。草稿在 20:52 已成功发布并删除 `source/_drafts/<name>.md`，但该行的 draft 记录未被清掉；再次点击「发布」时 `publish()` 先 `GET /contents/<draft>`，GitHub 返回 404，代码把原始响应体直接透传成错误消息。
- `publish()` / `unpublish()` 改为幂等且可自愈：源文件 404 时先确认目标位置是否已存在（已存在 → 修复索引并返回 `already: true`，提示「文章已是发布状态，索引已同步」）；否则按名字在实时 tree 中重新定位被移动的草稿/文章，找到即继续发布。
- 真找不到时返回可读错误（404 + 「草稿不存在：<path>。文章索引可能已过期，请回到文章列表点击「刷新索引」后重试。」），不再暴露 GitHub 原始 JSON。
- 文章 / 页面列表读取时与仓库 tree 做一次一致性校验：索引中指向已删除文件的残留行会被自动清除并从列表隐藏，避免出现「点发布必 404」的幽灵条目；tree 取不到时跳过校验，不影响列表可用性。
- `GitHubProvider.getFile()` / `getBytes()` 的 404 统一转为「文件不存在：<repo 内路径>（仓库 <owner/repo>，分支 <branch>）」，其余状态码仍按 502 带截断 body。

**验证**：`npm test` 72/72（新增「重复发布幂等」「草稿改名后按名字重定位」「草稿缺失返回可读错误」三项）、`tsc --noEmit` 与 `deploy:dry` 通过。

## v1.5.0 — 2026-11-15（MINOR）

**新增：Turnstile 连接配置可直接在「设置 → 安全」网页端填写**

- 安全页 Turnstile 卡片新增 Site key / Secret key / 允许的域名三个输入框与「保存配置」按钮；保存即时生效并刷新状态徽标、摘要与提示行。配置保存与功能开关相互独立，互不覆盖。
- 后端新增 `POST /api/settings/turnstile_config`：仅写入显式提交的字段；密钥只写不读，空白或 `******` 占位保持不变，清除需显式 `clear_secret`；域名做轻量格式校验（拒绝协议 / 端口 / 路径），失败不改写已有配置。
- 配置合并规则：环境变量（`wrangler secret` / `.dev.vars`）**优先**，D1 网页值作为回退；`/api/settings` 与 `/api/me` 下发 `sources`（环境变量 / 本页填写 / 未配置）与 `secret_set`，页面摘要可见每项来源。已有 secret store 配置不会因网页留空而失效。
- 密钥存储边界：网页填写的值存 D1 `settings` 表，与安全页现有的 reCAPTCHA 服务端密钥同级；`publicSettings()` 与 `/api/settings` 的 `raw`（「高级」页原始配置）均掩码，真实值不出现在任何设置响应中；保存后前端输入框立即重置为占位，明文不留在 DOM。要求更高隔离仍可用 `wrangler secret put`（值不可读回）。
- 「如何启用」浮层改为以网页填写为主路径、命令行为可选，并明确两种存储位置的安全边界；保持页内浮层、无外链、关闭后页面状态不变。
- **启用路径变更**：此前必须补齐 `TURNSTILE_SECRET` / `TURNSTILE_HOSTNAMES` 两项环境变量；现在可直接在本页填写并打开开关完成启用，环境变量方式继续可用且优先级更高。

**验证**：`npm test` 69/69（新增网页配置生效 / 掩码 / 清除与非法域名拒绝）、`npm run test:ui` 20/20（新增表单保存与清除）、`node test/turnstile.mjs` 12/12（新增环境变量优先且网页值不回显）、`browser-qa.mjs` 49/49、`tsc --noEmit` 与 `deploy:dry` 通过。

## v1.4.0 — 2026-11-15（MINOR）

**新增：设置 → 安全 页的 Turnstile 功能开关与页内启用说明**

- 新增独立卡片，复用现有 `.card` / `.tag` / `.link-btn` / `.picker-status` 组件：默认状态（开关、前置条件、实际生效）明确可见；开启但前置条件未满足时显示「已开启 · 未生效」并列出缺失变量。
- 开关切换立即调用 `POST /api/settings/turnstile` 保存，`Store.set` 刷新隔离缓存即时生效；卡片内状态徽标、摘要与提示行同步更新并给出 toast 反馈；保存失败自动回滚勾选状态。
- 开关旁「如何启用」通过 `openModal()` 在当前页面内展示完整步骤（前置条件、配置命令、配置要点、验证方法），不含任何外部链接；关闭按钮与 Esc 均可关闭，关闭后页面表单状态不变。
- 后端：`TURNSTILE_ENABLED` 默认「否」；`/api/settings` 下发 `switch_on` / `configured` / `effective` / `missing` / `site_key`（不返回密钥值）；`apiAuth` 与 `apiMe` 改用「前置条件齐备 + 开关开启」的实际生效判定。
- **启用路径变更**：此前为「三项环境变量齐备即启用」，现在还需在「设置 → 安全」打开开关。README、部署手册与页内说明已同步；已配置但未开开关的实例保持原有登录路径，不会被锁死。

**验证**：`npm test` 67/67、`npm run test:ui` 20/20、`node test/turnstile.mjs` 11/11（默认关闭免 token、开启后强制校验、关闭后立即恢复）、`browser-qa.mjs` 49/49、`tsc --noEmit` 与 `deploy:dry` 通过。

## v1.3.0 — 2026-11-15（MINOR）

**新增：登录页接入 Cloudflare Turnstile（现有 widget）**

- 使用已创建 widget 的公开 site key `0x4AAAAAAGBqe3KzCG_zIoD7`；未创建、也未替换任何 widget。
- 登录页在配置齐备时渲染 Turnstile widget（`action: login`），提交携带 `cf-turnstile-response`；失败后重置 widget（token 一次性）。
- 服务端 `/api/auth` 前置 canonical siteverify：要求 `success === true`、`action === login`、`hostname` 在 `TURNSTILE_HOSTNAMES` 白名单内；token 长度异常与网络/解析失败一律拒绝。浏览器不调用 siteverify。
- 启用条件：`TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET` + `TURNSTILE_HOSTNAMES` 三者齐备；缺任一则保持原有登录/reCAPTCHA 路径，不会锁死后台。
- 密钥不入库、不回显：`TURNSTILE_SECRET` 由 `wrangler secret put` 或本地 `.dev.vars`（已 gitignore）提供；`TURNSTILE_VERIFY_URL` 仅用于本地测试注入。
- 现有 reCAPTCHA v3/v2 路径未移除；Turnstile 启用时优先且强制，客户端声明其它 `type` 不能绕过。

**验证**：`node test/turnstile.mjs` 9/9（配置下发；无 token、伪造 token、重放、action 不符、hostname 不符、伪造 reCAPTCHA 绕过均被拒绝；合法 token 登录成功；错误密码仍被拒绝）；`npm test` 65/65、`npm run test:ui` 19/19、`browser-qa.mjs` 49/49、`tsc --noEmit` 与 `npm run deploy:dry` 通过。

**待完成**：真实 Turnstile token 的端到端验证需要生产密钥与真实浏览器；本地验证使用 mock siteverify 端点，未声称线上端到端通过。

## v1.2.0 — 2026-11-15（MINOR）

**新增：独立图床类型「GitHub 内容源」**

- 上传目录默认 `img-qexo`（内容源仓库根目录下），配置页可覆盖；留空保存后回退默认值。
- 密钥、仓库、分支直接复用「设置 → 内容源」的 GitHub 配置，图床配置本身不保存 token。
- 访问前缀默认 GitHub 原始 raw（`https://raw.githubusercontent.com/{repo}/{branch}`）；下拉提供 jsDelivr / jsDelivr Fastly / jsDelivr Gcore / Statically / GitMirror 等公共 CDN 预设。
- 自定义前缀优先级最高：合法 http(s) 前缀（支持 `{repo}` / `{branch}` 占位符）生效并覆盖下拉；留空或非法时回退到下拉预设。前端预览与后端解析共用同一套合法性规则。
- 上传与「同步删除」均复用内容源凭据；配置页实时显示当前生效前缀、目录与仓库/分支。

**范围**：R2 / GitHub / S3 / Custom / 关闭 五种既有图床类型的参数与行为未改动。

**验证**：`npm test` 65/65、`npm run test:ui` 19/19、`browser-qa.mjs` 49/49、`tsc --noEmit` 与 `npm run deploy:dry` 通过。

## v1.1.1 — 2026-11-15（PATCH）

**问题修复**

- 再次打开「设置 → 内容源」时，仓库与分支下拉不再留空：自动回填并选中已保存的配置；列表刷新保留选中，切换仓库清空旧分支以免误用。
- 分支列表状态提示与当前选中态不一致。

**小功能更新**

- 按钮组件尺寸、圆角、焦点轮廓与动效统一；面板风格库细节打磨。

**同步**

- `test/ui-smoke.mjs`、`test/browser-qa.mjs`、`test/prod-ui.mjs` 断言改为回填语义，保留空值保存拦截覆盖。
- README、部署文档、交接手册同步；历史测试报告以追加注记说明，历史验收数字未改。

**验证**：`npm test` 58/58、`npm run test:ui` 18/18、`browser-qa.mjs` 49/49、`tsc --noEmit` 与 `npm run deploy:dry` 通过。

## 更早版本

`v1.1.0` / `v1.0.1` / `v1.0.0` 的发布说明见 `docs/handoff.md` 第 7、8 节与对应 Git 标签。
