---
title: Hello Qexo Workers
date: 2026-11-01 09:00:00
tags:
  - hexo
  - cloudflare
categories:
  - 技术
abbrlink: '10001'
---

这是站点上的第一篇文章，用来验证 **Qexo Workers** 的内容读写链路。

## 为什么用 Workers

- 无需服务器，按请求计费
- D1 保存索引，Git 仓库保存正文
- 推送即构建，Pages 负责托管

<!-- more -->

## 代码块

```js
export default {
  async fetch(request, env) {
    return new Response("Hello from Workers");
  },
};
```

> 内容与配置都在 Git 仓库里，随时可回滚。
