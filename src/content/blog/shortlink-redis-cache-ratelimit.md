---
title: "短链服务性能优化：Redis 限流 + 多级缓存实战"
description: "为短链服务集成 Redis 限流和缓存，使用 ristretto 实现本地二级缓存，并通过压测分析性能瓶颈。"
pubDate: "2026-01-17"
categories:
  - 技术
  - 项目
tags:
  - Go
  - Redis
  - 缓存
  - 性能优化
  - 短链服务
---

上一篇文章实现了点击统计和 Kafka 集成。这篇文章记录 Redis 限流、缓存的集成过程，以及一个有趣的发现：**加了 Redis 缓存后 QPS 反而下降了**。

## 需求分析

短链服务需要解决两个问题：

1. **防刷** - 恶意用户可能频繁调用创建接口或跳转接口
2. **减轻数据库压力** - 跳转是高频操作，每次都查数据库不合理

解决方案：Redis 限流 + 缓存。

## 第一部分：Redis 限流

### 限流策略设计

| 接口 | 限制 | Key 格式 |
|------|------|----------|
| 创建短链 | 10次/分钟/IP | `rl:create:{ip}` |
| 短链跳转 | 100次/分钟/IP | `rl:redirect:{ip}` |
| 登录 | 5次/分钟/IP | `rl:login:{ip}` |
| 注册 | 3次/分钟/IP | `rl:register:{ip}` |

### 滑动窗口 vs 固定窗口

| 方案 | 优点 | 缺点 |
|------|------|------|
| 固定窗口 | 简单（INCR + EXPIRE） | 窗口边界可能突发双倍流量 |
| 滑动窗口 | 精确 | 实现稍复杂 |

我选择了**滑动窗口**，使用 Redis ZSET + Lua 脚本实现原子操作。

### Lua 脚本实现

为什么要用 Lua 脚本？并发场景下，多个 Redis 命令如果不是原子的，会出现计数不准的问题。

```lua
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

-- 清理过期数据
local windowStart = now - window
redis.call("ZREMRANGEBYSCORE", key, 0, windowStart)

-- 添加当前请求
redis.call("ZADD", key, now, member)

-- 统计窗口内请求数
local count = redis.call("ZCARD", key)

-- 设置过期时间
redis.call("PEXPIRE", key, window)

if count <= limit then
  return {1, 0}  -- 放行
end

-- 超限：回滚当前请求，计算重试时间
redis.call("ZREM", key, member)
local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
if oldest[2] ~= nil then
  local retryAfter = (tonumber(oldest[2]) + window) - now
  return {0, retryAfter}
end
return {0, window}
```

**关键点**：

1. `member` 必须唯一（用 `timestamp-requestID`），否则同毫秒请求会覆盖
2. 超限时要 `ZREM` 回滚，避免被拒绝的请求占用配额
3. 返回 `retryAfter` 让客户端知道何时重试

### Go 限流器封装

```go
// internal/platform/ratelimit/limiter.go
type Limiter struct {
    client *redis.Client
}

func (l *Limiter) Allow(ctx context.Context, key string, limit int, window time.Duration, member string) (bool, time.Duration, error) {
    nowMs := time.Now().UnixMilli()
    windowMs := window.Milliseconds()

    res, err := l.client.Eval(ctx, luaScript, []string{key}, nowMs, windowMs, limit, member).Result()
    // ... 解析结果
    return allowed, retryAfter, nil
}
```

### 限流中间件

```go
// internal/platform/httpmiddleware/ratelimit.go
func RateLimit(limiter *ratelimit.Limiter, prefix string, limit int, window time.Duration) gee.HandlerFunc {
    return func(c *gee.Context) {
        if limiter == nil {
            c.Next()  // Redis 不可用时放行
            return
        }

        ip := c.ClientIP()
        reqID := c.GetHeader("X-Request-ID")
        key := fmt.Sprintf("rl:%s:%s", prefix, ip)
        member := fmt.Sprintf("%d-%s", time.Now().UnixNano(), reqID)

        allowed, retryAfter, err := limiter.Allow(c.Req.Context(), key, limit, window, member)
        if err != nil {
            slog.Error("rate limit error", "err", err)
            c.Next()  // 故障时放行
            return
        }

        if !allowed {
            c.SetHeader("Retry-After", fmt.Sprintf("%d", int(retryAfter.Seconds())+1))
            c.AbortWithError(http.StatusTooManyRequests, "rate limit exceeded")
            return
        }
        c.Next()
    }
}
```

### 路由集成

gee 框架支持每个路由多个 handler，限流中间件可以精细控制：

```go
// 创建短链 - 10次/分钟
api.POST("/shortlinks",
    httpmiddleware.RateLimit(limiter, "create", 10, time.Minute),
    shortlinkhttpapi.NewCreateHandler(slRepo))

// 跳转 - 100次/分钟
r.GET("/:code",
    httpmiddleware.RateLimit(limiter, "redirect", 100, time.Minute),
    shortlinkhttpapi.NewRedirectHandler(slRepo, collector))
```

## 第二部分：Redis 缓存

### 缓存设计

