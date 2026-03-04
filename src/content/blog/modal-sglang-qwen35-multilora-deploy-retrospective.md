---
title: "Modal 部署 SGLang + Qwen3.5 多 LoRA：一次从跑不通到稳定推理的实战复盘"
description: "记录一次在 Modal 上部署 SGLang 推理服务（Qwen3.5 + 多 LoRA）的完整踩坑过程：模型配置修复、LoRA 参数格式、显存调优、超时与成本控制、Ghost Text 续写约束和平台接入策略。"
pubDate: "2026-03-04"
categories:
  - 技术
  - AI
  - MLOps
tags:
  - Modal
  - SGLang
  - Qwen
  - LoRA
  - 推理部署
  - 成本优化
  - Ghost Text
---

这篇文章是一次完整的部署复盘：目标是在 Modal 上稳定跑通 **SGLang + Qwen3.5 + 多 LoRA**，并满足业务侧 Ghost Text 续写需求。过程里踩了不少坑：模型配置字段缺失、LoRA 参数传错、显存不足、外网探针挂起、输出跑偏到思考链等。

最终结果是：

1. 推理核心链路已稳定（内部探针 200）
2. 成本可控（deploy → 单次 probe → stop）
3. 输出可约束（Ghost Text 格式 + 落盘）
4. 可接入现有平台（按 openai_compatible 统一配置）

---

## 背景与目标

目标很明确：

- 在 Modal 上部署一个可用的 SGLang 推理服务
- 基座模型为 Qwen3.5，加载多个 LoRA 适配器
- 满足 Ghost Text 场景：只返回可直接续写的正文，不要解释
- 测试和排障不能无限等待，必须有超时和强制退出
- 控制费用，避免 GPU 空转

当时采用的关键运行路径：

- `python -m modal deploy modal_sglang.py`
- `python -m modal app stop noir-sglang-multilora`
- `python -m modal app logs <app-id>`

---

## 核心坑位与修复

### 1) 模型缓存路径问题（`local_files_only` 失败）

现象：运行时找不到模型文件，报 `LocalEntryNotFoundError`。

根因：依赖 HF cache 的动态路径，在容器运行态并不稳定。

修复：改成固定目录 bake 到镜像内，运行态只读本地目录。

- 基座：`/models/base`
- LoRA：`/models/lora`

这一步是后续稳定性的基础。

### 2) 多 LoRA 参数格式错误

现象：SGLang 将 LoRA 名称误识别成 repo id，出现 404。

根因：`--lora-paths` 传参格式错误。

修复：改为 `name=path` 格式（而不是拆开的 token）。

### 3) Qwen3.5 配置字段缺失

现象：启动时缺 `num_hidden_layers` / `hidden_size` / `num_attention_heads`。

根因：Qwen3.5 部分字段在 `text_config` 下，而运行端期待顶层字段。

修复：启动前做 config patch：

- 将 `text_config` 关键字段提升到顶层
- 必要时从 `safetensors` 索引推断层数

### 4) 显存不足导致调度失败

现象：`Not enough memory ... mem_fraction_static=0.8`。

修复：

- `context_length` 从 `4096` 降到 `2048`
- `mem_fraction_static` 提升到 `0.9`

这组参数和训练时上下文长度一致，稳定性明显提升。

---

## 网络层与可用性：为什么要做内部探针

外部 `.modal.run` 路径在本次排障里出现过 `303`、`400 modal-http: bad redirect method` 和 pending 超时。为了避免“外网层问题”影响核心判断，增加了内部 loopback 探针：

- 先等 `/model_info` ready
- 再请求 `/v1/chat/completions`
- 请求成功后主动结束进程

这样可以把问题分层：

- 内部探针通过 → 模型与推理核心是好的
- 外部接口异常 → 重点看网关/重定向/调用方式

这个分层策略能显著减少盲目重试。

---

## 成本控制策略（非常关键）

实操中最有效的是“三段式”脚本化：

1. deploy
2. 单次 probe
3. stop app

并且给所有探针加双重超时：

- SDK timeout
- hard timeout（超时直接退出）

这样能避免“挂住 5 分钟以上还在等”的情况。对排障阶段尤其重要。

---

## Ghost Text 场景：提示词与输出约束

Ghost Text 续写任务的核心不是“模型会不会写”，而是“输出是否可直接拼接”。

最后采用的约束是：

- 只输出下一小段正文
- 20~80 字
- 保持人称和语气
- 不要解释、不分点、不加引号

同时对 Qwen 侧显式传递：

