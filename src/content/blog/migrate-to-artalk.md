---
title: "博客评论系统从 Waline 迁移到 Artalk"
description: "记录将博客评论系统从 Waline 更换为 Artalk 的过程，包括选型对比和部署配置。"
pubDate: "Jan 15 2026"
categories:
  - 技术
  - 教程
tags:
  - 建站
  - Docker
  - 评论系统
---

在搭建博客的过程中，评论系统是一个重要的互动功能。本文记录了我从 Waline 迁移到 Artalk 的完整过程。

## 为什么要更换？

最初我选择了 Waline 作为评论系统，但在使用过程中遇到了一些问题：

1. **数据库配置繁琐**：Waline 使用 PostgreSQL 时需要手动创建表结构，官方文档对此说明不够清晰
2. **内存占用较高**：Node.js 运行时占用约 100-150MB 内存
3. **部分功能不稳定**：遇到了登出状态不同步、数据库字段缺失等问题

## Waline vs Artalk 对比

| 指标 | Waline (Node.js) | Artalk (Go) |
|------|------------------|-------------|
| 内存占用 | ~100-150MB | ~20-30MB |
| Docker 镜像 | ~200MB | ~30MB |
| 启动速度 | 较慢 | 秒启动 |
| 管理后台 | 基础功能 | 功能更强 |
| 多站点支持 | 不支持 | 支持 |

Artalk 使用 Go 语言编写，性能更好，资源占用更少，管理后台功能也更完善。

## 部署 Artalk

### 1. 创建数据库

我复用了已有的 PostgreSQL 容器：

```bash
docker exec postgres psql -U days -c 'CREATE DATABASE artalk;'
```

### 2. 启动 Artalk 容器

```bash
docker run -d \
  --name artalk \
  --restart always \
  --network app-network \
  -p 8360:23366 \
  -e ATK_DB_TYPE=pgsql \
  -e ATK_DB_HOST=postgres \
  -e ATK_DB_PORT=5432 \
  -e ATK_DB_NAME=artalk \
  -e ATK_DB_USER=your_user \
  -e ATK_DB_PASSWORD='your_password' \
  -e ATK_SITE_DEFAULT='你的站点名' \
  -e ATK_TRUSTED_DOMAINS='https://your-blog.com' \
  artalk/artalk-go
```

### 3. 创建管理员账号

```bash
docker exec artalk artalk admin --name admin --email your@email.com --password your_password
```

### 4. 配置 Caddy 反向代理

在 Caddyfile 中添加：

```
comment.yourdomain.com {
    reverse_proxy 127.0.0.1:8360
}
```

## 前端集成

在 Astro 博客中创建评论组件：

```astro
---
// Artalk 评论组件
---

<div id="artalk" class="mt-8 pt-8 border-t border-base-300"></div>

<link href="https://unpkg.com/artalk/dist/Artalk.css" rel="stylesheet" />
<script is:inline src="https://unpkg.com/artalk/dist/Artalk.js"></script>

<script is:inline>
  document.addEventListener('DOMContentLoaded', function() {
    Artalk.init({
      el: '#artalk',
      server: 'https://comment.yourdomain.com',
      site: '你的站点名',
      pageKey: window.location.pathname,
      darkMode: document.documentElement.getAttribute('data-theme') === 'dracula',
      placeholder: '欢迎留言~',
    });
  });
</script>
```

## 总结

迁移到 Artalk 后：

- **内存占用降低了约 80%**
- **管理后台更加强大**，支持多站点、评论审核等功能
- **部署更简单**，Go 编译的单文件，依赖少

如果你也在寻找一个轻量、高效的自托管评论系统，Artalk 是一个不错的选择。

## 参考链接

- [Artalk 官方文档](https://artalk.js.org/)
- [Artalk GitHub](https://github.com/ArtalkJS/Artalk)
