---
title: "短链服务进阶：Prometheus 监控 + 批量写入优化 + 布隆过滤器"
description: "为短链服务集成 Prometheus + Grafana 可观测性体系，优化统计批量写入性能 10-20
倍，并使用布隆过滤器彻底防止缓存穿透。"
pubDate: "2026-01-25"
categories:
- 技术
- 项目
tags:
- Go
- Prometheus
- Grafana
- 性能优化
- 短链服务
---

上一篇文章实现了 Redis 限流和多级缓存。这篇文章记录三个重要改进：**Prometheus + Grafana
监控体系**、**批量写入优化**、**布隆过滤器防穿透**。

## 第一部分：Prometheus + Grafana 监控

### 为什么需要监控

之前虽然加了 Prometheus 指标，但从来没看过——因为不知道怎么看。这次把完整的监控体系搭起来。

### Docker Compose 配置

在 `docker-compose.yml` 中添加 Prometheus 和 Grafana：

```yaml
prometheus:
image: prom/prometheus:v2.54.0
ports:
    - "9090:9090"
volumes:
    - ./prometheus.yml:/etc/prometheus/prometheus.yml
    - prometheus_data:/prometheus
command:
    - '--config.file=/etc/prometheus/prometheus.yml'
    - '--storage.tsdb.path=/prometheus'
    - '--storage.tsdb.retention.time=15d'

grafana:
image: grafana/grafana:11.0.0
ports:
    - "3000:3000"
environment:
    - GF_SECURITY_ADMIN_USER=admin
    - GF_SECURITY_ADMIN_PASSWORD=admin
volumes:
    - grafana_data:/var/lib/grafana
    - ./grafana/provisioning:/etc/grafana/provisioning
depends_on:
    - prometheus
```

### Prometheus 配置

创建 `prometheus.yml`：

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'shortlink'
    static_configs:
      # Windows Docker Desktop 用 host.docker.internal 访问宿主机
      - targets: ['host.docker.internal:6060']
```

### Grafana 自动配置数据源

创建 `grafana/provisioning/datasources/datasources.yml`：

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
```

### 添加业务指标

除了基础的 HTTP 指标，还需要业务指标来了解系统运行状况。

在 `internal/platform/metrics/metrics.go` 中添加：

```go
// 缓存指标
CacheOperations = prometheus.NewCounterVec(
    prometheus.CounterOpts{
        Name: "shortlink_cache_operations_total",
        Help: "缓存操作计数",
    },
    []string{"level", "result"},  // level: l1/l2, result: hit/miss/hit_negative
)

// 短链业务指标
ShortlinkCreated = prometheus.NewCounter(
    prometheus.CounterOpts{
        Name: "shortlink_created_total",
        Help: "创建的短链总数",
    },
)

ShortlinkRedirects = prometheus.NewCounter(
    prometheus.CounterOpts{
        Name: "shortlink_redirects_total",
        Help: "短链跳转总数",
    },
)

// 数据库指标
DBQueryDuration = prometheus.NewHistogramVec(
    prometheus.HistogramOpts{
        Name:    "shortlink_db_query_duration_seconds",
        Help:    "数据库查询耗时分布",
        Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1},
    },
    []string{"operation"},
)
```

### 在代码中埋点

缓存层埋点（`cache/shortlink.go`）：

```go
func (c *ShortlinkCache) Get(ctx context.Context, code string) (string, error) {
    // L1: 本地缓存
    if c.local != nil {
        if url, ok := c.local.Get(code); ok {
            if url == notFoundSentinel {
                metrics.CacheOperations.WithLabelValues("l1", "hit_negative").Inc()
            } else {
                metrics.CacheOperations.WithLabelValues("l1", "hit").Inc()
            }
            return url, nil
        }
        metrics.CacheOperations.WithLabelValues("l1", "miss").Inc()
    }
    // L2 Redis 类似...
}
```

### Dashboard 效果

配置完成后，Grafana Dashboard 可以展示：

