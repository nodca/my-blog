---
title: "Go 调用 LLM API：从零实现最小可用客户端"
description: "用 Go 实现一个最小的 LLM 客户端，调用 DeepSeek API，理解 OpenAI 兼容格式的请求和响应结构。"
pubDate: "2026-01-18"
categories:
  - 技术
  - 项目
tags:
  - Go
  - LLM
  - AI
  - DeepSeek
  - API
---

最近在做一个 AI 工作流项目，第一步是实现 LLM 客户端。这篇文章记录从零开始调用 DeepSeek API 的过程。

### 请求格式

```
POST /v1/chat/completions
Authorization: Bearer sk-xxx
Content-Type: application/json

{
    "model": "deepseek-chat",
    "messages": [
        {"role": "system", "content": "你是一个助手"},
        {"role": "user", "content": "用一句话介绍 Go 语言"}
    ],
    "max_tokens": 1024,
    "temperature": 0.7,
    "stream": false
}
```

**关键字段**：

| 字段 | 说明 |
|------|------|
| `model` | 模型名，不同平台不同 |
| `messages` | 对话历史，包含 role 和 content |
| `max_tokens` | 最大输出 token 数 |
| `temperature` | 随机性，0-2，越高越随机 |
| `stream` | 是否流式输出 |

**role 类型**：

| Role | 说明 |
|------|------|
| `system` | 系统提示词，设定 AI 人设 |
| `user` | 用户输入 |
| `assistant` | AI 的回复 |

### 响应格式

```json
{
    "id": "chatcmpl-xxx",
    "object": "chat.completion",
    "created": 1234567890,
    "model": "deepseek-chat",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Go 是一门由 Google 开发的静态强类型、编译型语言..."
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 20,
        "completion_tokens": 50,
        "total_tokens": 70
    }
}
```

**关键字段**：

| 字段 | 说明 |
|------|------|
| `choices[0].message.content` | AI 的回复内容 |
| `finish_reason` | 结束原因：stop（正常）、length（超长度） |
| `usage` | token 消耗，用于计费 |

## Go 实现

### 定义数据结构

```go
// internal/llm/deepseek.go

// 请求结构
type ChatRequest struct {
    Model       string    `json:"model"`
    Messages    []Message `json:"messages"`
    MaxTokens   int       `json:"max_tokens,omitempty"`
    Temperature float64   `json:"temperature,omitempty"`
    Stream      bool      `json:"stream"`
}

type Message struct {
    Role    string `json:"role"`
    Content string `json:"content"`
}

// 响应结构
type ChatResponse struct {
    ID      string   `json:"id"`
    Choices []Choice `json:"choices"`
    Usage   Usage    `json:"usage"`
}

type Choice struct {
    Index        int     `json:"index"`
    Message      Message `json:"message"`
    FinishReason string  `json:"finish_reason"`
}

type Usage struct {
    PromptTokens     int `json:"prompt_tokens"`
    CompletionTokens int `json:"completion_tokens"`
    TotalTokens      int `json:"total_tokens"`
}
```

### 客户端结构

```go
type DeepSeekClient struct {
    apiKey  string
    baseURL string
    model   string
}

func NewDeepSeekClient(apiKey, baseURL, model string) *DeepSeekClient {
    return &DeepSeekClient{
        apiKey:  apiKey,
        baseURL: baseURL,
        model:   model,
    }
}
```

支持配置不同的 `baseURL` 和 `model`，方便切换不同的服务商：

| 服务商 | baseURL | 模型名示例 |
|--------|---------|-----------|
| DeepSeek 官方 | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |

### Chat 方法实现

```go
func (c *DeepSeekClient) Chat(prompt string) (string, error) {
    // 1. 构造请求体
    chatReq := ChatRequest{
        Model: c.model,
        Messages: []Message{
            {Role: "user", Content: prompt},
        },
        MaxTokens:   1024,
        Temperature: 0.7,
        Stream:      false,
    }

    // 序列化为 JSON
    body, err := json.Marshal(chatReq)
    if err != nil {
        return "", fmt.Errorf("marshal request: %w", err)
    }

    // 2. 发送 HTTP 请求
    req, err := http.NewRequest("POST", c.baseURL+"/chat/completions", bytes.NewReader(body))
    if err != nil {
        return "", fmt.Errorf("create request: %w", err)
    }

    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Bearer "+c.apiKey)

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return "", fmt.Errorf("do request: %w", err)
    }
    defer resp.Body.Close()

    // 读取响应
    respBody, err := io.ReadAll(resp.Body)
    if err != nil {
        return "", fmt.Errorf("read response: %w", err)
    }

    // 检查状态码
    if resp.StatusCode != http.StatusOK {
        return "", fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(respBody))
    }

    // 3. 解析响应
    var chatResp ChatResponse
    if err := json.Unmarshal(respBody, &chatResp); err != nil {
        return "", fmt.Errorf("unmarshal response: %w", err)
    }

    if len(chatResp.Choices) == 0 {
        return "", fmt.Errorf("no choices in response")
    }

    return chatResp.Choices[0].Message.Content, nil
}
```

**代码流程**：

```
构造请求体 → JSON 序列化 → HTTP POST → 读取响应 → JSON 反序列化 → 提取内容
```

### 测试代码

```go
// cmd/llmtest/main.go
func main() {
    godotenv.Load()

    apiKey := os.Getenv("DEEPSEEK_API_KEY")
    baseURL := os.Getenv("DEEPSEEK_BASEURL")
    model := os.Getenv("DEEPSEEK_MODEL")

    if baseURL == "" {
        baseURL = "https://api.siliconflow.cn/v1"
    }
    if model == "" {
        model = "deepseek-ai/DeepSeek-V3"
    }

    client := llm.NewDeepSeekClient(apiKey, baseURL, model)

    resp, err := client.Chat("用一句话介绍一下 Go 语言")
    if err != nil {
        log.Fatal(err)
    }

    fmt.Println("Response:", resp)
}
```

### 运行结果

```bash
$ go run ./cmd/llmtest

Using baseURL: https://api.siliconflow.cn/v1, model: deepseek-ai/DeepSeek-V3
Response: Go 语言是一种由 Google 开发的静态强类型、编译型、并发型且具有垃圾回收功能的编程语言，以其简洁高效和强大的并发编程能力著称。
```

```

## 下一步

这个最小实现还缺少一些功能：

| 功能 | 说明 |
|------|------|
| System Prompt | 设定 AI 人设 |
| 多轮对话 | 保持上下文 |
| 流式输出 | 实时显示生成过程 |
| 超时控制 | 避免请求卡住 |
| 重试机制 | 处理临时失败 |

这些会在后续的 AI 工作流项目中逐步完善。

## 总结

调用 LLM API 本质上就是：

1. **构造 JSON 请求** - messages 数组，包含对话历史
2. **发送 HTTP POST** - 带上 Authorization header
3. **解析 JSON 响应** - 提取 choices[0].message.content

理解了 OpenAI 兼容格式，就能对接市面上大多数 LLM API。

## 相关链接

- [DeepSeek API 文档](https://platform.deepseek.com/docs)
- [硅基流动](https://cloud.siliconflow.cn)
- [OpenAI API 文档](https://platform.openai.com/docs/api-reference/chat)
