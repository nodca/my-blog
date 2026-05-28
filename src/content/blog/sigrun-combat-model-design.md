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

从代码入口看，当前模型的几个关键常量基本把设计边界说清楚了：

```python
# packages/training/src/sts2_training/policy.py

COMBAT_POLICY_VALUE_V1_HEADS = (
    "p_clear",
    "v_hp_delta",
    "v_resource_delta",
    "v_risk",
)

CURRENT_ENTITY_ENCODER_KIND = "hierarchical_host_pooling"
CURRENT_TRANSFORMER_FFN_KIND = "swiglu"
CURRENT_TRANSFORMER_NORM_KIND = "rmsnorm"
```

`hierarchical_host_pooling` 说明模型不是把所有实体平铺处理；`swiglu` 和 `rmsnorm` 说明当前 checkpoint 已经是新结构，不再兼容早期 GELU/LayerNorm 的旧权重；四个 value head 则说明 value 分支不是一个单一分数，而是一组可解释的局面指标。

模型配置也很直接：

```python
@dataclass(frozen=True)
class CombatPolicyValueConfig:
    d_model: int = 384
    policy_layers: int = 8
    value_layers: int = 6
    heads: int = 8
    semantic_embedding_dim: int = 384
    dropout: float = 0.0
    memory_encoder_enabled: bool = False
    memory_layers: int = 1
    hp_delta_quantile_count: int = 32
    entity_encoder_kind: str = "hierarchical_host_pooling"
    local_layers: int = 2
    transformer_ffn_kind: str = "swiglu"
    transformer_norm_kind: str = "rmsnorm"
```

这里有两个值得注意的点：

1. `policy_layers` 和 `value_layers` 是分开的，这不是一个共享 trunk 后面接两个线性头的模型。
2. `hp_delta_quantile_count` 虽然已经在模型表面预留，但当前训练里并没有急着启用风险/分位数损失，这是为了避免早期 rollout 样本密度不够时把噪声当成尾部风险来学。

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

这里的“语义 embedding”不是运行时调用 LLM，而是离线把卡牌、遗物、怪物、能力等 catalog 文本编码成固定向量。运行时只查表，把 embedding 当作输入特征的一部分。这避免了两个问题：

- 推理时不能依赖外部 API；
- 模型不能只靠 card id 记忆，它还需要从语义相近的实体中泛化。

例如新版本里某张牌数值或描述发生变化，只要 catalog 和 embedding 跟着更新，模型输入仍然是同一类结构。真正要小心的是 tensorization schema 或动作 payload 变化，因为那会影响模型输入维度和动作匹配逻辑。

## Hierarchical Entity Encoder

实体很多，不能全部无脑丢进全局 Transformer。当前做法是一个分层实体编码器：

- action-addressable 的对象保留为全局 token，比如手牌、可用药水、敌人、orb；
- 局部附属对象先在 host 内部聚合，比如玩家 power、敌人 power、卡牌 modifier；
- 牌堆里的非当前可操作卡牌更偏向作为 zone summary 的局部组成，而不是每张都变成全局 token；
- relic set 会先形成一个整体摘要，再进入玩家状态。

可以把它理解成：模型先在局部关系里整理“谁属于谁”，再把真正需要全局推理的对象拿出来做注意力计算。

这对战斗模型很重要。比如 `Hologram`、弃牌堆、orb 顺序、敌人 intent，这些都不是孤立 scalar；它们的价值来自结构关系。分层编码的目标就是保留这些关系，同时控制全局 token 数量。

一个典型例子是卡牌。手牌里的卡是 action-addressable 的，因为合法动作可能直接引用它；弃牌堆里的卡通常不是当前动作参数，但它们会影响 `Hologram`、抽牌、回收等未来决策，所以更适合进入 zone summary。类似地，可用药水必须保留具体 slot，因为 `use_potion` 动作是按槽位执行的；玩家身上的 power 则可以先汇总进玩家表示。

这套分层设计本质上是在问一个问题：

> 这个实体现在是否会被动作直接引用，或者它的位置/顺序是否会立即影响动作价值？

