---
title: "从零开始搭建个人网站：服务器、域名与自动化部署全记录"
description: "记录使用香港服务器、Cloudflare DNS、Caddy反向代理搭建个人网站的完整过程，包括遇到的问题和解决方案。"
pubDate: "Jan 14 2026"
image: /image/cloudflare.svg
categories:
  - 技术
  - 教程
tags:
  - 建站
  - Docker
  - Caddy
  - Cloudflare
badge: Pin
---

这篇文章记录了我搭建个人网站 cyb1.org 的完整过程，包括遇到的各种问题和最终的解决方案。希望能帮助到有类似需求的朋友。

## 项目背景

我的目标是搭建一个个人网站，包含以下几个部分：
- **主页** (cyb1.org)：简洁的导航页面
- **博客** (blog.cyb1.org)：使用 Astro + Frosti 主题的静态博客
- **短链服务** (s.cyb1.org)：自己开发的短链接工具

## 第一个坑：ICP 备案

最初我在 Leafflow 平台部署了后端服务，使用的是大陆服务器。当我兴冲冲地把域名解析到服务器 IP 后，发现网站完全无法访问。

经过排查，发现问题出在 **ICP 备案**。在中国大陆，所有使用境内服务器的网站都需要进行 ICP 备案，否则会被运营商拦截。备案流程相当繁琐，需要提供各种资料，审核周期也比较长。

### 尝试使用 Cloudflare CDN 绕过

我尝试使用 Cloudflare 的 CDN 代理功能来绕过这个限制。原理是让用户访问 Cloudflare 的节点，再由 Cloudflare 回源到我的服务器。

但这个方案也失败了：
1. **SSL 证书问题**：配置过程中遇到了 CAA 记录验证失败
2. **回源被拦截**：即使 CDN 层面正常，Cloudflare 回源到大陆服务器时依然会被拦截

### 最终方案：香港服务器

最终决定购买一台香港服务器。香港服务器不需要 ICP 备案，同时网络延迟相对较低。

选择了一个性价比较高的配置：
- **配置**：2核2G内存，30G存储
- **带宽**：100M 带宽，600G/月流量
- **价格**：约 99 元/年

## 服务器环境配置

### 安装 Docker

```bash
curl -fsSL https://get.docker.com | sh
```

### 部署 PostgreSQL 数据库

短链服务需要数据库支持，我选择了 PostgreSQL 18：

```bash
docker run -d \
  --name postgres \
  -e POSTGRES_USER=days \
  -e POSTGRES_PASSWORD=your_password \
  -e POSTGRES_DB=days \
  -v /data/postgres:/var/lib/postgresql \
  -p 5432:5432 \
  postgres:18
```

> **注意**：PostgreSQL 18 的数据目录是 `/var/lib/postgresql`，而不是之前版本的 `/var/lib/postgresql/data`，挂载时要注意。

### 部署短链服务

```bash
docker run -d \
  --name shortlink \
  --restart always \
  -p 127.0.0.1:9999:9999 \
  -e ADDR=:9999 \
  -e ADMIN_ADDR=:6060 \
  -e JWT_ISSUER=gee-api \
  -e 'JWT_SECRET=your_jwt_secret' \
  -e "DB_DSN=postgres://days:your_password@localhost:5432/days?sslmode=disable" \
  w100546718/days-shortlink:0.1.5
```

## Cloudflare DNS 配置

虽然 CDN 代理方案失败了，但 Cloudflare 的 DNS 服务依然是免费且好用的。

### 关键配置

在 Cloudflare 添加以下 DNS 记录（**代理状态全部设为"仅 DNS"**，即灰色云朵图标）：

| 类型 | 名称 | 内容 | 代理状态 |
|------|------|------|----------|
| A | @ | 服务器IP | 仅 DNS |
| A | blog | 服务器IP | 仅 DNS |
| A | s | 服务器IP | 仅 DNS |

### 为什么不使用 Cloudflare 代理？

- **SSL 模式冲突**：容易造成重定向循环 (ERR_TOO_MANY_REDIRECTS)
- **延迟问题**：Cloudflare 在国内的节点有限，可能反而增加延迟
- **证书问题**：我们用 Caddy 自动申请 Let's Encrypt 证书，更加简单可控

## Caddy 反向代理配置

Caddy 是一个现代化的 Web 服务器，最大的优点是 **自动 HTTPS**——它会自动申请和续期 Let's Encrypt 证书。

### 安装 Caddy

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install caddy
```

### Caddyfile 配置

```
cyb1.org {
    root * /var/www/homepage
    file_server
    encode gzip
}

s.cyb1.org {
    reverse_proxy 127.0.0.1:9999
}