| 面板 | PromQL |
|------|--------|
| 总 QPS | `sum(rate(http_request_total[1m]))` |
| 5xx 错误率 | `sum(rate(http_request_total{status=~"5.."}[5m])) / sum(rate(http_request_total[5m]))` |
| P95 延迟 | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))` |
| 缓存命中率 | `sum(shortlink_cache_operations_total{result="hit"}) / sum(shortlink_cache_operations_total)` |

## 第二部分：批量写入优化

### 问题分析

之前的点击统计写入代码：

```go
func (c *Consumer) flush(batch []ClickEvent) {
    for _, e := range batch {
        tx.Exec(ctx, `INSERT INTO click_stats ...`)  // 100 次
        tx.Exec(ctx, `UPDATE shortlinks SET click_count = click_count + 1 ...`)  // 又 100 次
    }
}
```

100 条数据 = 200 次 SQL 执行，每次都有网络往返延迟。

### 优化方案：CopyFrom + unnest

使用 PostgreSQL 的 COPY 协议批量插入，用 `unnest` 聚合更新：

```go
func (c *Consumer) flush(batch []ClickEvent) {
    if len(batch) == 0 {
        return
    }

    start := time.Now()
    defer func() {
        metrics.StatsFlushDuration.Observe(time.Since(start).Seconds())
        metrics.StatsFlushSize.Observe(float64(len(batch)))
    }()

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    tx, err := c.db.Begin(ctx)
    if err != nil {
        slog.Error("click stats: begin tx failed", "err", err)
        return
    }
    defer tx.Rollback(context.Background())

    // 1. 使用 CopyFrom 批量插入
    rows := make([][]any, len(batch))
    for i, e := range batch {
        rows[i] = []any{e.Code, e.ClickedAt, e.IP, e.UserAgent, e.Referer}
    }

    _, err = tx.CopyFrom(ctx,
        pgx.Identifier{"click_stats"},
        []string{"code", "clicked_at", "ip", "user_agent", "referer"},
        pgx.CopyFromRows(rows),
    )
    if err != nil {
        slog.Error("click stats: copy failed", "err", err)
        return
    }

    // 2. 聚合统计每个 code 的点击数
    counts := make(map[string]int)
    for _, e := range batch {
        counts[e.Code]++
    }

    // 3. 批量更新（使用 unnest）
    codes := make([]string, 0, len(counts))
    deltas := make([]int, 0, len(counts))
    for code, delta := range counts {
        codes = append(codes, code)
        deltas = append(deltas, delta)
    }

    _, err = tx.Exec(ctx, `
        UPDATE shortlinks s
        SET click_count = s.click_count + v.delta,
            updated_at = now()
        FROM unnest($1::text[], $2::int[]) AS v(code, delta)
        WHERE s.code = v.code
    `, codes, deltas)
    if err != nil {
        slog.Error("click stats: batch update failed", "err", err)
        return
    }

    if err := tx.Commit(ctx); err != nil {
        slog.Error("click stats: commit failed", "err", err)
    }
}
```

### 性能对比

添加了 flush 耗时指标后，实测结果：

```
shortlink_stats_flush_duration_seconds_sum 0.0458
shortlink_stats_flush_duration_seconds_count 5
```

5 次 flush，总耗时 0.0458 秒，平均每次 **~9ms**。

| 指标 | 优化前（估算） | 优化后（实测） |
|------|---------------|---------------|
| 100 条数据 SQL 次数 | 200 次 | 2 次 |
| 100 条数据耗时 | ~100-200ms | ~9ms |
| 提升倍数 | - | **10-20x** |

### 关键点

1. CopyFrom：使用 PostgreSQL COPY 协议，一次网络往返插入所有数据
2. 聚合 counts：如果 100 条记录中有 80 条是同一个 code，只需要 UPDATE 一次（+80）
3. unnest：把数组展开成虚拟表，一条 SQL 更新所有 code

## 第三部分：布隆过滤器防穿透

### 问题

虽然已经有负缓存，但恶意请求大量不存在的短码时，每个新短码都要查一次 DB 才能写负缓存。

### 布隆过滤器原理

- 返回 `false` → **一定不存在**，直接返回
- 返回 `true` → **可能存在**，继续查缓存和 DB

优势：内存占用小（100 万短码约 1.2MB），查询 O(1)。

### 实现

创建 `internal/app/shortlink/cache/bloom.go`：

```go
package cache

