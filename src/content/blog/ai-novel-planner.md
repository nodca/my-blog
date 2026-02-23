---
title: "AI-Novel Planner：用对话式 AI 共创小说策划素材"
description: "为 AI 小说生成系统设计一个策划前端——通过 5 个对话模式引导用户与 AI 共创世界观、角色、大纲等素材，最终导出为生成引擎可直接消费的格式。"
pubDate: "2026-02-23"
categories:
  - 技术
  - 项目
tags:
  - Python
  - AI
  - LLM
  - Claude
  - React
  - Electron
---

上一篇文章介绍了 AI-Novel V2 的生成引擎——断言核查、POV 沙箱、Scene Contract 这些机制解决了"写"的一致性问题。但有个前置问题一直没解决：V2 需要的输入物（世界观设定、角色卡、章节细纲、风格指南）从哪来？

手写这些素材既枯燥又容易遗漏。让 AI 直接生成又太机械，缺乏作者的个人风格。所以我做了 AI-Novel Planner——一个对话式的策划工具，核心理念是**共创而非生成**。

## 为什么不直接让 AI 生成设定

试过。效果很差。

直接让 Claude "帮我生成一个玄幻世界观"，它会给你一个面面俱到但毫无个性的模板。修仙体系、五行元素、宗门等级……全是套路。因为 AI 没有你脑子里那个模糊但独特的画面。

更好的方式是：AI 问一个问题，你回答，AI 基于你的回答再追问，逐步把模糊的灵感变成清晰的设定。这个过程中，创意始终是你的，AI 只是帮你结构化和查漏补缺。

## 5 个对话模式

Planner 把策划过程拆成 5 个模式，每个模式有专门的 system prompt 和引导策略：

| 模式 | 做什么 | 关键机制 |
|------|--------|----------|
| 核心概念 | 从一句话灵感到完整概念 | 一次一个问题，发散 2-3 个方向让用户选 |
| 世界观构建 | 法则 → 势力 → 战力体系 | What-If 自洽性验证 + 经济底座追问 |
| 角色设计 | 动机 / 弱点 / 金手指 / 关系网 | 语C对话测试提取声音样本 |
| 大纲与细纲 | 全局弧线 → 卷级 → 章节 | 场景类型 + 情感曲线标注，对齐 V2 格式 |
| 风格提取 | 从参考作品提取风格特征 | 好例子/坏例子对比 + Show Don't Tell |

推荐按顺序走，因为每个阶段的成果会自动注入为下一阶段的上下文。比如在角色设计模式里，AI 能看到你之前定好的世界观设定，会基于战力体系来讨论角色的能力。

## 架构：Streaming + Tool Use 循环

技术栈复用了 V2 的模式：Electron + React + FastAPI + Claude API。

核心在 `chat_engine.py` 的 streaming + tool_use 循环：

```
用户发消息
  → 加载对话历史 + system prompt + 已有 artifact 注入
  → Claude streaming 响应
    → 流式输出文本给前端（SSE）
    → 如果 Claude 调用了 tool（如 write_artifact）：
        → 执行 tool，保存文件到磁盘
        → 将 tool result 返回给 Claude
        → Claude 继续生成（可能再调 tool）
    → 直到 Claude 结束回复
```

Claude 有 5 个工具可用：

- `write_artifact` — 创建/覆写素材文件
- `update_artifact` — 更新已有素材
- `read_artifact` — 读取素材内容（用于迭代更新时先读后改）
- `list_artifacts` — 列出当前项目所有素材
- `read_v2_data` — 读取关联 V2 项目的数据（角色、章节等）

关键设计：**AI 决定什么时候保存，但需要用户确认**。prompt 里有明确的触发规则——比如世界观模式要求至少通过一轮 What-If 验证后才能保存，角色模式要求核心三维度（动机/弱点/金手指）都明确后才能保存。

## 跨模式上下文注入

不同模式的对话是独立的，但策划素材是递进的。解决方案是在构建 system prompt 时，自动将当前项目的所有 artifact 注入到 prompt 末尾：