如果答案是“是”，就尽量保留为全局 token；如果答案是“不是”，就先在局部宿主里聚合。

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

从代码看，`CombatPolicyValueV1` 的结构大概是这样：

```python
class CombatPolicyValueV1(nn.Module):
    def __init__(self, *, vocabulary, config=None):
        self.config = config or CombatPolicyValueConfig()
        self.value_head_names = COMBAT_POLICY_VALUE_V1_HEADS

        self.policy_model = TypedEntityActionPolicy(
            vocabulary=vocabulary,
            hidden_dim=self.config.d_model,
            attention_heads=self.config.heads,
            encoder_layers=self.config.policy_layers,
            entity_encoder_kind=self.config.entity_encoder_kind,
            local_layers=self.config.local_layers,
            transformer_ffn_kind=self.config.transformer_ffn_kind,
            transformer_norm_kind=self.config.transformer_norm_kind,
        )

        self.value_entity_encoder = nn.TransformerEncoder(
            _transformer_encoder_layer(
                d_model=self.config.d_model,
                nhead=self.config.heads,
                dropout=self.config.dropout,
            ),
            num_layers=self.config.value_layers,
        )

        self.value_state_query = nn.Parameter(
            torch.empty(1, 1, self.config.d_model)
        )
        self.value_state_attention = nn.MultiheadAttention(
            embed_dim=self.config.d_model,
            num_heads=self.config.heads,
            batch_first=True,
        )
        self.value_heads = nn.Sequential(
            nn.Linear(self.config.d_model, self.config.d_model),
            nn.GELU(),
            nn.LayerNorm(self.config.d_model),
            nn.Linear(self.config.d_model, len(self.value_head_names)),
        )
```

这里的 policy 分支用了 `TypedEntityActionPolicy`，因为它要面向 action list 做 scoring。value 分支则是另一个 Transformer encoder，加一个 learnable 的 `value_state_query` 去从实体表面里读出“当前局面状态”。这比简单 mean pooling 更灵活：模型可以自己学在估值时应该关注玩家资源、敌人威胁、orb 状态、遗物组合还是历史事件。

完整 forward 也能看出分支关系：

```python
def forward(self, batch):
    memory = self._memory_encoding(batch)
    surface = self.policy_model.entity_encoder_input_surface_from_batch(
        batch,
        context_embeddings=memory.context_embeddings,
        context_mask=memory.context_mask,
    )

    policy_surface = self.policy_model.encode_entity_input_surface(
        surface,
        encoder=self.policy_model.entity_encoder,
    )
    policy_state = self.policy_model._global_state(
        policy_surface.encoded_entities,
        policy_surface.entity_mask,
    )

    value_output = self._value_output_from_encoder_input(
        surface,
        memory_encoding=memory,
    )

    return CombatPolicyValueOutput(
        action_logits=self.policy_model.policy_batch_from_encoded_surface(
            batch,
            policy_surface,
            state=policy_state,
        ),
        value_estimate=value_output.value_estimate,
        value_head_names=self.value_head_names,
        hp_delta_quantiles=value_output.hp_delta_quantiles,
    )
```

实际实现里还有两个很实用的快捷入口：

```python
model.policy_logits(batch)  # 只跑策略分支
model.value_output(batch)   # 只跑价值分支
```

这对训练和评测都很重要。比如纯 value 评测不需要浪费显存去算 action logits；纯 soft-policy 训练也可以只跑 policy logits。

## RMSNorm 和 SwiGLU 放在哪里

这次模型结构升级里，Transformer block 换成了 RMSNorm + SwiGLU。核心代码很短：