- **Key**: `sl:{code}`
- **Value**: 原始 URL
- **TTL**: 1 小时
- **负缓存**: 不存在的短码缓存 `__nil__`，TTL 30 秒

### 缓存层实现

```go
// internal/app/shortlink/cache/shortlink.go
type ShortlinkCache struct {
    client   *redis.Client
    ttl      time.Duration
    emptyTTL time.Duration
}

func (c *ShortlinkCache) Get(ctx context.Context, code string) (string, error) {
    res, err := c.client.Get(ctx, "sl:"+code).Result()
    if err == redis.Nil {
        return "", nil
    }
    return res, err
}

func (c *ShortlinkCache) Set(ctx context.Context, code, url string) error {
    return c.client.Set(ctx, "sl:"+code, url, c.ttl).Err()
}

func (c *ShortlinkCache) SetNotFound(ctx context.Context, code string) error {
    return c.client.Set(ctx, "sl:"+code, "__nil__", c.emptyTTL).Err()
}
```

### Resolve 方法改造

```go
func (s *ShortlinksRepo) Resolve(ctx context.Context, code string) string {
    // 1. 查缓存
    if s.cache != nil {
        if url, _ := s.cache.Get(ctx, code); url != "" {
            if url == "__nil__" {
                return ""  // 命中负缓存
            }
            return url
        }
    }

    // 2. 查数据库
    var url string
    err := s.db.QueryRow(ctx,
        "SELECT url FROM shortlinks WHERE code=$1 AND disabled=false",
        code).Scan(&url)

    if err != nil {
        if errors.Is(err, pgx.ErrNoRows) && s.cache != nil {
            s.cache.SetNotFound(ctx, code)  // 写负缓存
        }
        return ""
    }

    // 3. 回填缓存
    if s.cache != nil {
        s.cache.Set(ctx, code, url)
    }
    return url
}
```

## 第三部分：性能测试的意外发现

### 压测结果对比

用 k6 跑了两组压测（50 VU，1 分钟）：

| 指标 | 无 Redis 缓存 | 有 Redis 缓存 | 变化 |
|------|--------------|--------------|------|
| QPS | 6689 | 5178 | **-22%** |
| avg 延迟 | 7.21ms | 8.88ms | +23% |
| p95 延迟 | 12.58ms | 19ms | +51% |

**加了缓存反而更慢了？**

### 原因分析

#### 1. 最初的 Lua 脚本过于复杂

最初我实现了"热点自动续期"功能：

```lua
-- 每次 GET 都执行这个脚本
local v = redis.call("GET", key)        -- 调用 1
local pttl = redis.call("PTTL", key)    -- 调用 2
if pttl < threshold then
  redis.call("PEXPIRE", key, targetTTL) -- 可能调用 3
end
return v
```

本意是好的：热点数据自动续期，冷数据自然过期。但每次读取都执行 2-3 个 Redis 命令，**把简单的 GET 变成了复杂操作**。

#### 2. 缓存未命中时开销更大

压测场景只有 20 个短链，缓存刚开始是空的。未命中时的调用链：

```
无缓存：App → PostgreSQL（1次网络往返）
有缓存：App → Redis → PostgreSQL → Redis（最多3次网络往返）
```

#### 3. 数据库还没成为瓶颈

PostgreSQL 的查询有索引：

```sql
SELECT url FROM shortlinks WHERE code=$1 AND disabled=false
```

在当前 QPS 下（~7000），数据库完全扛得住。引入 Redis 反而增加了网络开销。

### 优化：简化 GET 操作

去掉自动续期，用简单的 GET：

```go
func (c *ShortlinkCache) Get(ctx context.Context, code string) (string, error) {
    res, err := c.client.Get(ctx, "sl:"+code).Result()
    if err == redis.Nil {
        return "", nil
    }
    return res, err
}
```

同时关闭 Redis AOF（纯缓存场景不需要持久化）：

```yaml
# docker-compose.yml
redis:
  command: redis-server --appendonly no --save ""
```

## 第四部分：本地缓存（ristretto）

即使优化了 Redis 操作，网络往返仍然是开销。对于追求极致 QPS 的场景，可以加本地缓存。

### 为什么选 ristretto

| 库 | 特点 | 适用场景 |
|-----|------|----------|
| **ristretto** | 高性能、TinyLFU 智能淘汰 | 通用首选 |
| bigcache | 零 GC | 大量小对象 |
| sync.Map | 标准库、无 TTL | 最简单场景 |

ristretto 使用 TinyLFU 算法，能自动保留高频访问的热点数据。

### 本地缓存实现

```go
// internal/app/shortlink/cache/local.go
type LocalCache struct {
    cache    *ristretto.Cache
    ttl      time.Duration
    emptyTTL time.Duration
}

func NewLocalCache(maxItems int64, maxCost int64) (*LocalCache, error) {
    cache, err := ristretto.NewCache(&ristretto.Config{
        NumCounters: maxItems * 10,  // TinyLFU 计数器
        MaxCost:     maxCost,        // 最大内存
        BufferItems: 64,
    })
    if err != nil {
        return nil, err
    }
    return &LocalCache{
        cache:    cache,
        ttl:      5 * time.Minute,   // 本地 TTL 短一些
        emptyTTL: 10 * time.Second,
    }, nil
}

func (l *LocalCache) Get(code string) (string, bool) {
    if v, ok := l.cache.Get(code); ok {
        return v.(string), true
    }
    return "", false
}

func (l *LocalCache) Set(code, url string) {
    l.cache.SetWithTTL(code, url, 1, l.ttl)
}
```