```python
def _build_system_prompt(self, project_id, mode):
    base = self.prompt_mgr.get_system_prompt(mode)
    artifacts = self.store.list_artifacts(project_id)
    # 按优先级排序：与当前模式相关的 artifact 优先完整注入
    # 其余 artifact 只注入标题 + 摘要
    # 总量上限 8000 tokens
```

每个模式的 YAML 配置里有 `artifact_priority` 字段，指定哪些类型的 artifact 优先注入。比如角色设计模式优先注入 setting 和 power_system。

## Prompt 工程的几个坑

### 伪保存问题

早期测试发现 Claude 有时会在文本里说"我已经帮你保存了"，但实际上没有调用 `write_artifact` 工具。解决方案是在 prompt 里用 `<artifact_rules>` 标签包裹保存规则，并加入强制指令：

```
<artifact_rules>
- 当用户说"定了"/"保存"时，你**必须在本轮回复中调用 write_artifact 工具**
- **严禁伪保存**：任何涉及"保存"的承诺都必须伴随实际的工具调用
</artifact_rules>
```

### 查户口式提问

角色设计模式最初会逐个追问"他几岁？""发色是什么？"，用户体验很差。解决方案是加入"智能补全规则"——AI 只聚焦角色灵魂（动机/弱点/关系/声音），外貌等标签在保存时自动补全。

### 迭代覆盖

策划是反复迭代的过程。如果每次都用 `write_artifact` 重写整个文件，之前的细节可能丢失。所以在所有 prompt 里加了迭代更新规则：先用 `read_artifact` 读取原有内容，合并更新而非粗暴重写。

## 对齐 V2 的细纲格式

这是 Planner 最关键的输出——章节细纲要能直接喂给 V2 的 precheck 阶段。V2 的 Scene Contract 需要 `scene_type`、`pov_goal`、`reader_emotion_target` 等字段，所以 Planner 的细纲模板里要求标注这些语义线索：

```markdown
## 第3章 暗流涌动
- 出场人物：林远、诺娃、马克
- 核心事件：林远发现矿洞中的异常符文
- 场景类型划分：场景1-日常互动(daily)，场景2-高压探索(action)
- 读者情绪目标：从轻松到紧张刺激
- 开头：林远和诺娃在营地整理装备
- 中间：进入矿洞后发现符文（林远的动机：弄清符文来源；意外阻碍：马克突然出现）
- 结尾：符文开始发光，洞口坍塌
- 伏笔：埋设"符文与影之天赋的关联"
- 禁止透露：马克的真实身份
- 预估字数：3000
```

V2 的 Sonnet 在 precheck 阶段读到这些信息后，能精准地转化为结构化的 Scene Contract JSON。

## 导出到 V2

点击"导出到 V2"后，Planner 会：

1. **纯文本素材**（设定、大纲、风格指南）→ 直接写入 V2 的 `docs/plans/` 和 `章节细纲/` 目录
2. **结构化数据**（角色卡、伏笔）→ Upsert 到 V2 的 `novel_state.db`

Upsert 时严格区分"Planner 管的字段"和"V2 运行时维护的字段"。比如角色的 `name`、`personality`、`background` 由 Planner 写入，但 `location`、`physical_state`、`mental_state` 这些运行时状态不碰。这样即使小说已经写了几十章，重新导入角色设定也不会破坏 V2 维护的角色状态。

## 总结

Planner 解决的核心问题：**把 AI 从"生成器"变成"共创伙伴"**。

几个设计原则：
1. **一次一个问题**：不要一股脑问用户十个问题，保持对话的自然节奏
2. **AI 提议，用户决定**：AI 可以发散方向、提出建议，但最终选择权在用户
3. **自洽性验证**：不只是记录用户说的话，还要主动用 What-If 测试设定是否自洽
4. **格式对齐下游**：策划阶段的输出格式要考虑生成引擎的消费需求

## 相关链接

- [AI-Novel Planner (GitHub)](https://github.com/nodca/AI-Novel-Planner)
- [AI-Novel V2 (GitHub)](https://github.com/nodca/AI-Novel)
- [Anthropic Claude API](https://docs.anthropic.com)
