# 验收测试报告

**日期**：2026-11-14 ｜ **结论**：本地 API 58/58、浏览器 13/13；线上 API 15/15、浏览器 7/7。

## 1. 测试环境

| 项 | 值 |
|---|---|
| 宿主机 | Windows 11，Node 22.22.2 |
| Worker 运行时 | `wrangler dev --local`（workerd，wrangler 4.162.0） |
| D1 | 本地 SQLite（`.wrangler/state` / `test/.state`），迁移 `0001_init.sql` |
| R2 | 本地模拟桶（Miniflare） |
| 内容仓库 | Node 实现的 GitHub REST 模拟服务 `test/mock-github.mjs`，以真实目录 `test/out/repo` 为存储，实现 Contents / Trees / Hooks / workflow_dispatch |
| 浏览器 | Microsoft Edge（Chromium），`playwright-core` 驱动，无头 1440×900 |
| 网络 | 全部本地回环，无外部依赖；GitHub API 通过 `GITHUB_API_BASE` 指向 mock |

## 2. 验收环境拓扑

```
┌────────────────────────┐        ┌──────────────────────────┐
│ 浏览器 / curl          │        │  mock-github :8788       │
│  (admin SPA + API)     │        │  Contents/Trees/Hooks    │
└───────────┬────────────┘        └────────────▲─────────────┘
            │ HTTP                             │ fetch (Bearer mock-token)
┌───────────▼────────────┐                     │
│ wrangler dev :8787     │─────────────────────┘
│ Worker + Assets        │
│  D1 (SQLite) / R2      │
└───────────┬────────────┘
            │ 读取仓库快照
┌───────────▼────────────┐        ┌──────────────────────────┐
│ test/out/repo          │───────▶│ test/build-site.mjs      │
│ Hexo 站点源码          │        │ 生成 public/（构建等价物）│
└────────────────────────┘        └──────────────────────────┘
```

模拟的是「Git 仓库作为内容存储 + Pages 检出仓库并构建」这条链路：Worker 只写 Git，构建进程只读 Git，二者不共享数据库。

## 3. 执行方式

```bash
npm run db:local      # 应用 D1 迁移
npm test              # API e2e（自动拉起 mock + wrangler dev）
node test/ui-smoke.mjs # 浏览器 UI 冒烟（需本机 Edge）
```

脚本会重建 `test/out/repo`、清空 `test/.state`，保证可重复。

## 4. API 用例（58 项，全部通过）

| 分组 | 用例 |
|---|---|
| 初始化（4） | 默认管理员自动创建（init≥4）、语言、内容源、部署方式 |
| 页面守卫（2） | 未登录访问 `/` 302 → `/login?next=`；登录后 `/` 返回 200 |
| 鉴权（4） | 错误密码、登录+CSRF、未登录拦截、缺 CSRF 拦截 |
| 内容源选择（5） | 读取密钥授权仓库、读取分支与默认分支、掩码密钥回退到已保存配置、无效密钥/非法仓库返回明确错误、空仓库/空分支不被误判或回填且原配置不变 |
| 控制台（1） | 聚合计数与 Provider 信息 |
| 文章（7） | 索引、新建草稿、保存发布、读回 front-matter、转草稿/再发布、重命名、删除后构建同步 |
| 页面（2） | 列表读取、新建并保存 |
| 配置（3） | 列出/读取、修改落盘、非法 YAML 拒绝 |
| 图床（4） | 配置 R2、上传 PNG、Worker 读取对象、列表+同步删除 |
| 友链（2） | 添加→公开列表、编辑隐藏→清理 |
| 说说（1） | 发布→分页→点赞→取消 |
| 设置（2） | 基本信息/安全（密钥掩码）、旧版表单接口 |
| 公开 API（1） | token 鉴权成功/失败 |
| 统计（1） | 域名白名单、PV/UV 累加、非法域名 403 |
| WebHook（1） | token 清缓存 |
| 备份（1） | JSON 导出结构 |
| 构建（3） | 生成静态站、标题取自配置、删除后消失 |
| MCP（14） | 建只读令牌、initialize、initialized 202、tools/list、只读越权拒绝、get_post、resources、写令牌建稿落盘、更新 front-matter、stdio 桥接、401/-32601、令牌列表无明文、Agent 提示词 6 段结构与 11 项要素、只读令牌作用域标注 |
| 配额（1） | 统计 Git 调用量 |

