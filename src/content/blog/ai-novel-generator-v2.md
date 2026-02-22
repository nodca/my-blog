---
title: "AI 网文生成器 V2：用 LightRAG + 断言核查解决上下文一致性"
description: "从零设计一套 AI 长篇小说生成系统，用 LightRAG 知识图谱 + 断言式事实核查 + POV 认知沙箱解决 AI 写长文时的角色遗忘和上帝视角问题。"
pubDate: "2026-02-22"
categories:
  - 技术
  - 项目
tags:
  - Python
  - AI
  - LLM
  - RAG
  - LightRAG
  - Claude
---

用 AI 写网文最大的痛点不是文笔，而是一致性。写到第 30 章，AI 会忘记第 10 章发生了什么；角色 A 不知道的秘密，AI 会让他脱口而出。这篇文章记录我从 V1 重构到 V2 的完整设计，核心目标就是解决这两个问题。

## V1 的问题

V1 是一个单文件脚本 `chapter_writer.py`，工作流很简单：选细纲文件 → 拼上下文 → 调 API → 输出正文。跑了 55 章（约 15 万字）后，暴露了几个严重问题：

| 问题 | 表现 |
|------|------|
| 角色遗忘 | 第 30 章忘了第 10 章建立的关系 |
| 上帝视角 | 角色说出自己不可能知道的信息 |
| 上下文过载 | 把所有角色状态塞进 prompt，重要信息被淹没 |
| 流程割裂 | 手动选文件、无预检、无校验 |

根本原因：V1 靠后处理提取摘要来维护状态，但摘要会丢失细节；没有"谁知道什么"的概念；没有生成前的矛盾检测。

## V2 架构

```
细纲文件
   ↓
Stage 0  解析细纲
   ↓
Stage 1  断言抽取 → 逐条核查 → 场景规划（Scene Contract）  [Sonnet]
   ↓
Stage 2  逐场景生成正文（POV 沙箱 + Token 预算）  [Opus]
   ↓
Stage 2.5  一致性校验 + 定向修复  [Sonnet]
   ↓
Stage 3  后处理：提取状态 → 写 DB → 索引 LightRAG → 保存文件
```

技术栈：Python + SQLite + LightRAG + Claude（Opus 写作 / Sonnet 分析）

## 双通道记忆：结构化 DB + LightRAG

单靠数据库存不住叙事细节，单靠 RAG 又没法精确查"某角色当前在哪"。所以用双通道：

```
┌──────────────────────┬──────────────────────────┐
│    SQLite（精确状态）  │   LightRAG（叙事检索）    │
├──────────────────────┼──────────────────────────┤
│ Character            │                          │
│ CharacterRelationship│   全部正文 + 设定文档      │
│ CharacterKnowledge   │   → 实体抽取 + 关系图谱   │
│ Foreshadow           │   → 向量索引 + 重排序     │
│ Summary              │                          │
│ KnowledgeTriple      │                          │
└──────────────────────┴──────────────────────────┘
```

**CharacterKnowledge** 是 V2 新增的核心表，记录"谁在第几章通过什么方式知道了什么"：

```python
class CharacterKnowledge(Base):
    character = Column(String, index=True)   # 角色名
    fact = Column(Text)                       # 事实内容
    source = Column(String)                   # witnessed / told / inferred
    learned_chapter = Column(Integer)         # 第几章获知
    confidence = Column(String)               # certain / suspect / guess
```

这张表直接决定了 POV 沙箱能注入什么、一致性校验能检测什么。

**LightRAG** 用 mix 模式（图谱遍历 + 社区摘要 + 向量检索），配合 bge-m3 嵌入和 bge-reranker-v2-m3 重排序。55 章索引完后，知识图谱有 ~700 个实体节点和 ~1200 条关系边。

## 断言式事实核查

这是 V2 最核心的改进。V1 的预检是把细纲整体丢给 LLM 让它"自己发现矛盾"，效果很差。V2 改成结构化的断言核查：

### Step 1：断言抽取

从细纲中提取 5-15 条可核对的原子命题：

```json
[
  {"statement": "诺娃第一次见到林远使用影之天赋", "type": "cognition",
   "related_characters": ["诺娃", "林远"], "search_query": "诺娃 林远 影之天赋"},
  {"statement": "矿洞中有三只石像守卫", "type": "fact",
   "related_characters": ["林远"], "search_query": "矿洞 石像守卫 数量"}
]
```

分两类：
- **认知类**：某角色知道/不知道/震惊于某事
- **事实类**：事件的时间、地点、参与者、结果等细节

### Step 2：逐条检索证据

每条断言单独查询，避免语义稀释：

```python
for i, assertion in enumerate(assertions):
    query = assertion.get("search_query", "")
    if query:
        result = rag_manager.query(query)  # 单条独立查询
        per_assertion_evidence[i] = result[:1500]
```

同时从 DB 拉取 CharacterKnowledge 作为结构化证据。两类证据合并后送给 Sonnet 逐条判定。

### Step 3：冲突分级

每条断言判定为 support / conflict / unknown：

