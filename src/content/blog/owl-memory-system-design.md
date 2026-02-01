---
title: "AI Agent 记忆系统设计：三层分层架构实践"
description: "详解 Owl 项目中的 Memory 系统设计，包括短期记忆、工作记忆、长期记忆的分层架构，以及遗忘门、记忆整合等核心机制。"
pubDate: "2026-02-01"
categories:
  - 技术
  - 项目
tags:
  - Go
  - AI
  - Agent
  - Memory
  - PostgreSQL
  - 向量检索
---

在构建 AI Agent 时，记忆系统是核心组件之一。没有记忆，Agent 就无法从过去的经验中学习，也无法在多轮对话中保持上下文。这篇文章记录 Owl 项目中 Memory 系统的设计思路和实现细节。

## 整体架构

借鉴人类记忆的分层模型，设计了三层记忆架构：

```
┌─────────────────────────────────────────────────────┐
│              MemoryManager (统一入口)                │
└─────────────────────────────────────────────────────┘
                        ↓
┌──────────────┬──────────────┬──────────────────────┐
│  ShortTerm   │   Working    │      LongTerm        │
│   Memory     │   Memory     │       Memory         │
│   (内存)     │  (数据库)    │      (数据库)        │
│              │              │  Episodes + Knowledge│
└──────────────┴──────────────┴──────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│           PostgreSQL + pgvector                      │
└─────────────────────────────────────────────────────┘
```

| 记忆层 | 存储位置 | 生命周期 | 用途 |
|--------|----------|----------|------|
| 短期记忆 | 内存 | 会话级别 | 当前对话上下文 |
| 工作记忆 | PostgreSQL | 任务级别 | 正在执行的任务状态 |
| 长期记忆 | PostgreSQL + 向量 | 永久 | 历史经验和知识 |

## 短期记忆 (ShortTermMemory)

短期记忆存储当前会话的对话历史，用于保持多轮对话的上下文。

### 数据结构

```go
type ShortTermMemory struct {
    mu       sync.RWMutex
    sessions map[string]*SessionContext
    maxTurns int           // 每个会话最多保留轮数
    ttl      time.Duration // 会话不活跃后清理时间
}

type SessionContext struct {
    SessionID  string
    UserID     string
    Messages   []ChatMessage
    LastActive time.Time
}

type ChatMessage struct {
    Role      string         // "user" | "assistant"
    Content   string
    Timestamp time.Time
    Metadata  map[string]any
}
```

### 核心逻辑

- **保存消息**：每条消息实时保存到内存，更新 `LastActive` 时间戳
- **容量限制**：每个会话最多保留 `maxTurns * 2` 条消息，超出时删除最早的
- **自动清理**：后台协程每分钟检查一次，清理超过 TTL 的不活跃会话

```go
func (s *ShortTermMemory) SaveMessage(sessionID, userID, role, content string) {
    s.mu.Lock()
    defer s.mu.Unlock()

    session, exists := s.sessions[sessionID]
    if !exists {
        session = &SessionContext{
            SessionID: sessionID,
            UserID:    userID,
            Messages:  make([]ChatMessage, 0),
        }
        s.sessions[sessionID] = session
    }

    session.Messages = append(session.Messages, ChatMessage{
        Role:      role,
        Content:   content,
        Timestamp: time.Now(),
    })
    session.LastActive = time.Now()

    // 限制消息数量
    maxMessages := s.maxTurns * 2
    if len(session.Messages) > maxMessages {
        session.Messages = session.Messages[len(session.Messages)-maxMessages:]
    }
}
```

## 工作记忆 (WorkingMemory)

工作记忆存储正在执行的任务状态，包括任务目标、执行步骤、中间结果等。

### 数据结构

```go
type TaskState struct {
    ID              string
    SessionID       string
    UserID          string
    OriginalRequest string         // 用户原始请求
    Summary         string         // 任务摘要
    Steps           []TaskStep     // 执行步骤列表
    CurrentStep     int            // 当前步骤索引
    Context         map[string]any // 任务上下文
    Status          string         // "in_progress" | "completed" | "failed"
    StartedAt       time.Time
    UpdatedAt       time.Time
}

type TaskStep struct {
    Description string
    ToolName    string         // 工具名称
    Args        map[string]any // 工具参数
    Result      string         // 执行结果
    Status      string         // "pending" | "in_progress" | "completed" | "failed"
    StartedAt   *time.Time
    CompletedAt *time.Time
}
```

### 数据库表

```sql
CREATE TABLE task_states (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    original_request TEXT NOT NULL,
    summary TEXT,
    steps JSONB DEFAULT '[]',
    current_step INTEGER DEFAULT 0,
    context JSONB DEFAULT '{}',
    status TEXT DEFAULT 'in_progress',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_task_states_session ON task_states(session_id);
CREATE INDEX idx_task_states_status ON task_states(status);
```

