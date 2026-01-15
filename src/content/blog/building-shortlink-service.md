---
title: "从零实现短链服务：Go 后端项目实战"
description: "记录使用 Go 语言从零实现短链服务的完整过程，包括架构设计、核心算法、数据库设计和生产级基础设施集成。"
pubDate: "2026-01-15"
categories:
  - 技术
  - 项目
tags:
  - Go
  - 后端
  - 短链服务
  - PostgreSQL
---

这篇文章记录了我从零实现短链服务的完整过程。这个项目不仅是一个可用的产品，也是我学习后端开发的实践项目，涵盖了 Web 框架、数据库、认证、可观测性等核心技术点。

## 项目背景

短链服务（URL Shortener）是一个经典的后端项目，核心功能很简单：

1. 用户提交一个长 URL
2. 系统返回一个短码（如 `Ab3Kx9`）
3. 访问短链时，302 跳转到原始 URL

虽然功能简单，但要做到生产可用，需要考虑很多工程问题：性能、缓存、防刷、可观测性等。

## 技术栈

| 组件 | 选型 | 说明 |
|------|------|------|
| Web 框架 | 扩展后的 gee 及其后端脚手架 | 学习目的，理解框架原理 |
| 数据库 | PostgreSQL | 现代、功能强大 |
| 认证 | JWT (HS256) | 无状态、易扩展 |
| 指标 | Prometheus | 业界标准 |
| 追踪 | OpenTelemetry | 分布式追踪 |
| 部署 | Docker | 容器化 |

## 核心设计

### 短码生成算法

短码生成是短链服务的核心。常见方案有：

| 方案 | 优点 | 缺点 |
|------|------|------|
| 自增 ID + Base62 | 简单、无冲突 | 可被枚举 |
| 随机 + 冲突检测 | 不可枚举 | 需要重试 |
| 预生成号段 | 高性能 | 实现复杂 |

我选择了 **自增 ID + Base62** 方案，简单高效：

```go
const base62Chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

func EncodeBase62(n uint64) s
    if n == 0 {
        return string(base62Chars[0])
    }
    var result []byte
    for n > 0 {
        result = append([]byte{base62Chars[n%62]}, result...)
        n /= 62
    }
    return string(result)
}
```

6 位 Base62 可以表示 `62^6 = 568 亿` 个短链，足够使用。

### 数据库设计

```sql
-- 短链表
CREATE TABLE shortlinks (
    id            BIGSERIAL PRIMARY KEY,
    code          TEXT UNIQUE,              -- 短码
    url           TEXT UNIQUE NOT NULL,     -- 原始 URL（唯一约束实现去重）
    disabled      BOOLEAN NOT NULL DEFAULT FALSE,
    redirect_type TEXT NOT NULL DEFAULT '302',
    expires_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 用户-短链关联表
CREATE TABLE user_shortlinks (
    user_id      BIGINT REFERENCES users(id),
    shortlink_id BIGINT REFERENCES shortlinks(id),
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, shortlink_id)
);
```

**设计要点**：

1. **URL 唯一约束**：同一个 URL 只生成一个短码，避免重复
2. **关联表**：用户和短链是多对多关系（同一短链可被多人"收藏"）
3. **软删除**：`disabled` 字段而非物理删除，便于审计

### 创建短链流程

