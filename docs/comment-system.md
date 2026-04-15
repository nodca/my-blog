# Comment System

博客评论已经改为同仓库自带的轻量方案：

- 前台：静态 Astro 页面直接请求 `/api/comments`
- 后台：单独的 Node 进程提供评论 API
- 存储：SQLite（Node 内置 `node:sqlite`）
- 管理：`/admin/stats`

## Local Development

1. 启动博客前端

```bash
pnpm dev
```

2. 启动评论 API

```bash
cp server/comment-api.env.example .env
pnpm comments:dev
```

默认本地地址：

- 前端：`http://localhost:4321`
- 评论 API：`http://localhost:4322`

## Environment Variables

- `COMMENT_PORT`: 评论 API 端口，默认 `4322`
- `COMMENT_DB_PATH`: SQLite 文件路径，默认 `./data/comments.sqlite`
- `COMMENT_ADMIN_TOKEN`: 评论管理令牌，必须配置
- `COMMENT_IP_SALT`: IP 哈希盐值，必须配置
- `COMMENT_AUTO_APPROVE`: 是否自动通过，默认 `false`
- `COMMENT_ALLOWED_ORIGINS`: 允许跨域的来源列表，逗号分隔

## Production Deployment

博客主体仍然是静态站，评论 API 独立进程运行。

评论 API 需要 Node 运行时支持 `node:sqlite`。

### 1. 构建博客

```bash
pnpm build
```

### 2. 启动评论 API

```bash
node server/comment-api.mjs
```

如果服务器本机安装了支持 `node:sqlite` 的 Node，可以放到 `systemd`：

```ini
[Unit]
Description=Blog Comment API
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/www/my-blog
EnvironmentFile=/var/www/my-blog/.env
ExecStart=/usr/bin/node /var/www/my-blog/server/comment-api.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

如果服务器没有 Node，直接用 Docker 更稳：

```bash
docker build -f server/Dockerfile -t blog-comments:latest .

docker run -d \
  --name blog-comments \
  --restart unless-stopped \
  -p 127.0.0.1:4322:4322 \
  -v /data/blog-comments:/app/data \
  --env-file /data/blog-comments/.env \
  blog-comments:latest
```

### 3. Caddy 反代

在 `blog.cyb1.org` 站点中增加：

```caddy
handle /api/comments* {
	reverse_proxy 127.0.0.1:4322
}
```

## Artalk Data Migration

迁移脚本支持两种方式：

### 方式一：直接连接 PostgreSQL

```bash
ARTALK_DATABASE_URL=postgresql://user:password@host:5432/artalk \
pnpm comments:migrate:artalk
```

### 方式二：先导出，再导入

导出 JSON：

```bash
docker exec postgres psql -U days -d artalk -Atc "
SELECT COALESCE(json_agg(row_to_json(t))::text, '[]')
FROM (
  SELECT
    c.id,
    c.page_key,
    c.rid,
    c.content,
    c.is_pending,
    c.created_at,
    c.ip,
    c.ua,
    p.title AS page_title,
    u.name AS author,
    u.email
  FROM comments c
  LEFT JOIN users u ON u.id = c.user_id
  LEFT JOIN pages p ON p.key = c.page_key
  WHERE c.deleted_at IS NULL
  ORDER BY c.id ASC
) t;
" > artalk-comments.json
```

导入：

```bash
ARTALK_EXPORT_PATH=./artalk-comments.json pnpm comments:migrate:artalk
```

脚本是幂等的，同一批 Artalk 评论重复导入不会产生重复数据。