### 任务生命周期

```
StartTask() → AddStep() → UpdateStep() → CompleteTask()
    ↓                                         ↓
创建任务记录                              转换为 Episode
保存到数据库                              存入长期记忆
```

## 长期记忆 (LongTermMemory)

长期记忆分为两种类型：

| 类型 | 说明 | 来源 |
|------|------|------|
| Episodes | 完整的问题解决过程 | 任务完成后自动生成 |
| Knowledge | 整合后的通用知识 | 多个相似 Episodes 整合 |

### Episodes 结构

```go
type Episode struct {
    ID             string
    SessionID      string
    UserID         string
    TriggerType    string     // "user_request" | "alert" | "scheduled"
    TriggerSummary string     // 触发条件摘要
    Steps          []TaskStep // 执行步骤
    Outcome        string     // "success" | "partial" | "failed"
    OutcomeSummary string     // 结果摘要
    Embedding      []float32  // 向量 (1024维)
    Importance     float64    // 重要性评分 [0, 1]
    AccessCount    int        // 被检索命中次数
    LastAccessedAt *time.Time
    Pinned         bool       // 是否永不删除
    Target         string     // 操作目标
    Tags           []string
    CreatedAt      time.Time
}
```

### Knowledge 结构

```go
type Knowledge struct {
    ID             string
    Topic          string     // 知识主题
    Content        string     // 详细内容
    KeyPoints      []string   // 关键要点
    SourceEpisodes []string   // 来源 Episode IDs
    Embedding      []float32  // 向量
    Confidence     float64    // 置信度 [0.5, 1.0]
    AccessCount    int
    LastAccessedAt *time.Time
    CreatedAt      time.Time
    UpdatedAt      time.Time
}
```

### 向量检索

使用 pgvector 扩展实现语义检索：

```sql
CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    -- ... 其他字段
    embedding vector(1024),
    -- ...
);

-- 向量相似度索引
CREATE INDEX idx_episodes_embedding ON episodes
    USING ivfflat (embedding vector_cosine_ops);
```

检索流程：

```
用户查询 → Embedding → 向量相似度搜索 → Rerank 重排序 → 返回结果
```

```go
func (s *LongTermStore) SearchEpisodes(query string, limit int) ([]Episode, error) {
    // 1. 生成查询向量
    queryEmbedding, err := s.embedding.Embed(query)
    if err != nil {
        return nil, err
    }

    // 2. 向量相似度搜索 (取 3 倍候选)
    candidates, err := s.vectorSearch(queryEmbedding, limit*3)
    if err != nil {
        return nil, err
    }

    // 3. Rerank 重排序
    results, err := s.embedding.Rerank(query, candidates, limit)
    if err != nil {
        return nil, err
    }

    // 4. 异步更新访问计数
    go s.incrementAccessCount(results)

    return results, nil
}
```

## 遗忘门 (ForgetGate)

为了防止记忆无限增长，设计了遗忘门机制，自动清理不重要的记忆。

### 重要性评分算法

```go
func (f *ForgetGate) CalculateImportance(ep *Episode) float64 {
    score := 0.5 // 基础分

    // 时间衰减：每 30 天 -0.1，最多 -0.3
    age := time.Since(ep.CreatedAt)
    decay := math.Min(age.Hours()/720*0.1, 0.3)
    score -= decay

    // 访问频率：每次 +0.05，最多 +0.2
    accessBonus := math.Min(float64(ep.AccessCount)*0.05, 0.2)
    score += accessBonus

    // 结果因子
    switch ep.Outcome {
    case "success":
        score += 0.1
    case "failed":
        score -= 0.05
    }

    // 触发类型：告警触发更重要
    if ep.TriggerType == "alert" {
        score += 0.15
    }

    // 复杂度：步骤多的更重要
    if len(ep.Steps) > 3 {
        score += 0.1
    }

    return math.Max(0, math.Min(1, score))
}
```

### 清理逻辑

```go
func (f *ForgetGate) Cleanup() (int, error) {
    // 1. 更新所有 Episode 的重要性评分
    f.UpdateAllImportance()

    // 2. 删除低分记忆
    // 条件：importance < threshold AND created_at < minAge AND pinned = false
    deleted, err := f.deleteLowImportance()
    if err != nil {
        return 0, err
    }

    // 3. 超限处理：如果总数 > maxEpisodes，按重要性删除最低的
    if f.getCount() > f.config.MaxEpisodes {
        extra, _ := f.deleteExcess()
        deleted += extra
    }

    return deleted, nil
}
```

