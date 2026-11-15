# 变更记录

本项目遵循语义化版本 `MAJOR.MINOR.PATCH`：`MAJOR` 为不兼容变更，`MINOR` 为功能更新，`PATCH` 为问题修复或小功能更新。每次代码变更对应一个明确版本、一条本文件的记录、一次提交与同名附注标签（`vX.Y.Z`）。

版本字段集中在：`package.json`、`package-lock.json`（根与 `packages[""]`）、`src/store.ts` 的 `QEXO_VERSION`、README 徽章 / 版本表 / 页脚、`src/ui/js/mcp-prompt.js` 与 `mcp.js` 的回退值，以及 `test/e2e.mjs`、`test/prod-smoke.mjs`、`test/prod-ui.mjs` 的版本断言。

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
