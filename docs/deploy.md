# 部署手册（Cloudflare）

本文把「本地验收通过」推进到真实账号上线。命令均在项目根目录执行，需先 `npx wrangler login`。

## 1. 创建资源

```bash
# D1
npx wrangler d1 create qexo
# 输出：database_id = "xxxxxxxx-xxxx-..."

# R2（图床 + 可选内容源）
npx wrangler r2 bucket create qexo-images

# KV（可选；不建也能跑，缓存自动退回 D1）
npx wrangler kv namespace create qexo-cache
```

把返回的 `database_id`、KV `id` 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "qexo"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[[kv_namespaces]]
binding = "KV"
id = "xxxxxxxxxxxxxxxx"
```

R2 绑定无需改 ID，确认 `bucket_name = "qexo-images"` 与实际一致即可。

## 2. 初始化数据库

```bash
npm run db:remote      # wrangler d1 migrations apply qexo --remote
```

迁移会建 13 张表。重复执行安全（`IF NOT EXISTS`）。

## 3. 配置密钥

```bash
# 固定会话签名密钥（推荐；不设则首次启动自动生成并存入 D1）
npx wrangler secret put SESSION_SECRET
# 输入：至少 32 字节随机串，例如 openssl rand -hex 32 的输出
```

Provider 的 GitHub Token、图床密钥不放在环境变量里，而是登录后台后在「设置 → 内容源 / 图床」填写，加密边界由 Cloudflare 账号与 D1 访问控制保证。「GitHub 内容源」图床不另填密钥：它直接复用内容源的 token / 仓库 / 分支，默认上传目录为仓库根目录下的 `img-qexo`，访问前缀默认 GitHub 原始 raw，可在配置页下拉切换 jsDelivr 等公共 CDN，或用合法的自定义 http(s) 前缀覆盖（非法值自动回退下拉）。

### 3.1 登录页 Turnstile（使用已创建的 widget）

站点 key `0x4AAAAAAGBqe3KzCG_zIoD7` 是公开值，已写入 `wrangler.toml` / `wrangler.prod.toml` 的 `[vars]`；widget 已在 Cloudflare 创建，本项目不创建或替换 widget。登录保护在以下三项**同时存在**时自动启用，缺任一时保持原有登录 / reCAPTCHA 路径，不会锁死后台。

| 变量 | 说明 | 存放位置 |
|---|---|---|
| `TURNSTILE_SITE_KEY` | 公开 site key | `[vars]`（已配置） |
| `TURNSTILE_SECRET` | widget 密钥，绝不入库、不写进聊天 | `wrangler secret put` 或本地 `.dev.vars`（已 gitignore） |
| `TURNSTILE_HOSTNAMES` | 允许的前端 hostname，逗号分隔；**生产不得含 localhost / 127.0.0.1** | `wrangler secret put` 或部署时 `--var` |

```bash
wrangler secret put TURNSTILE_SECRET --config wrangler.prod.toml
wrangler secret put TURNSTILE_HOSTNAMES --config wrangler.prod.toml
```

密钥值从 Cloudflare Dashboard 的 widget 详情获取，由部署者在上述命令的交互提示中输入；仓库、文档与日志都不包含它。服务端在 `/api/auth` 内调用 `https://challenges.cloudflare.com/turnstile/v0/siteverify`，要求 `success === true`、`action === login`、`hostname` 在白名单内；浏览器只加载 widget 并提交 `cf-turnstile-response`，绝不直接调用 siteverify。`TURNSTILE_VERIFY_URL` 是本地测试注入点，生产不要设置。本地验证用 `node test/turnstile.mjs`（mock siteverify，覆盖重放与绕过）。

## 4. 部署 Worker

```bash
npm run deploy
```

首次部署会输出形如 `https://<worker-name>.<subdomain>.workers.dev` 的地址。该真实地址不写入仓库；线上冒烟测试通过环境变量 `QEXO_BASE_URL` 传入，文档与示例统一使用 `https://qexo.example.com`。打开任意页面会被守卫重定向到独立登录页 `/login`：

1. 用初始账号 `admin` / `admin123` 登录（首次请求时自动创建，无需手工建号）；
2. 登录后进入内容源配置：点「申请 Fine-grained PAT ↗」在新标签页打开 GitHub 创建页（已预填名称、90 天有效期与 Contents 读写）；在该页选择 `Only select repositories` 并只勾选博客仓库，生成后粘贴回来，点「检测密钥」自动列出该密钥可访问的仓库；首次配置需逐项选择仓库与分支（不会自动选中默认分支），点「刷新列表」可重新读取；
3. 选择部署方式（可留空，稍后在设置里配）。

> 表单回填与空值语义：重新打开配置页会自动回填并选中已保存的仓库与分支，可直接保存或更换；未配置时保持「必填 / 待选择」占位。切换仓库会清空旧分支以免误用；清空任一字段后保存会被前后端明确拦截，不会静默沿用旧值，也不会误报校验通过。

> 最小权限清单：`Contents: Read and write` 为必需（读写文章、页面、配置）；`Metadata: Read` 由 GitHub 自动附带；仅启用自动 WebHook 时加 `Webhooks: Read and write`；仅用 Actions 工作流部署时加 `Actions: Read and write`。不要改选 classic token 的 `repo` scope，它会授权账号下全部仓库。

> 初始化完成后 `INIT=6`，向导接口会拒绝再次访问。默认密码是公开值，登录后应立即在「账户」页修改；控制台会持续显示警示条直到密码变更。