```go
func (s *ShortlinksRepo) Create(ctx context.Context, url string, userID *int64) (string, error) {
    tx, _ := s.db.Begin(ctx)
    defer tx.Rollback(ctx)

    // 1. 插入 URL，利用 ON CONFLICT 实现幂等
    var id int64
    var code string
    tx.QueryRow(ctx,
        `INSERT INTO shortlinks (url, disabled)
         VALUES ($1, false)
         ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url
         RETURNING id, COALESCE(code, '')`,
        url).Scan(&id, &code)

    // 2. 如果是新记录，生成短码
    if code == "" {
        code = EncodeBase62(uint64(id))
        tx.Exec(ctx,
            `UPDATE shortlinks SET code = $1 WHERE id = $2`,
            code, id)
    }

    // 3. 记录用户关联
    if userID != nil {
        tx.Exec(ctx,
            `INSERT INTO user_shortlinks (user_id, shortlink_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            *userID, id)
    }

    tx.Commit(ctx)
    return code, nil
}
```

**关键点**：

- 使用事务保证一致性
- `ON CONFLICT` 实现幂等（同一 URL 多次提交返回相同短码）
- 先插入获取 ID，再用 ID 生成短码

### 跳转流程

```go
func NewRedirectHandler(repo *ShortlinksRepo) gee.HandlerFunc {
    return func(c *gee.Context) {
        code := c.Param("code")
        url := repo.Resolve(c.Request.Context(), code)

        if url == "" {
            c.AbortWithStatus(http.StatusNotFound)
            return
        }

        c.SetHeader("Location", url)
        c.Status(http.StatusFound) // 302
    }
}
```

跳转逻辑非常简单：查询 -> 设置 Location -> 返回 302。

### 301 vs 302 的选择

| 状态码 | 行为 | 优点 | 缺点 |
|--------|------|------|------|
| 301 | 永久重定向，浏览器缓存 | 减少服务器压力 | 无法统计、无法更新 |
| 302 | 临时重定向，每次经过服务 | 可统计、可更新 | 服务器压力大 |

我默认使用 **302**，因为需要统计点击次数。

## API 设计

```
# 公开接口
POST /api/v1/shortlinks          # 创建短链
GET  /r/:code                    # 短链跳转

# 需要登录
GET  /api/v1/shortlinks/:code    # 查询短链信息
POST /api/v1/shortlinks/:code/disable  # 禁用短链
GET  /api/v1/users/me            # 当前用户信息
GET  /api/v1/users/mine          # 我的短链列表

# 用户认证
POST /api/v1/register            # 注册
POST /api/v1/login               # 登录（返回 JWT）
```

### 创建短链示例

```bash
# 请求
curl -X POST http://localhost:9999/api/v1/shortlinks \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/yourname"}'

# 响应
{
  "code": "1",
  "short_url": "http://localhost:9999/r/1",
  "url": "https://github.com/yourname"
}
```

### 访问短链

```bash
curl -i http://localhost:9999/r/1

# 响应
HTTP/1.1 302 Found
Location: https://github.com/yourname
```

## 用户认证

### JWT 认证流程

```
1. 用户登录 -> 验证密码 -> 签发 JWT
2. 后续请求携带 Authorization: Bearer <token>
3. 中间件解析 JWT -> 注入用户信息到 Context
```

### 密码存储

使用 bcrypt 哈希，不存储明文：

```go
// 注册时
hash, _ := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)

// 登录时
err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password))
```

### 可选认证中间件

创建短链接口支持匿名和登录两种模式：

```go
func AuthOptional(jwt auth.JWT) gee.HandlerFunc {
    return func(c *gee.Context) {
        token := extractToken(c)
        if token == "" {
            c.Next()
            return
        }

        identity, err := jwt.Verify(token)
        if err != nil {
            c.Next() // token 无效也放行，只是不注入用户信息
            return
        }

        c.Set("identity", identity)
        c.Next()
    }
}
```

## 可观测性

### Prometheus 指标

```go
// 请求计数
httpRequestsTotal := prometheus.NewCounterVec(
    prometheus.CounterOpts{
        Name: "http_requests_total",
        Help: "Total HTTP requests",
    },
    []string{"method", "path", "status"},
)