配置参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| Threshold | 0.25 | 删除阈值 |
| MaxEpisodes | 10000 | 最大 Episode 数 |
| MinAge | 7 天 | 最小保留期 |

## 记忆整合 (Consolidation)

当同一目标积累了足够多的 Episodes 时，自动整合为通用 Knowledge。

### 整合流程

```
找出未整合的 Episodes
        ↓
    按 target 分组
        ↓
Episodes 数 >= minEpisodes ?
        ↓ Yes
  调用 LLM 生成知识摘要
        ↓
    保存为 Knowledge
        ↓
标记 Episodes 已整合
```

### LLM Prompt

```
请根据以下关于 "{target}" 的 N 条操作记录，整合生成一条通用知识。

### 记录 1
- 触发: 用户请求重启容器
- 结果: 成功
- 步骤: docker stop → docker start → 检查状态

### 记录 2
...

输出 JSON 格式：
{
  "topic": "知识主题（简短）",
  "content": "整合后的知识内容（详细描述常见问题和解决方案）",
  "key_points": ["要点1", "要点2", "要点3"],
  "confidence": 0.8
}
```

## MemoryManager 统一入口

MemoryManager 协调各个记忆层，提供统一的 API：

```go
type MemoryManager struct {
    shortTerm    *ShortTermMemory
    working      *WorkingMemory
    longTerm     *LongTermStore
    forgetGate   *ForgetGate
    consolidator *Consolidator
    embedding    *EmbeddingService
}
```

### 核心 API

| 方法 | 功能 |
|------|------|
| `SaveMessage()` | 保存对话消息到短期记忆 |
| `GetRecentMessages()` | 获取最近对话 |
| `StartTask()` | 开始新任务 |
| `CompleteTask()` | 完成任务，自动转为 Episode |
| `SearchEpisodes()` | 语义检索历史经验 |
| `SearchKnowledge()` | 语义检索知识库 |
| `BuildContext()` | 构建完整记忆上下文 |
| `RunForgetGate()` | 执行遗忘清理 |
| `RunConsolidation()` | 执行记忆整合 |

### 上下文构建

```go
type MemoryContext struct {
    RecentMessages    []ChatMessage  // 最近对话
    CurrentTask       *TaskState     // 当前任务
    RelevantEpisodes  []Episode      // 相关经验
    RelevantKnowledge []Knowledge    // 相关知识
}

func (m *MemoryManager) BuildContext(sessionID, query string) (*MemoryContext, error) {
    ctx := &MemoryContext{}

    // 1. 加载短期记忆
    ctx.RecentMessages = m.shortTerm.GetMessages(sessionID)

    // 2. 加载工作记忆
    ctx.CurrentTask, _ = m.working.GetCurrentTask(sessionID)

    // 3. 语义检索长期记忆
    ctx.RelevantEpisodes, _ = m.longTerm.SearchEpisodes(query, 5)
    ctx.RelevantKnowledge, _ = m.longTerm.SearchKnowledge(query, 3)

    return ctx, nil
}
```

格式化为 LLM 输入：

```
## 最近对话
用户: 容器 nginx 状态怎么样？
助手: nginx 容器运行正常，已运行 3 天。

## 当前任务
请求: 重启 nginx 容器
状态: in_progress
当前步骤: 执行 docker restart

## 相关经验
- [成功] 重启 nginx 容器 → 使用 docker restart，等待 10 秒后检查状态
- [成功] 处理 nginx 502 错误 → 检查上游服务，重启后恢复

## 相关知识
### nginx 容器运维
重启 nginx 容器时，建议先检查配置文件语法...
```

## 数据流总结

```
用户发起对话
    ↓
BuildContext() ← 短期记忆 + 工作记忆 + 长期记忆
    ↓
LLM 生成回复
    ↓
SaveMessage() → 短期记忆
    ↓
执行任务 → StartTask() → UpdateStep() → CompleteTask()
    ↓                                         ↓
                                        SaveEpisode() → 长期记忆
    ↓
定期维护 → ForgetGate.Cleanup() + Consolidator.Run()
```

## 总结

这套记忆系统的核心设计思路：

1. **分层存储**：不同生命周期的数据用不同存储方式
2. **语义检索**：使用向量 + 重排序实现精准召回
3. **自动遗忘**：基于重要性评分自动清理，防止无限增长
4. **知识整合**：将具体经验抽象为通用知识

这套架构在实际使用中表现良好，Agent 能够有效利用历史经验来处理相似问题。

## 相关链接

- [pgvector - PostgreSQL 向量扩展](https://github.com/pgvector/pgvector)
- [BGE 系列模型](https://huggingface.co/BAAI/bge-large-zh-v1.5)
- [硅基流动 Embedding API](https://cloud.siliconflow.cn)