- `enable_thinking=false`
- `chat_template_kwargs: {"enable_thinking": false}`

这样可以最大程度减少思考链/解释性文本污染。

---

## 与现有平台接入：不新增 Modal Provider

接入策略最终定为：**不单独做 Modal provider**，直接走平台已有的 `openai_compatible`。

也就是只配三件事：

- `base_url`
- `api_key`
- `model`

好处：

1. 复用现有 provider 逻辑，减少维护面
2. 对开源部署友好，用户自己填 key
3. 不会把私有 token 写死在代码中

这也是后续多供应商切换的最低成本方案。

---

## 最终落地清单

本次实践后沉淀出的可复用清单：

- 固定模型路径，不依赖运行态 cache 猜测
- 多 LoRA 统一 `name=path`
- Qwen 配置做兼容补齐（`text_config` → 顶层）
- 先跑内部探针再看外部路由
- 所有请求必须有 hard timeout
- 脚本化 deploy/probe/stop，防 GPU 空转
- Ghost Text 强约束提示词 + 禁思考模式
- 输出统一落盘，便于对比和回归
- 平台接入走 openai_compatible，禁止硬编码私钥

---

## 常见报错速查表

| 报错/现象 | 常见根因 | 快速处理 |
|---|---|---|
| `LocalEntryNotFoundError`（`local_files_only=True`） | 运行时依赖 HF cache 动态路径，容器里找不到文件 | 模型与 LoRA 在构建期下载到固定目录（如 `/models/base`、`/models/lora`），运行时只读本地路径 |
| LoRA 名称被当成 repo id（404） | `--lora-paths` 参数格式错误 | 改为 `name=path`，不要拆成多个不成对 token |
| `num_hidden_layers` / `hidden_size` / `num_attention_heads` 缺失 | Qwen3.5 关键字段在 `text_config`，运行端读取顶层失败 | 启动前把 `text_config` 字段提升到顶层，必要时从权重索引推断缺失值 |
| `Not enough memory ... mem_fraction_static=0.8` | 上下文长度和显存占用不匹配 | `context_length` 降到 `2048`，`mem_fraction_static` 提到 `0.9`，并与训练设定保持一致 |
| 外部接口 `303` / `400 modal-http: bad redirect method` / 长时间 pending | 网关重定向或外部路由链问题 | 先用内部 loopback 探针验证核心链路，再单独排查外部入口 |
| 探针一直等待不返回 | 缺少硬超时，等待策略不收敛 | 同时设置 SDK timeout + hard timeout，超时直接退出并清理资源 |
| 输出变成“思考过程”而非正文 | 模型开启了 thinking 或模板未约束 | 在请求体显式加 `enable_thinking=false` 和 `chat_template_kwargs.enable_thinking=false`，并做响应净化 |
| Ghost Text 输出超字数/不符合格式 | 仅靠 prompt 约束不稳定 | 增加后处理门禁：长度校验（20~80）、格式校验，必要时重试/裁剪 |
| App 已部署但担心持续扣费 | 容器未缩到 0 或仍有请求触发 | 检查 active containers；排障阶段坚持 deploy→probe→stop，生产按请求负载调 `scaledown_window` |
| 开源后担心别人白嫖 API | 代码里存在默认私钥或 fallback key | 统一改为用户自配 `openai_compatible` 的 `base_url/api_key/model`，缺 key 直接 fail-fast |

---

## 一分钟自检命令清单

```bash
# 1) 部署
python -m modal deploy modal_sglang.py

# 2) 查看应用与状态
python -m modal app list --json

# 3) 查看日志（替换 app-id）
python -m modal app logs <app-id>

# 4) 运行一次内部探针（快速验证推理核心）
python -m modal run modal_sglang.py::probe_inside --prompt "Reply with exactly: OK"

# 5) 停止应用（排障阶段建议每轮都执行）
python -m modal app stop noir-sglang-multilora
```

建议排障时固定执行顺序：`deploy → probe → logs → stop`，避免 GPU 长时间空转。

---

## 参考链接

- https://modal.com/docs/examples/vllm_inference
- https://modal.com/docs/examples/basic_web

---

如果你也在做“微调模型在线推理 + 业务续写”的链路，这套方法最大的价值不在于某个参数，而在于：

- 把问题分层（模型层、网络层、业务层）
- 把运行流程脚本化（可重复、可中断、可回放）
- 把输出标准产品化（可验收、可对比、可回归）

这三点做好后，部署从“玄学”变成“工程”。