// 请求延迟
httpRequestDuration := prometheus.NewHistogramVec(
    prometheus.HistogramOpts{
        Name:    "http_request_duration_seconds",
        Help:    "HTTP request duration",
        Buckets: prometheus.DefBuckets,
    },
    []string{"method", "path"},
)
```

### OpenTelemetry 追踪

集成 `otelhttp` 中间件，自动为每个请求创建 span：

```go
handler := otelhttp.NewHandler(engine, "http-server")
```

### 健康检查

```go
// /healthz - 存活检查
func Healthz(c *gee.Context) {
    c.JSON(200, map[string]string{"status": "ok"})
}

// /readyz - 就绪检查（含数据库）
func Readyz(db *pgxpool.Pool) gee.HandlerFunc {
    return func(c *gee.Context) {
        if err := db.Ping(c.Request.Context()); err != nil {
            c.JSON(503, map[string]string{"status": "not ready"})
            return
        }
        c.JSON(200, map[string]string{"status": "ready"})
    }
}
```

## 项目结构

```
internal/
├── app/shortlink/           # 短链业务
│   ├── service.go           # 领域接口
│   ├── base62.go            # 编码算法
│   ├── validate.go          # URL 校验
│   ├── httpapi/             # HTTP 层
│   │   ├── register.go      # 路由注册
│   │   ├── shortlinks.go    # 短链 handlers
│   │   └── users.go         # 用户 handlers
│   └── repo/                # 数据访问层
│       ├── shortlinks.go
│       └── users.go
│
└── platform/                # 通用基础设施
    ├── config/              # 配置管理
    ├── db/                  # 数据库连接
    ├── auth/                # JWT 认证
    ├── httpmiddleware/      # HTTP 中间件
    ├── metrics/             # Prometheus
    └── trace/               # OpenTelemetry
```

**分层原则**：

- `platform/`：可复用的基础设施，不依赖具体业务
- `app/shortlink/`：短链业务代码
- `httpapi/`：HTTP 传输层，负责请求/响应
- `repo/`：数据访问层，负责数据库操作

## 待实现功能

### 高优先级

- [ ] **Redis 缓存**：跳转时先查缓存，减少 DB 压力
- [ ] **点击统计**：记录每个短链的访问次数
- [ ] **限流**：防止恶意刷接口

### 功能扩展

- [ ] **自定义短码**：允许用户指定短码（如 `/r/github`）
- [ ] **二维码生成**：为短链生成二维码图片
- [ ] **批量创建**：一次创建多个短链
- [ ] **过期时间**：支持设置短链有效期

### 性能优化

- [ ] **布隆过滤器**：快速判断短码是否存在，防止缓存穿透
- [ ] **singleflight**：防止缓存击穿
- [ ] **本地缓存**：热点短链使用本地缓存 + Redis 二级缓存

## 部署

### Docker 构建

```dockerfile
FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o api ./cmd/api

FROM alpine:latest
COPY --from=builder /app/api /api
EXPOSE 9999
CMD ["/api"]
```

### 环境变量

```bash
ADDR=:9999                    # HTTP 端口
ADMIN_ADDR=127.0.0.1:6060     # 管理端口（不对外暴露）
JWT_SECRET=<随机字符串>        # JWT 签名密钥
DB_DSN=postgres://user:pass@host:5432/db?sslmode=disable
```

### 运行

```bash
docker run -d \
  --name shortlink \
  -p 9999:9999 \
  -e ADDR=:9999 \
  -e JWT_SECRET=your_secret \
  -e DB_DSN=postgres://... \
  your-image:tag
```

## 总结

这个项目虽然功能不复杂，但涵盖了后端开发的核心技术点：

1. **Web 框架**：路由、中间件、请求处理
2. **数据库**：连接池、事务、SQL 优化
3. **认证**：JWT、密码哈希、权限控制
4. **可观测性**：日志、指标、追踪
5. **工程化**：分层架构、配置管理、容器化部署

后续会继续完善缓存、限流、统计等功能，让它更接近生产级服务。

## 相关链接

- [在线体验](https://s.cyb1.org)
- [项目源码](https://github.com/nodca/days)-后续开源
