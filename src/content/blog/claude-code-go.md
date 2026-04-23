---
title: "用Go复刻一个小型Claude Code: agent loop"
description: "记录复刻Claude Code的心得和学习体会"
pubDate: "2026-04-23"
categories:
  - 技术
  - Agent
  - 项目
tags:
  - Claude Code
  - Agent
  - Go
---
## 消息模型
在Claude Code中，消息Message可以被分成三类：1.Text纯文本 2.Tool Use工具调用  3.Tool Result工具调用结果。这三种都称为Block。

用结构体表示会更清晰，首先是最上层的Message:
```go
type Message struct {
	Role    string
	Content []Block
} 
```
Message有两个部分组成，Role用来区分用户消息（user）和LLM消息（assistant），Content就是上面提到的Block了。

消息的传递过程（首次对话）：1.用户发送Text，加入Message的Content中传给LLM 2.LLM响应（包括Text和Tool Use）整体进入消息历史，再从中找到Tool Use 3.串行执行tool的调用。执行完全部工具后将Tool Result作为一条user Message加入历史消息  4.重复执行2-3，直到没有发生tool use，将LLM响应的Text加入到Message，跳出这个循环。

后续用户发送消息，都要携带之前的Message。历史消息会长成：

```text
user(text)
assistant(text + tool_use...)
user(tool_result...)
assistant(text 或 text + tool_use...)
```

接下来看一下Block的结构体实现：
```go
type Block struct {
	Type      string
	Text      string         //纯文本block
	ID        string         //工具调用block
	Name      string         //工具调用block
	Input     map[string]any //工具调用block
	ToolUseID string         //工具结果block
	Result    string         //工具结果block
}
```

处理的时候，根据Type即可判断Block的类型。

## Agent结构体

只看Message和Block还不够，真正驱动整个流程的是Agent：

```go
type Agent struct {
	Msgs              []Message
	totalOutputTokens uint32
	totalInputTokens  uint32
	lastInputTokens   uint32
	callStreamFn      func(ctx context.Context) Response
	executeToolFn     func(name string, input map[string]any) string
}
```

这个结构体里有几块东西：

1.`Msgs`保存完整消息历史，后续每一轮请求都要带上它。

2.`totalInputTokens`和`totalOutputTokens`用来统计整个任务的token消耗，`lastInputTokens`记录最后一轮输入token。

3.`callStreamFn`和`executeToolFn`是两个扩展点。正常运行时会走真实的模型调用和工具执行，测试的时候可以替换成假的实现。

所以这个Agent本质上就是一个状态机：一边维护消息历史，一边不断驱动“模型推理 -> 工具执行 -> 再推理”这个循环。

## agent loop

核心逻辑在`chatAnthropic`里：

```go
func (a *Agent) chatAnthropic(ctx context.Context, userMsg string) {
	a.Msgs = append(a.Msgs, Message{Role: "user", Content: []Block{
		{Type: "text", Text: userMsg},
	}})

	for {
		response := a.callAnthropicStream(ctx)
		...
		a.Msgs = append(a.Msgs, Message{Role: "assistant", Content: response.Content})
		...
		a.Msgs = append(a.Msgs, Message{Role: "user", Content: toolResults})
	}
}
```

这段代码虽然不长，但已经把最小可用的agent loop跑起来了。执行过程可以拆成下面几步：

1.先把用户输入包装成一条`user`消息，放进历史记录。

2.调用模型，拿到一条assistant响应。这里的响应不一定只有文本，也可能同时带着多个`tool_use`。

3.把这整条assistant消息直接放进历史记录，而不是只提取出文本部分。

4.扫描`response.Content`，把其中的`tool_use`找出来。

5.如果这一轮没有`tool_use`，说明模型已经完成任务，循环结束。

6.如果有`tool_use`，就按顺序执行这些工具，把结果组装成`tool_result`。