- 认知类 conflict（"角色早已知道却写震惊"）→ **error**，默认拦截
- 事实类 conflict（细节不符）→ **warning** 或 **error**
- conflict 的断言生成事实锚点，注入 Scene Contract

### 事实锚点

冲突和已确认的断言都会变成结构化的事实锚点：

```json
{
  "key": "A3",
  "statement": "诺娃在第10章已目睹林远使用影之天赋",
  "expected": "诺娃不应表现出震惊",
  "severity": "error",
  "evidence": "第10章：林远在矿洞中使用影之天赋击退石像，诺娃在场"
}
```

`key` 是轻量临时标识（A0/A1/A2...），只在本章 pipeline 内使用，不入库不跨章。用于校验和定向修复时精确指向。

## POV 认知沙箱

写作时，只注入 POV 角色知道的信息：

```
【林远的认知沙箱】
确知的事实：
  - 克洛伊是库洛牌的守护者
  - 影牌可以操控影子
怀疑/隐约感觉（只能用暗示表达，不能确定性断言）：
  - 马克似乎在调查自己（来源：inferred，第25章）
```

规则：
- **certain**：可直接使用
- **suspect**：允许暗示（"总觉得哪里不对"），禁止确定性断言
- **guess**：仅允许模糊直觉
- **不在认知范围内**：禁止使用

其他角色的秘密永远不会进入 POV 角色的 prompt。

## Token 预算与三层裁剪

每个场景的 prompt 有 token 上限（默认 12000），按优先级分三层：

```
Must（不可裁剪）
  系统角色 + 风格指南 + 世界观 + Scene Contract + 事实锚点 + 角色状态 + 衔接备忘

Important（超限时裁剪）
  POV 认知沙箱 + 角色关系 + 伏笔指令 + 章节摘要

Nice（最先裁剪）
  LightRAG 检索结果 + 对话样本
```

```python
must_tokens = count_tokens_approx(must_text)
remaining = max_tokens - must_tokens
if imp_tokens <= remaining:
    remaining -= imp_tokens
    # Nice 层按剩余预算裁剪
    trimmed_nice = _trim_to_budget(nice_parts, remaining)
else:
    # Important 层也需要裁剪
    trimmed_imp = _trim_to_budget(important_parts, remaining)
```

## Scene Contract

每个场景有一份结构化合同，约束 Opus 的写作范围：

```json
{
  "scene_number": 1,
  "pov_character": "林远",
  "characters": ["林远", "艾伦", "莉娅"],
  "must_events": ["林远发现矿洞入口"],
  "forbidden_facts": ["克洛伊的真实身份"],
  "must_align_facts": [
    {"key": "A3", "statement": "...", "expected": "...", "severity": "error", "evidence": "..."}
  ],
  "required_foreshadows": {"plant": ["神秘符文"], "resolve": []},
  "tone_target": "紧张探索",
  "word_count": 800
}
```

## 一致性校验（Stage 2.5）

生成后跑 5 项检查：

| 检查项 | 方式 | 严重级别 |
|--------|------|----------|
| 合同履行 | 词法 + LLM 语义 | error/warning |
| 事实锚点 | LLM 逐条核对 | error/warning |
| 时间线 | 确定性时间标记检测 | warning |
| 地点连续性 | 确定性 DB 比对 | warning |
| 伏笔状态机 | 确定性状态检查 | error |
| POV 认知冲突 | LLM 分场景检查 | error/warning |

发现 error 时自动尝试定向修复一次（只改问题段落），仍失败则暂停等用户确认。

## Saga 式事务

后处理采用 Saga 模式保证数据一致性：

```
提取结构化数据 → 写 DB（单事务，失败回滚）
                    ↓
              索引 LightRAG（失败记录 pending，下次重试）
                    ↓
              保存章节文件 → 清理 pending
```

DB 写入是原子的，LightRAG 索引是最终一致的。

## 效果

这套方案解决了两类典型问题：

**场景1**：细纲写"主角展示天赋，队友震惊"，但第 10 章队友已经见过了。
→ 断言抽取提取出认知类断言 → CharacterKnowledge 查到"队友已知" → 判定 conflict/error → 拦截

**场景2**：细纲写"审问者问起矿洞里的三只石像"，但前文其实是两只。
→ 断言抽取提取出事实类断言 → LightRAG 检索到原文段落 → 判定 conflict/warning → 事实锚点注入 Scene Contract

## 总结

核心设计思路：

1. **双通道记忆**：结构化 DB 存精确状态，LightRAG 存全量叙事，互为补充
2. **断言式核查**：把细纲拆成原子命题逐条验证，而不是让 LLM 自己发现矛盾
3. **POV 沙箱**：从根源上阻止上帝视角，角色不知道的信息永远不进 prompt
4. **分层 Token 预算**：重要信息优先，不再一股脑全塞进去

## 相关链接

- [LightRAG - 图谱增强 RAG](https://github.com/HKUDS/LightRAG)
- [BGE-M3 嵌入模型](https://huggingface.co/BAAI/bge-m3)
- [硅基流动 API](https://cloud.siliconflow.cn)
- [Anthropic Claude API](https://docs.anthropic.com)
