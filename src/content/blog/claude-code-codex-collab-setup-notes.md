---
title: "Claude Code 接入 codex-collab：一次把 Codex 拉进协作流的实战记录"
description: "记录我把 codex-collab 装进 Claude Code 的过程，包括安装、默认配置、模型继承、无沙箱模式和常用命令。"
pubDate: "2026-03-15"
categories:
  - 技术
  - 项目
tags:
  - Claude Code
  - Codex
  - codex-collab
  - AI
  - Workflow
---

最近把 `codex-collab` 接进了 `Claude Code`，目标很直接：让 Claude 在同一条会话里把部分任务派给 Codex 去做，比如代码审查、并行研究、独立实现和二次验证。

这篇文章不写概念宣传，只记录一次真实可复现的配置过程，以及最终我保留下来的默认策略。

## 为什么最后选 codex-collab

我一开始对比过 `skill-codex` 和 `codex-collab`，最后选后者，核心原因有三点：

1. 它不是简单转发 prompt，而是直接走 Codex app server 的 JSON-RPC 协议。
2. 它有完整的 thread、resume、review、progress、output 这套会话管理能力。
3. 它对 `Claude Code skill` 这个使用场景更完整，适合长期放进日常工作流。

如果只是想偶尔从 Claude 里问一下 Codex，一个更轻量的 skill 也许够用；但如果目标是长期把 Codex 变成协作助手，`codex-collab` 更像“正经工具链”。

## 安装落点

我本地保留了一份源码仓库，路径在：

```bash
/home/wcn/桌面/sft-scripts-backup/vendor/codex-collab
```

实际安装给 `Claude Code` 识别的 skill 路径在：

```bash
~/.claude/skills/codex-collab
```

也就是说，平时真正被 Claude 调用的是 `~/.claude/skills/codex-collab` 下面的内容；源码仓库主要用于查看 README、做定制和后续升级。

## 这次配置里，哪些地方真的需要改

结论先说：

- `codex-collab` 本身通常不需要配置 API 地址和 API Key
- 这些底层能力应该配在 `Codex CLI` 自己的配置里
- `codex-collab` 更像一个“调度层”，主要决定默认的 `sandbox`、`approval`、`timeout`，以及是否显式覆盖模型参数

### 1. Codex 自己的模型与请求地址

我当前的 `Codex` 默认配置在：

```toml
~/.codex/config.toml
```

里面可以看到类似下面这些关键项：

```toml
model = "gpt-5.4"
model_reasoning_effort = "high"
base_url = "https://us.doro.lol/v1"
```

这里才是模型名、推理强度、请求地址真正生效的地方。

如果你还需要 API Key，一般也是按 `Codex CLI` 的方式配置，而不是写进 `codex-collab`。

### 2. codex-collab 自己的默认配置

`codex-collab` 的持久化配置文件在：

```bash
~/.codex-collab/config.json
```

我最后保留的是这份配置：

```json
{
  "approval": "never",
  "sandbox": "danger-full-access"
}
```

这代表两件事：

- `approval = never`：默认不做人机二次确认，走激进模式
- `sandbox = danger-full-access`：默认不给 Codex 套沙箱

这就是我前面说的“激进模式”。

## 模型到底跟随谁

这是我这次最关心，也专门改成自己想要行为的一点。

`codex-collab` 默认会继承 `Codex CLI` 的 `model + reasoning`，只有你显式配置了 `codex-collab config model ...` 或 `codex-collab config reasoning ...`，它才会覆盖。

也就是说，我现在这套默认行为是：

- `model` 跟随 `~/.codex/config.toml`
- `reasoning` 跟随 `~/.codex/config.toml`
- `sandbox` 和 `approval` 由 `~/.codex-collab/config.json` 单独控制

这套拆分我比较满意，因为职责很清楚：

- 模型相关，交给 Codex
- 调度风格，交给 codex-collab

## 如果只想简单测一下

最简单的一条命令是：

```bash
codex-collab run "这个项目是做什么的？" -s read-only --content-only
```

这条命令适合拿来验三件事：

1. `codex-collab` 命令本身能不能跑
2. `Codex CLI` 有没有正常启动
3. 当前目录能不能被 Codex 正确理解

如果只是做研究类任务，我通常会继续用只读模式：

```bash
codex-collab run "梳理一下这个仓库的路由、数据流和主要依赖" -s read-only --content-only
```

如果要直接让 Codex 动手改项目，我更常用默认配置，或者显式指定工作目录：

```bash
codex-collab run "给登录模块补上输入校验，并补一轮错误处理" -d /path/to/project --content-only
```

## 我觉得最常用的几条命令

### 1. 研究项目

```bash
codex-collab run "这个项目的核心模块有哪些？" -s read-only --content-only
```

### 2. 让 Codex 直接改代码

```bash
codex-collab run "实现一个最小可用版本，并补上验证步骤" --content-only
```

### 3. 代码审查

```bash
codex-collab review --mode uncommitted --content-only
```

### 4. 恢复上下文继续追问

```bash
codex-collab jobs
codex-collab run --resume <id> "继续修刚才那个问题" --content-only
```

### 5. 看最近进度

```bash
codex-collab progress <id>
```

这几条已经够覆盖我大部分“写项目”和“做研究”的场景了。

## 关于“会不会更省 token”

我的结论是：**不会神奇地让总 token 成本自动变低，但通常会让主会话更省脑子，也更省上下文压力。**

更准确地说：

- 如果把重任务派给 Codex，Claude 主线程里就不用反复塞长上下文
- 如果持续复用同一个 Codex thread，后续跟进也不需要每次从头讲
- 但从整套系统看，本质上还是把工作分流给了另一个模型，不是“白捡 token”

所以它更像“把 token 花在更合适的位置”，而不是“凭空省钱”。

## 两个容易踩的点

### 1. 想去掉沙箱，不是改 Claude Code，而是改 codex-collab 默认值

如果你要默认无沙箱，关键就是：

```json
{
  "sandbox": "danger-full-access"
}
```

或者每次命令显式加：

```bash
-s danger-full-access
```

### 2. 如果想让它重新跟随 Codex 的模型，不要在 codex-collab 里单独绑死 model

可以直接取消覆盖：

```bash
codex-collab config model --unset
codex-collab config reasoning --unset
```

这样它就会退回“继承 Codex 默认值”的状态。

## 最后保留的默认策略

这次折腾完，我最后保留的方案其实很简单：

- `Codex CLI` 负责模型、推理强度、请求地址、API
- `codex-collab` 只负责协作层默认值
- 默认 `approval = never`
- 默认 `sandbox = danger-full-access`
- 默认 `model + reasoning` 跟随 `Codex`

这样配置以后，Claude Code 里调用 Codex 的体验就稳定很多了。

后面如果我继续把它用于项目开发，我大概率会把它固定在两个场景里：

- 复杂项目里的并行研究
- 正式提交前的独立代码审查

这两类任务都很适合让另一个模型单开线程去做。