关键断言举例：

- 保存文章后，`source/_drafts/workers-test.md` 必须消失、`source/_posts/workers-test.md` 必须包含 `title: Workers 测试文章`；
- 页面保存必须落在传入路径 `source/contact.md`，而不是按模板重组；
- 隐藏的友链不得出现在 `/pub/friends`；
- `/pub/statistic` 第二次调用 `page_pv=2、site_pv=2、site_uv=1`；
- 非法 YAML 返回 `status:false` 且不写仓库。

## 5. 浏览器用例（13 项，全部通过）

1. 独立登录页 `/login` 渲染（非 SPA，单独 HTML/JS）
2. 表单登录 → 跳转控制台，会话与 CSRF 生效
3. 仪表盘 4 张统计卡、Provider 信息、截图
4. 文章列表显示仓库中的 `hello-world`
5. 编辑器加载 front-matter、正文、Markdown 预览（`<h2>` 渲染）
6. 工具栏插入粗体标记
7. 设置页回填 `github / Hexo`
8. Fine-grained PAT 链接与空值默认：链接指向 `settings/personal-access-tokens/new`，预填 `contents=write` 与 `expires_in=90`，`target=_blank` + `rel=noopener`，最小权限清单可展开；仓库/分支下拉与手输框均为空，占位标注「必填 / 待选择」，已保存配置以只读说明展示，空值保存被明确拦截且不误报校验通过
9. 仓库/分支需明确选择：加载选项后两项仍为空；选择仓库后分支加载但不自动选默认分支；手动选择后刷新列表保持所选值
10. 无效密钥：token 状态与仓库状态同时显示红色错误，包含 GitHub 401 原因
11. 图床页、友链页可访问
12. MCP 页创建 write 令牌并自动生成 Agent 配置提示词：6 段结构、令牌出现两次、含 HTTP/stdio 适配与 18 个工具，复制按钮可用
13. 控制台无 JS 运行时错误

截图证据：

- `test/out/ui-dashboard.png`
- `test/out/ui-posts.png`
- `test/out/ui-editor.png`
- `test/out/ui-settings.png`、`test/out/ui-settings-loaded.png`
- `test/out/ui-mcp.png`

## 6. 构建链路验证

`test/build-site.mjs` 模拟 Pages 的构建步骤：读取 `_config.yml`、解析每篇 Markdown 的 front-matter、渲染 HTML、输出 `public/`。

验证点：

- 新增文章出现在 `public/posts/workers-renamed.html`，正文与 `<h2>小节</h2>` 均在；
- 修改 `_config.yml` 的 `title` 后，`public/index.html` 的站点标题随之变化；
- 删除文章后重新构建，该文章从 `build.json` 与产物中消失；
- `source/about/index.md` 生成 `public/about/index.html`。

> **关于真实 Pages**：仓库内未提交 `.github/workflows/*.yml`（CI 工作流涉及部署密钥，按安全策略不在本机生成）。真实部署时在 GitHub 仓库的 Actions 页面新建 workflow，内容见 `docs/deploy.md` 第 4 节；其构建命令为 `npm install && npx hexo generate`，产物目录 `public`，与本地 `build-site.mjs` 的输入输出一致。

## 7. 性能与配额观测

- 整轮 58 个 API 用例触发 **54 次** Git API 调用，均值约 1.0 次/用例；其中内容源探测占 11 次（检测密钥 3–4 次、读取分支 2 次），其余为内容读写与索引。
- 密钥检测结果在浏览器内存缓存 60 秒，切换设置标签页不会重复消耗 GitHub 配额。
- 文章列表在 tree 缓存有效期内 **0 次** Git 调用（D1 直出）。
- 页面 HTML/CSS/JS 由静态资源直接返回，不进入 Worker；`/api/*` 与 `/pub/*` 才消耗 Worker 请求。
- 未使用 KV（避免 1,000 写/天瓶颈），未使用 Queues/Durable Objects。

## 8. 线上部署验证（2026-11-14）

