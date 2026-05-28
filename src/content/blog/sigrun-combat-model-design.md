---
title: "Sigrun Combat Model 设计笔记：从可见局面到策略蒸馏"
description: "记录 Sigrun 项目的 CombatPolicyValueV1 模型设计，包括实体编码、policy/value 分支、value head 语义、rollout 与 AWBC 训练闭环。"
pubDate: "2026-05-28"
categories:
  - 技术
  - 项目
tags:
  - AI
  - Transformer
  - PyTorch
  - 强化学习
  - Sigrun
---

最近在做 Sigrun，一个面向《杀戮尖塔 2》DEFECT 战斗的模型项目。它的目标不是做完整跑图 bot，而是先把一个问题做扎实：

> 给定一个真实战斗局面和当前合法动作列表，模型应该选择哪个战斗动作？

这篇文章记录当前 `CombatPolicyValueV1` 的模型设计，主要方便以后自己复习。重点不是某个训练命令，而是这套架构为什么这么拆，以及 policy、value、rollout 之间各自承担什么职责。

## 总体架构

当前模型的输入是一个**非作弊的可见战斗局面**，再加上真实引擎给出的合法动作列表。输出分成两类：

- `policy logits`：给每个合法动作打分，用于运行时选动作。
- 多头 `V(s)`：估计当前局面继续打下去的结果，包括胜率、血量变化、资源变化和未来风险。

大致结构如下：

![Sigrun 战斗模型架构图](/image/sigrun-model-architecture.svg)

这里最重要的一点是：**policy head 负责动作选择，value heads 负责状态评估**。value head 不是直接给当前每个动作打分的 `Q(s,a)`，而是回答“从这个局面继续打下去大概会怎样”。

## 为什么不是一坨 flat vector

战斗局面不是普通表格数据。它里面有玩家、敌人、手牌、弃牌堆、遗物、药水、能力、orb、临时 modifier、行动历史等很多对象。直接把这些东西拍扁成一个大向量，很容易丢掉结构关系：

- 一张牌属于手牌还是弃牌堆；
- 一个 power 属于玩家还是敌人；
- 一个 enchantment 附着在哪张卡上；
- orb 的顺序和 evoke 位置；
- 某个动作的 target 是哪个敌人；
- 相同卡牌在不同位置是否真的是同一个运行时实例。

所以 Sigrun 先把战斗状态转成 typed entity tokens。常见实体包括：

| 实体 | 典型信息 |
|------|----------|
| player | HP、block、energy、orb slots、relic summary |
| card | 位置、当前费用、升级、可见 modifier、语义 embedding |
| enemy | HP、block、intent、power、boss/elite 标记 |
| orb | 类型、位置、passive/evoke 数值 |
| relic / potion / power | ID、runtime counter、owner、语义 embedding |
| combat context | ascension、act、floor、turn、版本分区 |
| memory | 可见行动历史和当前回合计数 |

这些实体既有明确的数值特征，也有来自卡牌/遗物/怪物文本的 frozen semantic embedding。这样做的好处是，模型既能看到“这张牌当前费用是多少”，也能通过 embedding 理解它大概是什么机制。

## Hierarchical Entity Encoder

实体很多，不能全部无脑丢进全局 Transformer。当前做法是一个分层实体编码器：

- action-addressable 的对象保留为全局 token，比如手牌、可用药水、敌人、orb；
- 局部附属对象先在 host 内部聚合，比如玩家 power、敌人 power、卡牌 modifier；
- 牌堆里的非当前可操作卡牌更偏向作为 zone summary 的局部组成，而不是每张都变成全局 token；
- relic set 会先形成一个整体摘要，再进入玩家状态。

可以把它理解成：模型先在局部关系里整理“谁属于谁”，再把真正需要全局推理的对象拿出来做注意力计算。

这对战斗模型很重要。比如 `Hologram`、弃牌堆、orb 顺序、敌人 intent，这些都不是孤立 scalar；它们的价值来自结构关系。分层编码的目标就是保留这些关系，同时控制全局 token 数量。

## Policy 和 Value 为什么拆开

`CombatPolicyValueV1` 不是一个共享大 trunk 后面接两个头，而是在共享实体投影和局部编码之后，拆成两个全局分支：

- policy trunk：当前是 8 层；
- value trunk：当前是 6 层；
- hidden size 是 384，attention heads 是 8；
- Transformer block 使用 RMSNorm + SwiGLU；
- memory 会进入 policy 和 value 两边。

拆开原因很实际：policy 和 value 的优化目标不同。

policy 要学的是“当前合法动作集合里哪个动作更应该选”。它强依赖 legal action list、action argument、target、mask，以及动作之间的相对偏好。

value 要学的是“当前局面继续下去结果怎样”。它更关心资源、HP、局面稳定性、敌人威胁、历史上下文，以及这个局面是否已经进入危险区域。

如果两者完全共享同一个全局 trunk，value 的学习可能干扰 policy，policy 的行为克隆信号也可能压制 value。拆开以后，两个分支共享底层实体表征，但有自己的全局推理容量。

