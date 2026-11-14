# Qexo 源码与功能清单

> 基线：`Qexo/Qexo` master（v4.3.0），克隆于 2026-11-14。15,544 行 Python（不含迁移与测试），43 个 Django 模板。

## 1. 技术形态

| 项 | 内容 |
|---|---|
| 框架 | Django 5.2.11 + Gunicorn；WSGI/ASGI 双入口 |
| 数据库 | MySQL / PostgreSQL / MongoDB / SQLite 四选一（`core/settings.py` 动态装配） |
| 关键依赖 | PyGithub、python-gitlab、PyYAML、Markdown、BeautifulSoup、boto3、oss2、upyun、Requests、django-passkeys |
| 前端 | Django 模板 + Argon Dashboard；静态资源从 `qexo-static` NPM 包按 CDN 前缀加载（无本地构建） |
| 部署 | Docker / Vercel / 自建；`vercel.json` + `vercel.sh` 走 Serverless |
| 鉴权 | Django Session + `django-passkeys`（WebAuthn）+ reCAPTCHA v2/v3 |
| 版本机制 | `core/qexoSettings.py` 的 `QEXO_VERSION`、`QEXO_STATIC`；`libs/elevator` 做数据库迁移升级 |

## 2. 数据模型（10 张业务表）

`Cache(name, content)`、`SettingModel(name, content)`、`ImageModel(name, url, size, date, type, deleteConfig)`、`FriendModel(name, url, imageUrl, time, description, status)`、`NotificationModel(time, label, content)`、`CustomModel(name, content)`、`StatisticUV(ip)`、`StatisticPV(url, number)`、`TalkModel(content, tags, time, like, values)`、`PostModel(title, filename, path, date, front_matter, status)`；另有 Django `User` 与 `UserPasskey`。

设计特征：**几乎所有字段都是 TextField**（兼容 MongoDB），主键统一 UUID，`name` 作为逻辑唯一键；`PostModel` 只是「保存过的文章」索引，不是正文存储。

## 3. 路由与接口

### 3.1 管理端页面

`/login`、`/logout`、`/init`（4 步向导）、`/update`、`/migrate`、`/`（控制台）、`/posts`、`/pages`、`/configs`、`/images`、`/friends`、`/talks`、`/settings`、`/advanced`、`/custom`、`/userscripts`、`/passkeys`，以及 `/<path>` 动态页。

### 3.2 管理 API（41 个）

鉴权：`auth`；初始化：`init_step`；内容：`save`、`save_post`、`save_page`、`save_draft`、`publish`、`unpublish`、`new_page`、`new_post`、`delete`、`rename`；图床：`upload`、`upload/config`、`upload/complete`、`delete_img`；设置：`set_hexo`、`set_user`、`set_image_host`、`set_api`、`set_abbrlink`、`set_cust`、`set_statistic`、`set_security`、`set_excerpt`、`set_value`、`del_value`、`new_value`、`set_custom`、`del_custom`、`new_custom`、`set_onepush`、`set_sidebar`、`set_cdn`；友链：`add_friend`、`edit_friend`、`del_friend`、`clean_friend`；说说：`save_talk`、`del_talk`；运维：`fix`、`purge`、`webhook`、`create_webhook`、`do_update`、`get_notifications`、`del_notifications`、`clear_notifications`、`run_online_script`、`change_lang`、`passkey_devices/delete/rename`。

### 3.3 公开 API（25 个，`/pub/*`）

`friends`、`status`、`statistic`、`talks`、`like_talk`、`get_posts`、`get_pages`、`get_configs`、`get_images`、`get_friends`、`get_custom`、`get_notifications`、`get_all_talks`、`ask_friend`、`save`、`delete`、`save_talk`、`del_talk`、`set_custom`、`del_custom`、`new_custom`、`notifications`、`fix`、`create_webhook`、`clean_friend`。

鉴权：`token` 参数与 `WEBHOOK_APIKEY` 的 SHA-256 比对（`check_if_api_auth`）。这是主题/脚本生态的契约，必须保持路径与字段不变。

## 4. 平台适配（7 种）

| 平台 | 文章目录 | 页面目录 | 配置搜索范围 |
|---|---|---|---|
| Hexo | `source/_posts` | `source`（深度 2，排除 `_posts`/`_drafts`） | `.github`、根、`themes`、`source`、`source/_data` |
| Hugo | `content/posts` | `content`（深度 3） | `.github`、根、`themes`、`config` |
| Valaxy | `pages/posts` | `pages`（深度 2） | `.github`、根 |
| Vuepress | `blogs`/`posts`/`articles`/`archives` | 根（深度不限） | `.github`、`.vuepress`、根 |
| Vitepress | 同上 | 同上 | `.github`、`.vitepress`、根 |
| Nuxt | `content/posts` | `content`（深度 1） | `.github`、根、`app` |
| Astro | `src/content` 等 4 个目录 | `src/pages` | 根、`.github`、`src`、`public` |