```python
class _RMSNorm(nn.Module):
    def __init__(self, hidden_dim: int, *, eps: float = 1e-6):
        self.weight = nn.Parameter(torch.ones(hidden_dim))
        self.eps = eps

    def forward(self, x):
        scale = torch.rsqrt(x.pow(2).mean(dim=-1, keepdim=True) + self.eps)
        return x * scale * self.weight


class _SwiGLUFeedForward(nn.Module):
    def __init__(self, *, d_model: int, hidden_dim: int, dropout: float):
        self.gate_value = nn.Linear(d_model, hidden_dim * 2)
        self.dropout = nn.Dropout(dropout)
        self.output = nn.Linear(hidden_dim, d_model)

    def forward(self, x):
        value, gate = self.gate_value(x).chunk(2, dim=-1)
        activated = value * torch.nn.functional.silu(gate)
        return self.output(self.dropout(activated))
```

RMSNorm 去掉了 LayerNorm 的均值中心化，只保留按均方根缩放，计算更轻。SwiGLU 则把 FFN 拆成 value 和 gate 两半，用 `SiLU(gate)` 去调制 value。直觉上，它不是让每个 token 通过一个固定的 MLP，而是让模型自己学“哪些通道应该开大，哪些通道应该压下去”。

这里的隐藏维度会按 SwiGLU 常见做法调整到接近原来 4x GELU FFN 的参数/计算量，而不是直接把参数量翻倍。也就是说，它是一次结构升级，不是简单堆大模型。

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

训练代码里，value target 的定义也写得比较明确：

```python
VALUE_TARGET_TRANSFORMS = {
    "p_clear": {
        "transform": "identity",
        "range": [0.0, 1.0],
        "model_output": "raw_logit",
        "probability_interpretation": "sigmoid(value_estimate[p_clear])",
    },
    "v_hp_delta": {
        "transform": "state_relative_hp_delta",
        "formula": "(terminal_hp - frame_hp) / frame_max_hp",
        "raw_label_metadata_key": "raw_value_targets.v_hp_delta",
    },
    "v_resource_delta": {"transform": "identity"},
    "v_risk": {
        "transform": "identity",
        "range": [0.0, 1.0],
        "training_status": "masked_current_structural_iteration",
    },
}
```

损失函数也不是一锅端。`p_clear` 是概率，所以用 BCE with logits；连续值用 SmoothL1/Huber；缺失或当前不可靠的 head 用 mask 关掉：

```python
active = target_available.to(dtype=torch.bool) & (value_head_weights > 0)
active[:, VALUE_HEADS.index("v_risk")] = False

p_clear_logit = value_estimate[p_clear_active, p_clear_index]
per_head[p_clear_active, p_clear_index] = F.binary_cross_entropy_with_logits(
    p_clear_logit,
    p_clear_target,
    reduction="none",
)

for head_index, head in enumerate(VALUE_HEADS):
    if head == "p_clear":
        continue
    per_head[head_active, head_index] = F.smooth_l1_loss(
        value_estimate[head_active, head_index],
        value_target[head_active, head_index],
        reduction="none",
        beta=DEFAULT_VALUE_HUBER_BETA,
    )

weighted = per_head[active] * value_head_weights[active]
loss = weighted.sum() / value_head_weights[active].sum()
```

这段代码背后的原则是：value head 可以多，但每个 head 的标签可用性必须独立。不能因为某个样本有胜负结果，就假装它一定有可靠的资源变化、风险分位数或尾部标签。

评测侧现在也把 HP 口径拆开：

```python
def _terminal_hp_utility_target(row):
    if row.hp_base_norm is None or row.hp_delta_target_norm is None:
        return None
    return row.hp_base_norm + row.hp_delta_target_norm


def _terminal_hp_utility_predicted(row):
    if row.hp_base_norm is None or row.hp_delta_pred_norm is None:
        return None
    return row.hp_base_norm + row.hp_delta_pred_norm
```

也就是说，报告里应该同时看：

- `ranking.v_hp_delta`：模型是否能排对未来血量变化；
- `ranking.terminal_hp_utility`：模型是否能排对最终剩血局面；
- `ranking.composite_clear_hp`：`p_clear` 和 terminal HP utility 的综合排序。

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

动作级监督的核心不是 value head，而是 action-conditioned rollout 的聚合分数。当前训练/产数据实际使用的版本是 `clear_first_hp_tail_risk_v2`。代码里的权重和公式大致是这样：