## 多头 V(s) 的语义

当前 value heads 是多头 state value：

| head | 含义 | 训练方式 |
|------|------|----------|
| `p_clear` | 从当前局面继续后最终打赢的概率 | BCE with logits |
| `v_hp_delta` | 终局 HP 减当前帧 HP，按当前 max HP 归一化 | SmoothL1 / Huber |
| `v_resource_delta` | 资源变化，比如药水等 | SmoothL1 / Huber |
| `v_risk` | 低血、死亡或坏尾部风险 | 当前预留，暂不强训 |

这里最容易混淆的是 `v_hp_delta`。它不是“终局还剩多少血”，而是“从当前帧到终局的血量变化”。所以评测跨中间帧排序时，需要区分两件事：

```text
residual HP delta = v_hp_delta
terminal HP utility = frame_hp / frame_max_hp + v_hp_delta
```

前者看模型是否能预测后续还会掉多少血，后者才更接近“最终剩血更多的局面更好”。这也是后来修 value 评测口径时要单独报告 `terminal_hp_utility` 的原因。

## 为什么暂时不做 Q(s,a)

严格的 `Q(s,a)` 是：在局面 `s` 下强制先执行动作 `a`，之后按某个固定策略继续，最终结果的期望值。

它当然很有用，但当前不急着把它做成一个独立 head。原因是运行时直接选动作，本来就是 policy head 的任务。我们已经有更稳妥的动作级监督路径：

1. 选一个战斗局面 `s`；
2. 对多个候选合法动作 `a` 分别强制作为第一步；
3. 每个候选动作跑多次 terminal rollout；
4. 聚合胜率、HP、资源、死亡风险；
5. 把结果转成 soft policy target；
6. 训练 policy head。

这相当于用 action-conditioned rollout 产生近似 `Q(s,a)` 的信息，但最终把它蒸馏进 policy，而不是额外维护一个 Q head。

这么做更贴合当前目标：运行时要快、简单、稳定。模型只需要一次 forward，mask 掉非法动作，然后从 policy logits 里选动作。

## 训练闭环

当前训练路线可以分成几步。

第一步是 behavior cloning cold start。用真人 replay 和补齐的 opening/root action 数据训练一个能合法、像样出牌的初始 policy。当前主线 checkpoint 是 5,593 条 BC 数据训练出的 V1 prior。这个阶段 value labels 是 masked 的，所以它不是 bot strength 证据，只是让模型有一个可用起点。

第二步是冻结这个 policy，跑 rollout。rollout 过程中记录中间可见 combat frames、合法动作、策略版本、终局胜负、终局 HP 和资源变化。然后把 terminal outcome 回填成中间帧的 value label。

第三步是 action-conditioned rollout。对同一个局面，挑若干候选 first action，分别强制执行并继续 rollout。这样可以比较“同一局面下不同动作”的结果，再形成 soft policy target。这部分就是当前类似 AWBC 的 policy improvement 路径。

第四步是重训：policy 吃 BC 和 action-conditioned soft target，value 吃 terminal value labels。然后冻结新 policy，继续生成下一轮数据。

用一句话概括：

```text
BC 冷启动 -> 冻结 policy 产 rollout -> action-conditioned 比较候选动作 -> 蒸馏回 policy/value -> 下一轮
```

## 这套设计的边界

这套方案的上限主要不受模型结构限制，而受数据闭环质量限制。

第一是候选动作覆盖。`top-k + exploration` 很省算力，但会漏掉低先验高收益动作。后面需要周期性 full-scan 小样本，专门发现 policy 没意识到的好动作。

第二是 simulator 偏差。`sts2-rl-agent` 可以大幅提高 rollout 吞吐，但它必须作为 simulator-sourced partition 记录来源，并长期用真实引擎做 calibration。否则模型会把 simulator 的偏差学进去。

第三是版本迭代。新卡、新遗物、新 orb 规则、新 action payload 都可能改变 tensorization 或 simulator 行为。好消息是当前模型把 source policy、checkpoint、rollout backend、training-data source 都作为分区元数据保存；只要数据层和 catalog 层维护好，模型结构本身不需要频繁推倒重来。

## 当前结论

我现在对这套设计的理解是：

- policy head 是运行时动作选择器；
- 多头 `V(s)` 是状态评估器，不直接替代 policy；
- action-conditioned rollout 负责产生动作级改进信号；
- AWBC/soft target 把动作价值比较蒸馏进 policy；
- value head 更适合做局面诊断、训练辅助、搜索叶子评估和中间帧监督；
- RMSNorm + SwiGLU + policy/value decoupled trunks 是当前比较稳妥的工程形态。

所以 Sigrun 的 combat model 不是“一个会看牌的分类器”，也不是“运行时在线搜索器”。它更像一个持续自举的战斗策略模型：用行为克隆启动，用 rollout 发现更好的动作，用 policy 蒸馏保持运行时简单快速，用 value heads 维护对局面质量的理解。