| 项 | 值 |
|---|---|
| 账号 | `tq4meishijia@gmail.com`（Account ID `92d3a5791f6758d88fe1b81483f591ed`） |
| Worker URL | 占位示例 `https://qexo.example.com`；真实地址由 `QEXO_BASE_URL` / `PUBLIC_ORIGIN` 决定，未写入仓库 |
| Version ID | `6da1f4ae-5bac-4185-8207-8d37521eeded` |
| D1 | `qexo` / `e67e85cb-e28c-408a-b2cf-28e9f9839a47`（APAC） |
| KV | `qexo-cache` / `e0892d23927d427e8ace479fa4682724` |
| R2 | 账号未开通（API 10042），生产配置 `wrangler.prod.toml` 未绑定 R2 |
| 构建 | 上传 470.85 KiB / gzip 100.11 KiB；启动 7 ms |
| 会话密钥 | 未显式设置 `SESSION_SECRET`，应用首次登录时自动生成并存入 D1 `settings._SESSION_SECRET` |

**结果：15/15 通过、0 跳过、0 失败**（`node test/prod-smoke.mjs`，报告 `test/out/prod-report.json`）。
浏览器侧 **7/7 通过**（`node test/prod-ui.mjs`）：独立登录页、表单登录、控制台 4 张卡、内容源表单（Fine-grained PAT 链接/预填参数、仓库与分支默认留空、空值保存拦截、密钥状态）、UI 侧栏版本 `v1.0.0`、MCP 页 Agent 提示词结构规范、零 JS 错误；截图 `test/out/prod-dashboard.png`、`test/out/prod-settings.png`、`test/out/prod-mcp.png`。

通过项：页面守卫（未登录 `/` → 302 `/login`，登录后 `/` → 200）、初始化状态、登录 + CSRF（含运行时版本 `1.0.0` 校验）、控制台聚合、内容索引与文章读取（真实仓库 2 篇文章、18 个配置）、内容源密钥检测（未登录 401；已配置密钥返回 11 个仓库）、友链写读删、说说写读删、统计 PV/UV、MCP 握手、MCP `tools/list` + `tools/call`（`qexo_overview`，18 个工具）、令牌吊销后 401。

初始账号：`admin` / `admin123`（首次请求自动创建）；线上已用该密码登录验证，控制台显示默认密码警示条。

线上静态资源校验：`/js/mcp-prompt.js`、`/js/mcp.js`、`/style.css` 均包含本次新增的提示词生成与样式规则。

线上内容源状态：已配置真实 Fine-grained PAT，仓库 `tq4meishijia/hexo`、分支 `main`；密钥检测返回 11 个可访问仓库，分支列表 4 个。表单仍默认留空，已保存值以只读说明展示，保存前需重新选择。此前“缺 Token 跳过”的两项已转为正常执行。

已知线上限制：

1. R2 未开通，`R2` 图床与 `r2` 内容源在线上不可用；如需使用，先在控制台启用 R2、创建桶，再在 `wrangler.prod.toml` 添加绑定并重新部署。
2. 生产内容读写必须使用 GitHub Token；匿名只读在 Workers 上不可用（限流），代码虽支持空 Token（本地/自建出口可用），线上不作为可用方案。
3. 生产内容源已指向真实仓库 `tq4meishijia/hexo`，并配置 Fine-grained PAT；更换仓库时用下拉选择后保存即可。

## 9. 已知边界（不影响上述结论）

1. 本地 `wrangler dev` 的 CPU 计时与生产边缘不完全一致；10 ms 预算按代码路径估算（见 `quota-analysis.md`），未做生产压测。
2. mock GitHub 只实现本项目使用的 REST 子集，未覆盖 rate limit、二次校验、大仓库 truncated tree 等边缘情况。
3. `build-site.mjs` 是 Hexo 的等价简化实现，不渲染主题；真实主题渲染需在 CI 中跑 `hexo generate`。
4. 未验证真实 Cloudflare 账号的 D1/R2/Pages 绑定，绑定步骤见 `docs/deploy.md`。
5. Passkey 登录未在应用层实现，替代方案为 Cloudflare Access（见迁移矩阵 #4）。
6. MCP 以 2025-06-18 握手为基线；2026-07-28 的 `_meta` 元数据模型未实现，SSE 服务端推送未启用（POST 返回 JSON，GET 返回 405）。