每段配置含 `path[]`、`depth[]`、`type[]`、`save_path`、`scaffold`、`excludes`，决定「保存到哪、识别哪些扩展名、递归多深」。

## 5. Provider 与图床

**Provider（内容源）4 个**：`github`、`gitlab`、`gitea`、`local`。统一接口：`get_content`、`get_path`、`get_tree`、`save`、`delete`、`build`、`create_hook`、`delete_hooks`。GitHub 走 Contents API + Git Trees（递归一次拿全量），Gitea/GitLab 走各自 REST。

**图床 8 个**：阿里 OSS、S3、FTP、又拍云、DogeCloud、CFImgBed、GitHub、Custom。接口：`upload(file) -> (url, deleteConfig)`、`delete_image(config)`。

**OnePush 通知 15 个**：Bark、DingTalk、Discord、GoCQHTTP、Gotify、Lark、PushDeer、PushPlus、Qmsg、ServerChan、ServerChanTurbo、SMTP、Telegram、企业微信应用/机器人、Custom。

## 6. 关键运行机制

1. **Provider 每次请求新建**：`Provider()` 读取 `SettingModel.PROVIDER` JSON，实例化对应 SDK 客户端。
2. **列表缓存**：`Cache` 表存 `posts`/`pages`/`configs` 与搜索结果；任何写操作调用 `delete_all_caches()`。
3. **文章保存**：前端把 front-matter 序列化为 `---\n...---`，`Provider.save_post` 按 `save_path` 模板落盘；发布时先写正式目录再删草稿；`mark_post` 更新 `PostModel`。
4. **front-matter**：支持 `---`（YAML）与 `;;;`（JSON）两种；`{{ date }}`、`{{ abbrlink }}`、`{{ slug }}` 在解析前替换。
5. **abbrlink**：`crc16`（Modbus 多项式，字节序拼接）或 `crc32`，输出 dec/hex。
6. **构建**：GitHub Provider 不主动构建，依赖 Vercel/Git 集成；Vercel Provider 通过 Vercel API 创建 file deployment。
7. **统计**：`/pub/statistic` 校验 Referer 域名白名单，累计 `StatisticPV(url=path)` 与 `StatisticPV(url=domain)`，`StatisticUV` 按 IP 去重。
8. **缓存清理 WebHook**：GitHub/GitLab/Gitea 仓库 hook 指向 `/api/webhook?token=...`，provider 收到 push 后 `delete_all_caches()`。
9. **i18n**：7 份 Python 字典（各 518 键），服务端 `gettext` 注入模板。
10. **自修复**：`fix_all()` 遍历 `ALL_SETTINGS`，补建缺失项、删除重复项。

## 7. 功能清单（用于验收对照）

| # | 功能 | 关键行为 |
|---|---|---|
| 1 | 初始化向导 | 语言 → 管理员 → Provider（含 Hexo 结构校验）→ 部署 |
| 2 | 登录 | 用户名密码；reCAPTCHA v2/v3；Passkey；失败日志 |
| 3 | 控制台 | 文章/草稿/页面/图片计数、最近文章、快捷入口 |
| 4 | 文章管理 | 列表/搜索、新建、编辑、草稿、发布、转草稿、重命名、删除 |
| 5 | 页面管理 | 列表、新建、编辑、删除 |
| 6 | 配置管理 | 扫描 YAML/JSON/TOML/JS，在线编辑保存 |
| 7 | front-matter | 标题/日期/标签/分类/摘要/abbrlink/自定义字段 |
| 8 | 图床 | 上传、列表、复制链接、删除（可选同步远端） |
| 9 | 友链 | 增删改查、显示/隐藏、前台申请、reCAPTCHA、清理隐藏 |
| 10 | 说说 | 发布/编辑/删除、分页、IP 点赞/取消 |
| 11 | 统计 | PV/UV、域名白名单、主题接口 |
| 12 | 通知 | 站内通知列表、删除、清空；OnePush 推送 |
| 13 | WebHook | 自动创建/删除仓库 hook；token 校验后清缓存 |
| 14 | 备份 | 导出/导入 JSON（settings/custom/images/friends/talks/notifications/uv/pv/posts） |
| 15 | 自定义字段 | 增删改，供主题读取 |
| 16 | 侧边栏/摘要/CDN/abbrlink 设置 | JSON 配置项 |
| 17 | 多语言 | 7 种语言切换 |
| 18 | 自动修复/缓存清理/版本检查 | 运维工具 |
| 19 | 部署触发 | Vercel 部署或 Git 推送 |