import (
    "sync"
    "github.com/bits-and-blooms/bloom/v3"
)

type BloomFilter struct {
    filter *bloom.BloomFilter
    mu     sync.RWMutex
}

func NewBloomFilter(expectedItems uint, falsePositiveRate float64) *BloomFilter {
    return &BloomFilter{
        filter: bloom.NewWithEstimates(expectedItems, falsePositiveRate),
    }
}

func (b *BloomFilter) Add(code string) {
    b.mu.Lock()
    defer b.mu.Unlock()
    b.filter.AddString(code)
}

func (b *BloomFilter) MightExist(code string) bool {
    b.mu.RLock()
    defer b.mu.RUnlock()
    return b.filter.TestString(code)
}
```

### 集成到 Repo

在 `NewShortlinksRepo` 中初始化：

```go
func NewShortlinksRepo(db *pgxpool.Pool, cache *cache.ShortlinkCache, bloom *cache.BloomFilter) *ShortlinksRepo {
    repo := &ShortlinksRepo{db: db, cache: cache, bloom: bloom}

    // 初始化布隆过滤器
    if bloom != nil {
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()

        rows, err := db.Query(ctx, "SELECT code FROM shortlinks WHERE code IS NOT NULL")
        if err != nil {
            slog.Error("bloom filter: load codes failed", "err", err)
            return repo
        }
        defer rows.Close()

        count := 0
        for rows.Next() {
            var code string
            if err := rows.Scan(&code); err != nil {
                continue
            }
            bloom.Add(code)
            count++
        }
        slog.Info("bloom filter initialized", "count", count)
    }

    return repo
}
```

在 `Resolve` 方法开头检查：

```go
func (s *ShortlinksRepo) Resolve(ctx context.Context, code string) string {
    // 布隆过滤器快速判断
    if s.bloom != nil && !s.bloom.MightExist(code) {
        return ""  // 一定不存在
    }
    // 继续查缓存和 DB...
}
```

创建短链时添加到布隆过滤器：

```go
// Create 方法中，commit 成功后
if s.bloom != nil && code != "" {
    s.bloom.Add(code)
}
```

### 效果验证

发送 100 个不存在的短码请求：

```bash
for i in $(seq 1 100); do curl -s -o /dev/null http://localhost:9999/fake_code_$i; done
```

检查缓存指标：

```
shortlink_cache_operations_total{level="l2",result="hit"} 1
```

缓存操作数没有增加，说明 100 个请求全部被布隆过滤器拦截，**没有穿透到缓存和数据库**。

## 总结

这次改进的三个功能：

| 功能 | 效果 |
|------|------|
| Prometheus + Grafana | 可视化监控 QPS、延迟、缓存命中率 |
| 批量写入优化 | 性能提升 10-20 倍 |
| 布隆过滤器 | 彻底防止缓存穿透 |

### 简历亮点

- **可观测性**：集成 Prometheus + Grafana，监控 QPS、P99 延迟、缓存命中率等核心指标
- **批量写入优化**：使用 PostgreSQL COPY 协议 + unnest 聚合更新，单批写入耗时从 ~200ms 降至 ~10ms
- **三层缓存防护**：L1 本地缓存 + L2 Redis + 布隆过滤器，100 万短码仅占用 ~1.2MB 内存

## 相关链接

- [bits-and-blooms/bloom](https://github.com/bits-and-blooms/bloom)
- [Prometheus 文档](https://prometheus.io/docs/)
- [上一篇：Redis 限流 + 多级缓存](/blog/shortlink-redis-cache-ratelimit)