7.最后把这些`tool_result`作为一条新的`user`消息再塞回历史记录，进入下一轮循环。

这就是为什么我觉得agent loop最核心的不是“调用一次LLM”，而是形成一个闭环：LLM先做推理，发现信息不够时调用工具，工具把结果返回回来，LLM再根据结果继续推理。

## 为什么tool result要放到user消息里

这个地方第一次看很容易有点别扭：工具明明是assistant发起调用的，为什么工具结果却要作为`user`消息塞回去？

原因其实很简单，因为对下一轮模型调用来说，工具结果本质上就是新的输入。

assistant这一轮说的是：“我想调用这个工具。”

工具执行完以后，外部系统要把结果喂回模型，相当于告诉它：“你刚才要的数据我给你拿到了，你继续想。”

所以历史消息会长成这样：

```text
user(text)
assistant(text + tool_use...)
user(tool_result...)
assistant(text 或 text + tool_use...)
```

这种组织方式有一个好处，就是消息历史会非常清楚。每一轮assistant做了什么决策、调用了什么工具、工具返回了什么结果，全部都能完整保留下来。

## token统计

每次拿到模型响应后，代码都会顺手统计一下token：

```go
a.totalInputTokens += response.Usage.InputTokens
a.totalOutputTokens += response.Usage.OutputTokens
a.lastInputTokens = response.Usage.InputTokens
```

这几个字段虽然简单，但很实用。

`totalInputTokens`和`totalOutputTokens`可以看整个任务累计花了多少token，后面如果要做成本统计或者上下文压缩，就会很有用。

`lastInputTokens`记录的是最后一次请求用了多少输入token，这个值可以帮助我们判断当前上下文是否已经越来越大，是否快要接近模型窗口上限。

现在这个版本只是先把统计做起来，后面如果要做更完整的上下文管理，这几个字段基本都能直接接着用。

## 优雅取消

agent loop通常不是一锤子买卖，它可能会连续跑很多轮，中间还会执行外部工具。所以取消能力很重要。

代码里一共做了两次`ctx.Done()`检查：

```go
for {
	select {
	case <-ctx.Done():
		return
	default:
	}
	...
	for _, tooluse := range tooluses {
		select {
		case <-ctx.Done():
			return
		default:
		}
		...
	}
}
```

第一次检查是在每一轮调用模型之前，第二次是在执行每个工具之前。

这样一来，如果用户中途取消任务，就不用等整轮全部跑完，可以在比较早的时机退出。虽然现在这个版本还没有做得特别细，比如没有处理中断中的流式输出，也没有给工具加超时，但最基本的取消链路已经有了。

## 为什么这样写比较好测

这个小实现还有一个我很喜欢的点，就是它天生比较容易测试。

因为`callStreamFn`和`executeToolFn`都可以被替换，所以测试时不需要真的去调用模型，也不需要真的去执行工具。只要构造几组假的Response，就可以把agent loop的核心路径跑一遍。

比如测试里就覆盖了三种情况：

1.模型直接返回文本，没有tool use，循环立刻结束。

2.模型先发起tool use，工具执行完成后再进入下一轮，最后正常结束。

3.context已经被取消，agent在真正调用模型之前就直接返回。

对这种带状态、带循环、还依赖外部系统的代码来说，可替换依赖非常重要。不然一写测试就会变得又重又脆。

## 这个版本还缺什么

到这里，一个最小可用的Claude Code风格agent其实已经出来了，但它还是一个很早期的版本，后面至少还有几个方向可以继续补：

1.权限系统。不是所有tool call都应该直接执行，有些操作应该先确认。

2.并发工具调用。现在多个tool use是串行执行的，实现简单，但速度不会太快。

3.真正的streaming。现在`callAnthropicStream`虽然名字里有stream，但抽象出来的还是完整Response，后面可以继续拆成事件流。

4.上下文压缩。消息历史会越来越长，迟早要处理。