blog.cyb1.org {
    root * /var/www/blog
    file_server
    encode gzip
}
```

配置非常简洁，Caddy 会自动：
- 申请 SSL 证书
- 配置 HTTPS
- HTTP 自动跳转 HTTPS
- 启用 gzip 压缩

### 启动 Caddy

```bash
systemctl enable caddy
systemctl start caddy
```

## 静态网站部署

### 博客：Astro + Frosti 主题

选择 Astro 作为静态网站生成器，使用 Frosti 主题：

```bash
npm create astro@latest my-blog -- --template EveSunMaple/Frosti
cd my-blog
npm install
npm run build
```

构建后的静态文件在 `dist` 目录，上传到服务器：

```bash
scp -r dist/* root@服务器IP:/var/www/blog/
ssh root@服务器IP "chmod -R 755 /var/www/blog/"
```

> **重要**：上传后必须修改文件权限为 755，否则 Caddy 无法访问这些文件（会返回 403 错误）。

### 主页：简洁的视频背景导航

主页使用视频背景 + 卡片式导航的设计：

```astro
<video autoplay muted loop playsinline class="video-bg">
    <source src="/bg.mp4" type="video/mp4" />
</video>
<div class="overlay"></div>

<main>
    <h1>欢迎来到 cyb1.org</h1>
    <p class="subtitle">探索我的数字空间</p>

    <div class="cards">
        <a href="https://blog.cyb1.org" class="card">
            <div class="icon">📝</div>
            <h2>博客</h2>
            <p>记录生活与技术</p>
        </a>

        <a href="https://s.cyb1.org" class="card">
            <div class="icon">🔗</div>
            <h2>短链工具</h2>
            <p>快速生成短链接</p>
        </a>
    </div>
</main>
```

## 视频优化：从 58MB 到 6.4MB

原始视频是 4K 60fps，体积达到 58MB，在国内访问时加载非常慢。

### 优化策略

使用 FFmpeg 进行优化：

```bash
ffmpeg -i bg.mp4 \
  -vf 'scale=1920:1080' \
  -r 30 \
  -c:v libx264 \
  -preset slow \
  -crf 23 \
  -an \
  -movflags +faststart \
  bg_optimized.mp4
```

参数说明：
- **scale=1920:1080**：降低分辨率到 1080p（对于背景视频足够了）
- **-r 30**：降低帧率到 30fps
- **-crf 23**：恒定质量因子，23 是一个平衡画质和大小的值（范围 0-51，越小质量越高）
- **-preset slow**：使用慢速预设获得更好的压缩效率
- **-an**：移除音轨（背景视频不需要声音）
- **-movflags +faststart**：将 moov atom 移到文件开头，支持边下载边播放

优化结果：**58MB → 6.4MB**，压缩了 89%！

## GitHub Actions 自动部署

每次修改后手动上传太麻烦，配置 GitHub Actions 实现自动部署。

### Workflow 配置

在 `.github/workflows/deploy.yml`：

```yaml
name: Deploy Blog

on:
  push:
    branches: [main, master]
  workflow_dispatch:

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build site
        run: npm run build

      - name: Setup SSH
        run: |
          mkdir -p ~/.ssh
          echo "${{ secrets.SSH_PRIVATE_KEY }}" > ~/.ssh/id_rsa
          chmod 600 ~/.ssh/id_rsa
          ssh-keyscan -H ${{ secrets.SERVER_IP }} >> ~/.ssh/known_hosts

      - name: Deploy to server
        run: |
          rsync -avz --delete dist/ ${{ secrets.SERVER_USER }}@${{ secrets.SERVER_IP }}:/var/www/blog/
          ssh ${{ secrets.SERVER_USER }}@${{ secrets.SERVER_IP }} "chmod -R 755 /var/www/blog/"
```

### 配置 GitHub Secrets

在 GitHub 仓库的 Settings → Secrets and variables → Actions 中添加：

- **SSH_PRIVATE_KEY**：SSH 私钥（用于连接服务器）
- **SERVER_IP**：服务器 IP 地址
- **SERVER_USER**：root

现在每次 push 代码，GitHub Actions 就会自动构建并部署到服务器。

## 遇到的其他问题

### 文件权限问题 (403 Forbidden)

部署博客后发现 CSS 和 JS 都加载不出来，控制台显示 403 错误。

**原因**：通过 scp 上传的文件，目录权限默认是 700（只有 root 可读），而 Caddy 运行在非 root 用户下。

**解决**：上传后执行 `chmod -R 755 /var/www/blog/`

### 重定向循环 (ERR_TOO_MANY_REDIRECTS)

这个问题通常出现在同时使用 Cloudflare 代理和服务器端 HTTPS 时。

**原因**：Cloudflare 的 SSL 模式设置与服务器配置不匹配。

**解决**：
- 方案 A：关闭 Cloudflare 代理（推荐）
- 方案 B：将 Cloudflare SSL 模式设为 "Full (strict)"

## 最终架构

```
用户访问
    ↓
Cloudflare DNS (仅DNS解析，无代理)
    ↓
香港服务器 (149.104.30.171)
    ↓
Caddy (自动 HTTPS + 反向代理)
    ├── cyb1.org → /var/www/homepage (静态文件)
    ├── blog.cyb1.org → /var/www/blog (静态文件)
    └── s.cyb1.org → 127.0.0.1:9999 (Docker 短链服务)
                          ↓
                    PostgreSQL (Docker)
```

## 总结

这次建站过程虽然踩了不少坑，但也学到了很多：

1. **大陆服务器需要 ICP 备案**，个人网站建议直接使用香港或海外服务器
2. **Cloudflare 的 CDN 代理在某些情况下可能帮倒忙**，仅 DNS 模式反而更稳定
3. **Caddy 是现代 Web 服务的最佳选择之一**，自动 HTTPS 省心省力
4. **视频优化很重要**，合理的编码参数可以大幅减小体积同时保持画质
5. **GitHub Actions 让持续部署变得简单**，一次配置，永久受益

希望这篇文章对你有帮助！如果有问题欢迎留言讨论。