```python
SCORING_FORMULA_VERSION = "clear_first_hp_tail_risk_v2"
DEFAULT_SCORING_WEIGHTS = {
    "p_clear": 1.0,
    "hp_value": 1.0,
    "death_rate": 2.0,
    "low_hp_shortfall": 1.0,
    "potion_cost": 0.1,
}


p_clear_term = p_clear * scoring_weight(scoring_weights, "p_clear")
hp_term = (p_clear**2) * hp * scoring_weight(scoring_weights, "hp_value")
death_penalty = death * scoring_weight(scoring_weights, "death_rate")
low_hp_tail_penalty = tail * scoring_weight(scoring_weights, "low_hp_shortfall")
potion_penalty = potion * scoring_weight(scoring_weights, "potion_cost")

score = (
    p_clear_term
    + hp_term
    - death_penalty
    - low_hp_tail_penalty
    - potion_penalty
)
```

`hp` 来自 `hp_value`，也就是 `terminal_hp / start_max_hp` 截断到 `[0, 1]`；缺少终局 HP 时不再用 HP delta 兜底生成 HP 价值。`tail` 是低血短缺项，默认低血阈值是 `0.25`。

如果只有单次 terminal outcome，`p_clear` 就是 win 的 `0/1`；如果是 action-conditioned 多次 rollout 聚合，`p_clear` 就是 win rate。训练侧还会把同一个公式算出的分数转成下一步动作 imitation 的权重：

```python
normalizer = rollout_score_positive_normalizer(DEFAULT_SCORING_WEIGHTS)
multiplier = max(0.0, min(1.0, score / normalizer if normalizer > 0 else 0.0))
weight = label_weight * multiplier
```

也就是说，负分或很差的 rollout 不会作为正向 imitation label 推动 policy；高分动作会通过 soft target 分布和样本权重共同影响训练。

这个公式有一个很重要的设计意图：胜率优先。HP 不是直接和胜率平起平坐，而是被 `p_clear^2` 调制。也就是说，只有当动作大概率能赢时，剩余 HP 才主要用于比较；如果一个动作容易死，它不会因为偶尔高 HP 结局而被误判成好动作。死亡、低血尾部和药水消耗也没有被塞进 HP 项里，而是作为独立惩罚进入分数。

把这个动作分数转成 soft policy target 后，policy head 学到的是“同一局面下哪些动作更值得选”。这比让 `V(s)` 去承担动作排序更干净，因为 `V(s)` 对同一帧所有候选动作本来就是同一个输入。

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

更展开一点，当前闭环里有几类数据要严格分清：

| 数据 | 用途 | 注意点 |
|------|------|--------|
| 人类 replay / opening | BC 冷启动 | 只说明“像人类且合法”，不是最终强度 |
| terminal rollout frames | value label | 回填到中间帧，训练 `V(s)` |
| action-conditioned rollout | soft policy target | 同一状态比较多个候选动作 |
| simulator-sourced rows | 加速数据来源 | 必须记录 backend/source partition |
| real-engine calibration | 校准和验真 | 不能用 fake engine 当 readiness 证据 |

我现在倾向把这个系统看成一种“离线策略迭代蒸馏”：

1. policy 提供一个可运行的 continuation policy；
2. rollout 评估它在大量局面里的结果；
3. action-conditioned rollout 在局部状态上做动作比较；
4. 比较结果被压缩成 policy soft target；
5. 新 policy 继承旧 policy 的覆盖，又向 rollout 发现的好动作靠拢。

这个过程和纯强化学习不完全一样。它没有在线环境里边打边更新，也没有把 `Q(s,a)` 当主训练对象；更像是每一轮冻结策略，离线生产一批更好的监督信号，再训练一个新策略。

## 推理路径应该保持简单

运行时推理不应该带搜索。当前最合理的 runtime path 是：

```text
CanonicalObservation + legal actions
  -> tensorize
  -> CombatPolicyValueV1.forward 或 policy_logits
  -> mask illegal actions
  -> argmax / configured sampling
  -> execute exactly one action
  -> observe next combat decision
```