### 关于 NumCounters

`NumCounters` 是 TinyLFU 算法用来统计访问频率的计数器数量。ristretto 使用 Count-Min Sketch 数据结构：

- 计数器越多，频率统计越准确
- 官方建议设为预期 key 数量的 **10 倍**
- 100万计数器约占 8MB 内存

### 多级缓存架构

```
请求
  ↓
┌─────────────────┐
│ L1: 本地缓存     │  ← ~100ns，TTL 5分钟
│ (ristretto)     │
└────────┬────────┘
         ↓ miss
┌─────────────────┐
│ L2: Redis       │  ← ~0.5ms，TTL 1小时
└────────┬────────┘
         ↓ miss
┌─────────────────┐
│ L3: PostgreSQL  │  ← ~2ms
└─────────────────┘
```

### 集成到 ShortlinkCache

把本地缓存集成到已有的 `ShortlinkCache` 中，repo 层不用改：

```go
type ShortlinkCache struct {
    client *redis.Client
    local  *LocalCache  // L1 本地缓存
    ttl    time.Duration
    emptyTTL time.Duration
}

func (c *ShortlinkCache) Get(ctx context.Context, code string) (string, error) {
    // L1: 本地缓存
    if c.local != nil {
        if url, ok := c.local.Get(code); ok {
            return url, nil
        }
    }

    // L2: Redis
    res, err := c.client.Get(ctx, "sl:"+code).Result()
    if err == redis.Nil {
        return "", nil
    }
    if err != nil {
        return "", err
    }

    // 回填本地缓存
    if c.local != nil {
        c.local.Set(code, res)
    }
    return res, nil
}
```

### TTL 策略

| 层级 | 正缓存 TTL | 负缓存 TTL | 原因 |
|------|-----------|-----------|------|
| 本地 | 5 分钟 | 10 秒 | 短一些，保证多实例一致性 |
| Redis | 1 小时 | 30 秒 | 长一些，减少数据库压力 |

### 多实例一致性

本地缓存的问题：多个 App 实例的本地缓存不共享。

```
┌─────────┐     ┌─────────┐
│ 实例 A  │     │ 实例 B  │
│ 本地缓存 │     │ 本地缓存 │  ← 各自独立
└────┬────┘     └────┬────┘
     └───────┬───────┘
             │
      ┌──────┴──────┐
      │    Redis    │  ← 共享
      └─────────────┘
```

解决方案：

1. 本地缓存 TTL 设短（5 分钟）
2. 禁用短链时同时删除本地缓存和 Redis 缓存
3. 其他实例的本地缓存最多延迟 5 分钟自动过期

```go
func (c *ShortlinkCache) Delete(ctx context.Context, code string) error {
    if c.local != nil {
        c.local.Del(code)  // 删除本地缓存
    }
    return c.client.Del(ctx, "sl:"+code).Err()  // 删除 Redis
}
```

## 第五部分：Redis 的真正价值

经过这次折腾，我对 Redis 缓存的认识更清晰了：

### Redis 缓存不一定提升单机 QPS

在以下情况，Redis 可能帮不上忙甚至帮倒忙：

- 数据库本身够快（有索引、数据量小）
- 网络延迟抵消了查询优化
- 缓存操作过于复杂

### Redis 的真正价值

| 场景 | Redis 价值 |
|------|-----------|
| **多实例共享** | 3 个 App 实例共享同一份缓存 |
| **数据库扛不住** | 万级 QPS 时分流压力 |
| **重启不丢缓存** | App 重启后不需要预热 |
| **分布式一致性** | 禁用操作一处生效全局可见 |

### 性能优化的正确顺序

1. **先测量** - 找到真正的瓶颈
2. **简单优先** - 简单的 GET 比复杂 Lua 脚本快
3. **本地缓存** - 追求极致性能时再加
4. **关闭不必要的持久化** - 纯缓存不需要 AOF

## 总结

这次集成的改动：

1. **Redis 限流** - 滑动窗口 + Lua 脚本，防止接口被刷
2. **Redis 缓存** - 简单 GET/SET，减少数据库压力
3. **本地缓存** - ristretto 二级缓存，热点 QPS 翻倍
4. **关闭 AOF** - 纯缓存场景不需要持久化

最重要的教训：**性能优化要基于测量，不要想当然**。加缓存不一定更快，复杂的"优化"可能适得其反。

## 相关链接

- [ristretto 文档](https://github.com/dgraph-io/ristretto)
- [go-redis 文档](https://github.com/redis/go-redis)
- [上一篇：点击统计与 Kafka 异步处理](/blog/shortlink-click-stats-kafka)
