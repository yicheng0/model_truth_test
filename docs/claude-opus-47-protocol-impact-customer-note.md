# Claude Opus 4.7/4.8+ 协议变化对检测结果的影响说明

日期：2026-06-22  
适用对象：Claude 资源指纹检测、ClaudeCode / Thinking Signature 链路检测、第三方 Claude 中转资源验证

## 1. 结论摘要

本次检测中出现的部分失败项，并不是因为检测平台新增的结果字段造成的。

检测平台近期新增的字段，例如：

- `classification_status`
- `classification_label`
- `classification_reason`
- `capability_flags`
- `claude_score`
- `claude_code_score`

这些字段只用于检测结果展示和分类汇总，不会被发送给上游 Claude 服务，因此不会导致上游返回 `400 Bad Request`。

当前更可能的原因是：**Claude Opus 4.7/4.8+ 的 thinking / output_config / signature 协议相较旧版本发生变化，而部分检测探针或中转网关仍按旧协议行为判断，导致误报或上游拒绝。**

因此，部分失败项应理解为“协议适配差异”或“链路能力不支持”，不能简单等同于“该资源不是 Claude”。

## 2. 受影响的关键字段

Claude Opus 4.7/4.8+ 对 thinking 相关请求字段有明显变化，重点如下。

| 字段 | 旧版本常见行为 | Opus 4.7/4.8+ 期望行为 | 可能影响 |
|---|---|---|---|
| `thinking.type` | `enabled` 或 `adaptive` | 更偏向 `adaptive` | 继续发送 `enabled` 可能触发 400 |
| `thinking.budget_tokens` | extended thinking 常用 | 4.7/4.8+ 场景下通常不再按旧方式发送 | 旧探针可能被上游拒绝 |
| `thinking.display` | 旧版本不存在 | 新增，例如 `summarized` / `omitted` | 非法值探针的错误文案可能变化 |
| `output_config.effort` | 部分 4.6 effort 后缀使用 | 4.7/4.8+ effort 后缀模型更依赖该字段 | 网关改写不一致会导致异常 |
| `temperature` / `top_p` / `top_k` | 旧 thinking 场景可能保留或改写 | 4.7/4.8+ thinking 场景通常应省略 | 未清理可能触发 400 |
| `content[].signature` | Claude 原生 thinking 签名 | 原生 `/v1/messages` 透传才可保留 | OpenAI 兼容转换路径会丢失 |

## 3. 为什么会出现检测失败

### 3.1 Thinking 相关探针失败

如果检测请求仍使用旧式：

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 1024
  }
}
```

而上游实际是 Claude Opus 4.7/4.8+，则上游可能直接返回 `400 Bad Request`。

这类失败通常说明：

- 请求字段与 Opus 4.7/4.8+ 新协议不兼容；或
- 中转网关没有完成对应改写；或
- 检测探针仍按旧协议预期判断。

它不能单独证明资源不是 Claude。

### 3.2 Signature 检测失败

Thinking Signature 能否通过，强依赖链路是否保留 Claude 原生响应结构。

如果走的是原生 `/v1/messages`，Claude 返回的 thinking block 中可能包含：

```json
{
  "type": "thinking",
  "thinking": "...",
  "signature": "..."
}
```

但如果经过 `/v1/chat/completions` 或 OpenAI-compatible 转换路径，`signature` 往往会丢失，只剩类似 `reasoning_content` 的字段。

因此，Signature 失败通常说明：

- 当前链路不是完整 Claude 原生透传；或
- 中转做了 OpenAI 格式转换；或
- 该渠道不支持 ClaudeCode / Thinking Signature 互通能力。

这也不能直接等同于“不是 Claude”，只能说明“ClaudeCode / Thinking Signature 链路能力不足或不可验证”。

### 3.3 多模态检测失败

图片、文档等多模态能力取决于渠道是否支持对应 content block。

部分 Claude-compatible 资源可能只支持文本请求，不支持：

- image base64
- image URL
- document text block

因此，多模态失败应作为能力参考，不应直接作为“非 Claude”的判定依据。

## 4. 本平台当前处理方式

为避免误判，检测平台已将判断拆分为两层：

1. **Claude 基础资源判断**
   - 关注响应结构、message id、usage、stop reason、tool_use、基础协议行为等。
   - 用于判断该资源是否符合 Claude / Claude-compatible 特征。

2. **ClaudeCode / Thinking Signature 链路判断**
   - 关注 thinking signature、signature 互通、ClaudeCode 专项参数等。
   - 用于判断是否具备 ClaudeCode 风格的原生链路能力。

同时，多模态和 Web Search 会作为能力参考，不再直接拉低 Claude 基础判断。

也就是说：

- 普通 Claude 资源可以通过 Claude 基础判断；
- 即使它不支持 Signature 或多模态，也不会直接被判为非 Claude；
- Signature 不支持会显示为 ClaudeCode 链路能力不足，而不是直接判定资源异常。

## 5. 建议客户验证方式

如果客户希望验证 Claude Opus 4.7/4.8+ 资源是否为更完整的 Claude 原生链路，建议使用以下配置：

| 项目 | 建议 |
|---|---|
| Endpoint | 优先使用 `/v1/messages` |
| 避免路径 | 尽量避免 `/v1/chat/completions` 做 Signature 验证 |
| 模型名 | 使用裸模型名或明确适配 4.7/4.8+ 后缀规则 |
| Thinking | 按 4.7/4.8+ 要求使用 `adaptive` / `output_config.effort` |
| Stream | Signature 验证建议开启流式，观察 `signature_delta` |
| 中转设置 | 如有 pass-through 模式，建议开启以减少字段改写 |

推荐验证路径：

```text
POST /v1/messages
model: claude-opus-4-7 或 claude-opus-4-7-high
stream: true
协议：Claude 原生 Messages API
```

不建议用 OpenAI-compatible 响应来验证 Thinking Signature，因为转换过程可能天然丢失 signature 字段。

## 6. 对检测结果的解释口径

建议对外解释为：

> 本次部分失败项主要与 Claude Opus 4.7/4.8+ thinking 协议变化、网关字段改写、以及 OpenAI-compatible 转换路径丢失 signature 有关。新增的检测结果字段不会发送给上游，不会导致 400 错误。当前检测平台已区分 Claude 基础资源判断和 ClaudeCode / Thinking Signature 链路判断，以避免把“专项能力不支持”误判为“非 Claude”。

## 7. 最终结论

本次问题的核心不是检测平台新增展示字段导致的，而是 Claude Opus 4.7/4.8+ 协议变化和不同中转链路行为差异共同造成的。

可以确认：

- 新增的分类字段不会影响上游请求。
- `thinking.type`、`thinking.display`、`output_config.effort`、`temperature`、`top_p`、`signature` 等协议字段变化，确实可能导致旧探针失败或 400。
- Signature 失败更多说明 ClaudeCode / 原生 thinking 链路不可验证，不等于资源一定不是 Claude。
- 多模态失败应作为能力参考，不应直接作为 Claude 真伪判断依据。

后续检测应继续采用“双层判断”：

1. 先判断是否 Claude / Claude-compatible；
2. 再判断是否支持 ClaudeCode / Thinking Signature 原生链路。