value heads 在运行时仍然有意义，但它们更适合做诊断和安全监控：

- `p_clear` 异常低时，记录该局面进入高风险样本池；
- `terminal_hp_utility` 和 policy confidence 背离时，优先安排 action-conditioned full scan；
- `v_risk` 以后启用后，可以找出“胜率看起来还行但尾部很差”的局面；
- 搜索或轻量 lookahead 如果重新引入，可以把 value 当 leaf evaluator。

但当前不要让 value 直接覆盖 policy 选动作。否则等于把 state value 误用成 action value，容易在同一帧候选动作比较上产生伪精度。

## 这套设计的边界

这套方案的上限主要不受模型结构限制，而受数据闭环质量限制。

第一是候选动作覆盖。`top-k + exploration` 很省算力，但会漏掉低先验高收益动作。后面需要周期性 full-scan 小样本，专门发现 policy 没意识到的好动作。

第二是 simulator 偏差。`sts2-rl-agent` 可以大幅提高 rollout 吞吐，但它必须作为 simulator-sourced partition 记录来源，并长期用真实引擎做 calibration。否则模型会把 simulator 的偏差学进去。

第三是版本迭代。新卡、新遗物、新 orb 规则、新 action payload 都可能改变 tensorization 或 simulator 行为。好消息是当前模型把 source policy、checkpoint、rollout backend、training-data source 都作为分区元数据保存；只要数据层和 catalog 层维护好，模型结构本身不需要频繁推倒重来。

我觉得这套方案的上限大致取决于三个变量：

1. **rollout 后端是否可信**：如果 simulator 和真实引擎偏差大，模型会学到错误物理规则。
2. **候选动作是否覆盖关键分叉**：如果好动作从未被 rollout，就不可能被蒸馏进 policy。
3. **版本分区是否清楚**：如果不同 checkpoint、不同 simulator commit、不同游戏版本的数据混在一起，value label 的语义会变脏。

模型结构本身不是短板。`CombatPolicyValueV1` 已经有 typed entity、hierarchical pooling、memory、decoupled trunks、RMSNorm/SwiGLU 和多头 value surface。继续堆结构前，更值得优先做的是数据覆盖、评测口径和 simulator calibration。

## 我会继续关注的几个指标

后续每轮重训，我会重点看这些指标，而不是只看 validation loss：

| 指标 | 为什么重要 |
|------|------------|
| policy top-1 / top-3 | BC 阶段是否仍保留合法且像样的基础行为 |
| action-conditioned soft loss | rollout 发现的动作偏好是否被 policy 吃进去 |
| `p_clear` ranking | 胜负排序是否真正改善 |
| `terminal_hp_utility` ranking | HP 质量排序是否改善 |
| simulator blocked rate | 数据生成是否被机制缺口卡住 |
| duplicate trajectory rate | rollout 是否退化成重复样本 |
| candidate miss full-scan rate | top-k 是否漏掉高价值动作 |

这里尤其要注意 `v_hp_delta` 和 `terminal_hp_utility` 的区别。旧报告里出现过 `p_clear` 排序明显改善，但 HP delta 排序略降、composite 几乎不动的现象。现在评测口径拆开后，才能判断到底是模型没学到，还是原来的 composite 把跨中间帧的当前 HP 基线漏掉了。

## 当前结论

我现在对这套设计的理解是：

- policy head 是运行时动作选择器；
- 多头 `V(s)` 是状态评估器，不直接替代 policy；
- action-conditioned rollout 负责产生动作级改进信号；
- AWBC/soft target 把动作价值比较蒸馏进 policy；
- value head 更适合做局面诊断、训练辅助、搜索叶子评估和中间帧监督；
- RMSNorm + SwiGLU + policy/value decoupled trunks 是当前比较稳妥的工程形态。

所以 Sigrun 的 combat model 不是“一个会看牌的分类器”，也不是“运行时在线搜索器”。它更像一个持续自举的战斗策略模型：用行为克隆启动，用 rollout 发现更好的动作，用 policy 蒸馏保持运行时简单快速，用 value heads 维护对局面质量的理解。
