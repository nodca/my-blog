---
title: "短链服务进阶：点击统计与 Kafka 异步处理"
description: "为短链服务添加点击统计功能，使用 Channel 和 Kafka 两种方案实现异步收集，以及 Sqids 随机短码生成。"
pubDate: "2026-01-16"
categories:
  - 技术
  - 项目
tags:
  - Go
  - Kafka
  - 异步处理
  - 短链服务
---

上一篇文章介绍了短链服务的基础实现。这篇文章记录几个重要的功能升级：使用 Sqids 生成不可预测的短码、实现点击统计功能、集成 Kafka 消息队列。

## Sqids：更安全的短码生成

### 为什么换掉 Base62

之前使用自增 ID + Base62 编码生成短码：

```go
// ID=1 -> "1", ID=2 -> "2", ID=100 -> "1C"
code := EncodeBase62(uint64(id))
```

问题很明显：短码可预测，容易被枚举遍历。

### Sqids 方案

[Sqids](https://sqids.org/) 是一个开源的 ID 混淆库，可以将数字转换为随机外观的短字符串：

```go
import "github.com/sqids/sqids-go"

// 初始化（使用自定义字母表增加随机性）
s, _ := sqids.New(sqids.Options{
    Alphabet:  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    MinLength: 3,
})

// 编码
code, _ := s.Encode([]uint64{123})  // -> "Xk9" (每次相同)

// 解码
ids := s.Decode("Xk9")  // -> [123]
```

**特点**：

1. **确定性**：同一 ID 总是生成相同短码，无需存储映射
2. **不可预测**：外观随机，无法推断原始 ID
3. **可逆**：可以从短码还原 ID（虽然我们不需要）
4. **无冲突**：数学保证不会碰撞

### 使用 sync.Once 延迟初始化

Sqids 初始化需要配置参数，使用 `sync.Once` 实现懒加载：

```go
var (
    sq     *sqids.Sqids
    sqOnce sync.Once
)

func SqInit() {
    sqOnce.Do(func() {
        var err error
        sq, err = sqids.New(sqids.Options{
            Alphabet:  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            MinLength: 3,
        })
        if err != nil {
            panic(err)
        }
    })
}

func EncodeSqids(id uint64) string {
    SqInit()
    code, _ := sq.Encode([]uint64{id})
    return code
}
```

**注意**：字母表必须是 62 个不重复字符，重复会导致初始化失败。

## 点击统计功能

### 需求分析

每次短链跳转时记录：

- 访问时间
- 客户端 IP
- User-Agent
- Referer

同时更新短链的总点击数。

### 设计考量

**直接同步写入的问题**：

```go
// 不推荐：每次跳转都写数据库
func RedirectHandler(c *gee.Context) {
    url := repo.Resolve(code)
    repo.InsertClickStat(code, ip, ua, referer)  // 阻塞！
    repo.IncrementClickCount(code)               // 又一次 DB 操作
    c.Redirect(302, url)
}
```

跳转是高频操作，同步写入会：
1. 增加响应延迟
2. 数据库压力大
3. 影响用户体验

**解决方案**：异步收集 + 批量写入

### 数据库设计

```sql
-- 点击明细表（不加外键，提高写入性能）
CREATE TABLE click_stats (
    id         BIGSERIAL PRIMARY KEY,
    code       TEXT NOT NULL,
    clicked_at TIMESTAMPTZ NOT NULL,
    ip         TEXT,
    user_agent TEXT,
    referer    TEXT
);

CREATE INDEX idx_click_stats_code ON click_stats(code);
CREATE INDEX idx_click_stats_clicked_at ON click_stats(clicked_at);

-- 在 shortlinks 表添加计数字段
ALTER TABLE shortlinks ADD COLUMN click_count BIGINT NOT NULL DEFAULT 0;
```

**为什么不加外键**：

- 写入频繁，外键检查有性能开销
- 短链被删除后，统计数据仍有分析价值
- 可以用定时任务清理孤儿数据

### Channel 异步收集方案

#### 1. 定义事件和收集器接口

```go
// stats/collector.go
package stats

import "time"

type ClickEvent struct {
    Code      string    `json:"code"`
    ClickedAt time.Time `json:"clicked_at"`
    IP        string    `json:"ip,omitempty"`
    UserAgent string    `json:"user_agent,omitempty"`
    Referer   string    `json:"referer,omitempty"`
}

type Collector interface {
    Collect(event ClickEvent)
    Close()
}
```

#### 2. Channel 收集器实现

```go
type ChannelCollector struct {
    ch     chan ClickEvent
    closed bool
    mu     sync.Mutex
}

func NewChannelCollector(bufferSize int) *ChannelCollector {
    return &ChannelCollector{
        ch: make(chan ClickEvent, bufferSize),
    }
}

func (c *ChannelCollector) Collect(event ClickEvent) {
    c.mu.Lock()
    defer c.mu.Unlock()
    if c.closed {
        return
    }
    select {
    case c.ch <- event:
    default:
        slog.Warn("click event channel full, dropping event")
    }
}

func (c *ChannelCollector) Events() <-chan ClickEvent {
    return c.ch
}

func (c *ChannelCollector) Close() {
    c.mu.Lock()
    defer c.mu.Unlock()
    if !c.closed {
        c.closed = true
        close(c.ch)
    }
}
```

**要点**：

- 带缓冲的 channel 避免阻塞生产者
- `select default` 处理 channel 满的情况（丢弃而非阻塞）
- 加锁保护 `closed` 状态

#### 3. 批量消费者

```go
// stats/consumer.go
type Consumer struct {
    db        *pgxpool.Pool
    collector *ChannelCollector
    batchSize int
    interval  time.Duration
}

func NewConsumer(db *pgxpool.Pool, c *ChannelCollector) *Consumer {
    return &Consumer{
        db:        db,
        collector: c,
        batchSize: 100,
        interval:  time.Second,
    }
}

func (c *Consumer) Run(ctx context.Context) {
    batch := make([]ClickEvent, 0, c.batchSize)
    ticker := time.NewTicker(c.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            c.flush(batch)  // 退出前刷新剩余数据
            return

        case event, ok := <-c.collector.Events():
            if !ok {
                c.flush(batch)
                return
            }
            batch = append(batch, event)
            if len(batch) >= c.batchSize {
                c.flush(batch)
                batch = batch[:0]
            }

        case <-ticker.C:
            if len(batch) > 0 {
                c.flush(batch)
                batch = batch[:0]
            }
        }
    }
}
```

**批量写入逻辑**：

- 攒够 `batchSize` 条就写入
- 或者每隔 `interval` 时间写入（防止低流量时数据延迟太久）
- 程序退出时刷新剩余数据

#### 4. flush 实现

```go
func (c *Consumer) flush(batch []ClickEvent) {
    if len(batch) == 0 {
        return
    }

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    tx, err := c.db.Begin(ctx)
    if err != nil {
        slog.Error("begin tx failed", "err", err)
        return
    }
    defer tx.Rollback(context.Background())

    for _, e := range batch {
        tx.Exec(ctx,
            `INSERT INTO click_stats (code,clicked_at,ip,user_agent,referer)
             VALUES ($1,$2,$3,$4,$5)`,
            e.Code, e.ClickedAt, e.IP, e.UserAgent, e.Referer)

        tx.Exec(ctx,
            `UPDATE shortlinks SET click_count = click_count + 1 WHERE code = $1`,
            e.Code)
    }

    if err := tx.Commit(ctx); err != nil {
        slog.Error("commit failed", "err", err)
    }
}
```

#### 5. 集成到跳转 Handler

```go
func NewRedirectHandler(repo *ShortlinksRepo, collector stats.Collector) gee.HandlerFunc {
    return func(c *gee.Context) {
        code := c.Param("code")
        url := repo.Resolve(c.Request.Context(), code)

        if url == "" {
            c.AbortWithStatus(http.StatusNotFound)
            return
        }

        // 异步收集，不阻塞响应
        collector.Collect(stats.ClickEvent{
            Code:      code,
            ClickedAt: time.Now(),
            IP:        c.ClientIP(),
            UserAgent: c.GetHeader("User-Agent"),
            Referer:   c.GetHeader("Referer"),
        })

        c.Redirect(http.StatusFound, url)
    }
}
```

## Kafka 方案

Channel 方案适合单机部署。如果需要：

- 多实例部署
- 更高的可靠性（消息持久化）
- 解耦生产者和消费者

可以换成 Kafka。

### Docker 部署 Kafka

```yaml
# docker-compose.yml
kafka:
  image: apache/kafka:latest
  ports:
    - "9092:9092"
  environment:
    KAFKA_NODE_ID: 1
    KAFKA_PROCESS_ROLES: broker,controller
    KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
    KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
    KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
    KAFKA_CONTROLLER_QUORUM_VOTERS: 1@localhost:9093
    KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
    CLUSTER_ID: "MkU3OEVBNTcwNTJENDM2Qk"
    # 单节点配置 - 副本因子必须为1
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
    KAFKA_DEFAULT_REPLICATION_FACTOR: 1
    KAFKA_MIN_INSYNC_REPLICAS: 1
  volumes:
    - kafka_data:/var/lib/kafka/data
```

这是 KRaft 模式，不需要 Zookeeper。

### Kafka Collector

```go
// stats/kafka_collector.go
import "github.com/segmentio/kafka-go"

type KafkaCollector struct {
    writer *kafka.Writer
}

func NewKafkaCollector(brokers []string, topic string) *KafkaCollector {
    return &KafkaCollector{
        writer: &kafka.Writer{
            Addr:     kafka.TCP(brokers...),
            Topic:    topic,
            Balancer: &kafka.LeastBytes{},
            Async:    true,  // 异步发送
        },
    }
}

func (k *KafkaCollector) Collect(event ClickEvent) {
    data, _ := json.Marshal(event)
    k.writer.WriteMessages(context.Background(), kafka.Message{
        Value: data,
    })
}

func (k *KafkaCollector) Close() {
    k.writer.Close()
}
```

### Kafka Consumer（批量）

```go
// stats/kafka_consumer.go
type KafkaConsumer struct {
    reader    *kafka.Reader
    db        *pgxpool.Pool
    batchSize int
    interval  time.Duration
}

func NewKafkaConsumer(brokers []string, topic string, db *pgxpool.Pool) *KafkaConsumer {
    return &KafkaConsumer{
        reader: kafka.NewReader(kafka.ReaderConfig{
            Brokers:  brokers,
            Topic:    topic,
            GroupID:  "click-stats-consumer",
            MinBytes: 1,
            MaxBytes: 10e6,
        }),
        db:        db,
        batchSize: 100,
        interval:  time.Second,
    }
}

func (k *KafkaConsumer) Run(ctx context.Context) {
    batch := make([]ClickEvent, 0, k.batchSize)
    ticker := time.NewTicker(k.interval)
    defer ticker.Stop()

    msgCh := make(chan ClickEvent, k.batchSize)

    // 读取协程
    go func() {
        for {
            msg, err := k.reader.ReadMessage(ctx)
            if err != nil {
                if ctx.Err() != nil {
                    close(msgCh)
                    return
                }
                continue
            }
            var event ClickEvent
            json.Unmarshal(msg.Value, &event)
            msgCh <- event
        }
    }()

    // 批量处理（逻辑同 Channel Consumer）
    for {
        select {
        case <-ctx.Done():
            k.flush(batch)
            return
        case event, ok := <-msgCh:
            if !ok {
                k.flush(batch)
                return
            }
            batch = append(batch, event)
            if len(batch) >= k.batchSize {
                k.flush(batch)
                batch = batch[:0]
            }
        case <-ticker.C:
            if len(batch) > 0 {
                k.flush(batch)
                batch = batch[:0]
            }
        }
    }
}
```

### 配置切换

```go
// config.go
type Config struct {
    // ...
    KafkaEnabled bool     `env:"KAFKA_ENABLED" envDefault:"false"`
    KafkaBrokers []string `env:"KAFKA_BROKERS" envSeparator:","`
    KafkaTopic   string   `env:"KAFKA_TOPIC" envDefault:"click-events"`
}

// main.go
var collector stats.Collector
if cfg.KafkaEnabled {
    collector = stats.NewKafkaCollector(cfg.KafkaBrokers, cfg.KafkaTopic)
    kafkaConsumer := stats.NewKafkaConsumer(cfg.KafkaBrokers, cfg.KafkaTopic, dbPool)
    go kafkaConsumer.Run(stopCtx)
} else {
    channelCollector := stats.NewChannelCollector(10000)
    collector = channelCollector
    consumer := stats.NewConsumer(dbPool, channelCollector)
    go consumer.Run(stopCtx)
}
```

通过环境变量 `KAFKA_ENABLED=true` 切换方案。

## 统计查询 API

### 接口设计

```
GET /api/v1/users/mine/:code/stats?limit=20&cursor=0
```

返回：

```json
{
  "total_clicks": 1234,
  "recent_clicks": [
    {
      "clicked_at": "2026-01-16T10:00:00Z",
      "ip": "1.2.3.4",
      "user_agent": "Mozilla/5.0...",
      "referer": "https://google.com"
    }
  ],
  "next_cursor": 20
}
```

### 游标分页

为什么用游标而不是 offset：

| 方案 | 优点 | 缺点 |
|------|------|------|
| OFFSET | 简单 | 大 offset 性能差 |
| 游标 | 性能稳定 | 无法跳页 |

```go
func (r *ShortlinksRepo) ListStatsByCode(ctx context.Context, code string, limit int, cursor int64) (*StatsResponse, error) {
    // 获取总点击数
    var totalClicks int64
    r.db.QueryRow(ctx,
        `SELECT click_count FROM shortlinks WHERE code = $1`,
        code).Scan(&totalClicks)

    // 获取明细（游标分页）
    rows, _ := r.db.Query(ctx,
        `SELECT id, clicked_at, ip, user_agent, referer
         FROM click_stats
         WHERE code = $1 AND id > $2
         ORDER BY id
         LIMIT $3`,
        code, cursor, limit)

    var clicks []ClickDetail
    var lastID int64
    for rows.Next() {
        var c ClickDetail
        rows.Scan(&c.ID, &c.ClickedAt, &c.IP, &c.UserAgent, &c.Referer)
        clicks = append(clicks, c)
        lastID = c.ID
    }

    return &StatsResponse{
        TotalClicks:  totalClicks,
        RecentClicks: clicks,
        NextCursor:   lastID,
    }, nil
}
```

### 权限控制

统计数据只能查看自己的短链：

```go
func NewGetStatsHandler(r *repo.ShortlinksRepo) gee.HandlerFunc {
    return func(ctx *gee.Context) {
        userID := ctx.MustGet("identity").(auth.Identity).UserID()
        code := ctx.Param("code")

        // 检查所有权
        owns, _ := r.UserOwnsShortlink(ctx.Req.Context(), userID, code)
        if !owns {
            ctx.AbortWithError(http.StatusForbidden, "no permission")
            return
        }

        // 查询统计...
    }
}
```

## 路由优先级 Bug 修复

开发过程中发现一个 trie 路由的 bug：静态路由和通配符路由优先级处理错误。

### 问题现象

```go
r.GET("/:code", redirectHandler)  // 通配符
r.GET("/healthz", healthHandler)  // 静态

// 访问 /healthz 应该匹配静态路由
// 实际却匹配了通配符，code="healthz"
```

### 原因分析

`matchChildren` 函数的条件写错了：

```go
// 错误写法
func (n *node) matchChildren(part string) []*node {
    for _, child := range n.children {
        if child.part == part || child.isWild {  // 问题在这里
            nodes = append(nodes, child)
        }
    }
    return nodes
}
```

`||` 导致通配符节点总是被匹配，即使有精确匹配的静态节点。

### 修复方案

静态路由优先：

```go
func (n *node) matchChildren(part string) []*node {
    var nodes []*node
    for _, child := range n.children {
        // 精确匹配优先
        if child.part == part && !child.isWild {
            nodes = append(nodes, child)
        }
    }
    // 没有精确匹配才考虑通配符
    if len(nodes) == 0 {
        for _, child := range n.children {
            if child.isWild {
                nodes = append(nodes, child)
            }
        }
    }
    return nodes
}
```

## 权限设计调整

### 问题

最初设计：用户可以"禁用"自己创建的短链。

但"禁用"意味着短链完全不可用，这应该是管理员的权限（比如发现违规内容）。

### 调整后

| 操作 | 权限 | 说明 |
|------|------|------|
| 禁用短链 | 管理员 | 短链完全不可访问 |
| 移除短链 | 用户 | 仅从"我的短链"列表移除，短链仍可访问 |

```go
// 管理员路由
admin := api.Group("/admin")
admin.Use(AuthRequired(ts), RequireRole("admin"))
admin.POST("/shortlinks/:code/disable", disableHandler)

// 用户路由
users := api.Group("/users")
users.Use(AuthRequired(ts))
users.DELETE("/mine/:code", removeFromListHandler)  // 只删除关联关系
```

## 总结

这次升级主要解决了：

1. **短码安全**：Sqids 替代 Base62，短码不可预测
2. **点击统计**：Channel 异步收集 + 批量写入，不影响跳转性能
3. **Kafka 集成**：为多实例部署和更高可靠性做准备
4. **路由 Bug**：修复静态/通配符优先级问题
5. **权限细化**：区分管理员禁用和用户移除

Channel 方案适合单机，Kafka 方案适合分布式。通过接口抽象，可以无缝切换。

## 相关链接

- [Sqids 官网](https://sqids.org/)
- [kafka-go 文档](https://github.com/segmentio/kafka-go)
- [上一篇：从零实现短链服务](/blog/building-shortlink-service)
