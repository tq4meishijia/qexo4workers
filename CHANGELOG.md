# 变更记录

本项目遵循语义化版本 `MAJOR.MINOR.PATCH`：`MAJOR` 为不兼容变更，`MINOR` 为功能更新，`PATCH` 为问题修复或小功能更新。每次代码变更对应一个明确版本、一条本文件的记录、一次提交与同名附注标签（`vX.Y.Z`）。

版本字段集中在：`package.json`、`package-lock.json`（根与 `packages[""]`）、`src/store.ts` 的 `QEXO_VERSION`、README 徽章 / 版本表 / 页脚、`src/ui/js/mcp-prompt.js` 与 `mcp.js` 的回退值，以及 `test/e2e.mjs`、`test/prod-smoke.mjs`、`test/prod-ui.mjs` 的版本断言。

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