### 自定义域名

控制台 → Workers & Pages → `qexo-workers` → Settings → Domains & Routes → Add custom domain。绑定后建议把 `wrangler.toml` 的 `PUBLIC_ORIGIN` 改成该域名，R2 图片会返回绝对地址。

## 5. 博客仓库与 Pages

### 5.1 仓库要求

Pages 项目连接的是**博客源码仓库**（不是本项目）：

- 根目录有 `_config.yml`、`package.json`、`source/`、`themes/`
- 不应有构建产物 `index.html`
- 若博客在子目录，Qexo 的「博客路径」要填该子目录

### 5.1.1 GitHub Token 是必填项

Cloudflare Worker 的出站 IP 与其他租户共享，GitHub 对匿名请求按 IP 限流（60 次/小时）。实测线上多个出口 IP 均返回 `403 API rate limit exceeded`，因此：

- 即使仓库是公开的，也必须在「设置 → 内容源」填写 fine-grained PAT；
- 至少授予目标仓库的 **Contents: Read and write**；需要自动 WebHook 时再加 **Webhooks: Read and write**；用 Actions 工作流部署时再加 **Actions: Read and write**；
- 只读场景可只给 Contents: Read，写操作会返回 403，属预期。

### 5.2 创建 Pages 项目

控制台 → Workers & Pages → Create → Pages → Connect to Git：

| 配置项 | 值 |
|---|---|
| 仓库 | 你的 Hexo 仓库 |
| 生产分支 | `main` |
| 框架预设 | Hexo（或 None） |
| 构建命令 | `npm install && npx hexo generate` |
| 构建输出目录 | `public` |
| 环境变量 | `NODE_VERSION=20`（可选，固定 Node 版本） |

保存后 Pages 会拉取仓库并构建。此后 **Qexo 每次保存都会 commit 到仓库，Pages 自动重新构建**——这条链路就是验收环境模拟的对象。

### 5.3 可选：Deploy Hook

若希望「保存后立即触发」而不等待 Git 集成的默认行为（两者通常等价），在 Pages 项目 → Settings → Builds & deployments → Deploy hooks 创建一个 hook，把 URL 填到 Qexo「设置 → 部署 → Cloudflare Pages Deploy Hook」。

其他方式：

- **Vercel**：项目 Settings → Git → Deploy Hooks，选择 `vercel` 类型；
- **GitHub Actions**：需在 GitHub 仓库自行添加一个带 `workflow_dispatch` 的工作流（由仓库所有者创建并配置密钥），然后在 Qexo 填 `user/repo`、工作流文件名、分支与 Token；
- **自定义**：任何接受 `POST` 的 URL。

## 6. 可选：Cloudflare Access 保护后台

Qexo 原版支持 Passkey 登录。Workers 版推荐把认证前移到边缘：

1. Zero Trust → Access → Applications → Add → Self-hosted；
2. 域名填 `qexo.example.com`，路径 `api`；
3. 策略：Allow → Emails → 你的邮箱；登录方式勾选 One-time PIN 或 Passkey；
4. 保存后，访问 `/api/*` 需先通过 Access。

注意：这会让 `/pub/*` 也走 Access 时必须放行该路径，或只对 `/api/*` 启用策略。主题调用的 `/pub/*` 应保持公开（其自身有 token 校验）。

## 7. 运维

| 任务 | 命令/入口 |
|---|---|
| 查看日志 | `npx wrangler tail` |
| 回滚代码 | `npx wrangler rollback`（选择上一个版本） |
| 数据库时间点恢复 | D1 → 数据库 → Time Travel（Free 7 天） |
| 备份业务数据 | 后台「设置 → 高级 → 下载 JSON 备份」 |
| 清理缓存 | 后台「清除缓存」或 `POST /api/purge` |
| 重建内容索引 | 文章页「刷新索引」或 `POST /api/posts/refresh` |
| 查看配额 | 控制台 → Workers & Pages → Metrics；D1 → Metrics |

## 8. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `Error 1027` | 超出 100,000 请求/天 | 等待 UTC 零点重置，或升级 Paid |
| `Error 1102` / exceeded CPU | 单请求超 10 ms | 避免在热路径解析大 YAML；把批量操作拆小 |
| `Too many API requests` | 单请求超 50 子请求 | 大目录删除/批量导入改为分批 |
| 保存报 422/409 | GitHub sha 过期 | 本实现会自动重取 sha 重试；持续失败则检查分支保护 |
| `403 API rate limit exceeded` | 未配置 GitHub Token，出口 IP 匿名配额耗尽 | 在「设置 → 内容源」填入 PAT（Contents 读写） |
| 图片 404 | R2 未绑定或 key 错 | 检查 `[[r2_buckets]]` 与 `api/images/file/*` |
| 登录后立即失效 | `SESSION_SECRET` 变更 | 重新登录；生产环境固定该 secret |
| Pages 未重建 | 未连接 Git / 未配 Hook | 检查 Pages 项目的 Git 集成或 Deploy Hook |
| 中文乱码 | 仓库文件编码 | 确保为 UTF-8；本实现以 UTF-8 读写 |

## 9. 升级

```bash
git pull
npm install
npm run db:remote     # 如有新迁移
npm run deploy
```

版本检查保留在后台「高级 → 检查更新」，只做提示，不执行自动升级（Workers 没有可写的运行目录）。
