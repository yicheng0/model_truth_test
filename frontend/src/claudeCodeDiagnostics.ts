type ClaudeCodeDiagnosticProbe = {
  key?: string | null;
  title?: string | null;
  status?: string | null;
  severity?: string | null;
  labels?: string[] | null;
  reason?: string | null;
  error_detail?: string | null;
  evidence_excerpt?: string | null;
  detail?: string | null;
};

type LabelInfo = {
  text: string;
  description: string;
  priority: number;
};

const LABELS: Record<string, LabelInfo> = {
  suspected_cache: {
    text: '疑似缓存复用',
    description: '两次不同 nonce 请求返回了重复内容，可能存在缓存命中、请求复用或中间层回放。',
    priority: 100,
  },
  nonce_cross_talk: {
    text: 'nonce 串线',
    description: '某次请求返回了另一轮 nonce，说明请求上下文可能混线或复用了旧响应。',
    priority: 98,
  },
  nonce_mismatch: {
    text: 'nonce 不匹配',
    description: '模型没有按要求回显本轮 nonce，可能忽略 prompt、被代理改写或命中缓存。',
    priority: 96,
  },
  openai_shape_response: {
    text: 'OpenAI 响应形态',
    description: '返回体更像 Chat Completions，不像 Anthropic Messages 原生 message 结构。',
    priority: 94,
  },
  openai_protocol_fallback: {
    text: 'OpenAI 协议回退',
    description: '自动探测落到 OpenAI-compatible 协议，说明该中转可能不是原生 Claude Messages 链路。',
    priority: 92,
  },
  message_id_openai_family: {
    text: 'OpenAI ID 族',
    description: 'message id 呈现 chatcmpl 等 OpenAI 风格，和 Claude msg_ 家族不一致。',
    priority: 90,
  },
  stop_reason_openai_style: {
    text: 'OpenAI stop 风格',
    description: 'stop reason 更接近 OpenAI finish_reason，可能经过协议转换。',
    priority: 74,
  },
  model_name_mismatch: {
    text: '模型名不一致',
    description: '返回模型名和请求模型名不一致，可能被路由到其他模型或被中间层改写。',
    priority: 88,
  },
  tool_use_invalid: {
    text: '工具结构缺失',
    description: '要求工具调用时没有返回 Claude tool_use block，工具透传或模型能力可疑。',
    priority: 86,
  },
  tool_id_mismatch: {
    text: '工具 ID 异常',
    description: 'tool_use id 不符合 toolu_ 家族，可能是 OpenAI tool_calls 被转换或伪装。',
    priority: 84,
  },
  tool_name_mismatch: {
    text: '工具名不匹配',
    description: '返回的工具名不是探针要求的工具名，说明工具选择或透传异常。',
    priority: 82,
  },
  tool_input_mismatch: {
    text: '工具参数不匹配',
    description: '工具参数没有包含探针要求的字段和值，可能发生参数改写或模型未遵循 schema。',
    priority: 80,
  },
  tool_schema_invalid: {
    text: '工具 schema 异常',
    description: '工具参数没有通过 schema 校验，结构化调用能力不稳定。',
    priority: 78,
  },
  json_invalid: {
    text: 'JSON 非法',
    description: '要求严格 JSON 时返回了不可解析内容，可能是普通聊天模型或格式约束未生效。',
    priority: 76,
  },
  json_object_expected: {
    text: '非 JSON 对象',
    description: '要求 JSON 对象时返回了其他类型，结构化输出不符合预期。',
    priority: 75,
  },
  json_schema_invalid: {
    text: 'JSON schema 不符',
    description: 'JSON 可解析但字段类型、枚举或数组要求不符合探针约束。',
    priority: 74,
  },
  protocol_mismatch: {
    text: '协议结构不符',
    description: '响应结构偏离 Claude Messages API，协议可信度下降。',
    priority: 72,
  },
  streaming_event_missing: {
    text: 'SSE 事件缺失',
    description: '流式响应缺少 Anthropic message/content block/message stop 生命周期中的关键事件。',
    priority: 73,
  },
  streaming_event_order_mismatch: {
    text: 'SSE 顺序异常',
    description: '关键 SSE 事件存在，但首次出现顺序不符合 Anthropic 官方生命周期，可能经过协议转换或重组。',
    priority: 74,
  },
  usage_missing: {
    text: 'usage 缺失',
    description: '缺少 token usage 字段或字段族不对，可能是中间层裁剪或协议转换。',
    priority: 70,
  },
  message_id_family_mismatch: {
    text: 'Message ID 异常',
    description: 'message id 不属于预期 Claude 家族，可能不是原生 Claude 响应。',
    priority: 68,
  },
  thinking_signature_missing: {
    text: 'Signature 缺失',
    description: 'Thinking block 没有 signature，Claude Code thinking 链路可信度不足。',
    priority: 88,
  },
  signature_interop_failed: {
    text: 'Signature 链路不可验证',
    description: 'Relay 无法复用 source 生成的 thinking signature，说明 ClaudeCode/原生 thinking 链路不可验证；不应单独等同于非 Claude。',
    priority: 90,
  },
  thinking_adaptive_not_supported: {
    text: 'Adaptive thinking 异常',
    description: 'Adaptive thinking 协议探针未命中预期拒绝，疑似中间层改写、吞参或当前模型/渠道不支持 4.7/4.8 新协议。',
    priority: 66,
  },
  thinking_temperature_not_rejected: {
    text: 'Adaptive thinking 改写',
    description: 'Adaptive thinking/旧 temperature 冲突探针未命中预期拒绝，疑似中间层改写、吞参或非原生协议。',
    priority: 66,
  },
  thinking_adaptive_enabled_not_rejected: {
    text: 'Effort 探针异常',
    description: 'Adaptive thinking effort 探针未命中预期拒绝，疑似中间层改写、吞参或非原生 AWS/Claude 路径。',
    priority: 66,
  },
  thinking_adaptive_enabled_wrong_error: {
    text: 'Effort 错误异常',
    description: '上游返回了错误，但错误内容不是 adaptive thinking effort 目标参数的原生拒绝。',
    priority: 64,
  },
  request_failed: {
    text: '请求失败',
    description: '上游请求失败，需先确认 base URL、模型名、密钥、协议和该能力是否被支持。',
    priority: 64,
  },
  capability_not_supported: {
    text: '能力不支持',
    description: '该渠道不支持当前能力或字段组合，作为能力差异参考，不应单独判定为非 Claude。',
    priority: 42,
  },
  image_url_not_supported: {
    text: 'URL 图片不支持',
    description: 'URL 图片输入依赖渠道能力；Bedrock、Vertex 或部分中转通常只支持 base64 图片。',
    priority: 42,
  },
  document_block_not_supported: {
    text: 'Document block 不支持',
    description: 'document block 取决于渠道支持情况；文本内容读取已使用普通 text block fallback 验证。',
    priority: 42,
  },
  web_search_not_supported: {
    text: 'Web Search 不支持',
    description: '该渠道不支持 Anthropic server-side Web Search；作为能力参考跳过，不单独影响 Claude 判断。',
    priority: 42,
  },
  web_search_supported: {
    text: 'Web Search 已验证',
    description: '检测到 Anthropic server-side Web Search 调用、结果、引用或 usage 证据。',
    priority: 12,
  },
  web_search_tool_error: {
    text: 'Web Search 工具错误',
    description: 'Web Search 已被调用，但 server tool 返回了错误；需要结合错误码复核。',
    priority: 44,
  },
  web_search_not_available: {
    text: 'Web Search 当前不可用',
    description: '模型明确说明当前环境没有真实联网或搜索工具；作为能力参考跳过。',
    priority: 40,
  },
  web_search_evidence_missing: {
    text: 'Web Search 证据缺失',
    description: '响应没有包含 server-side Web Search block、引用或使用次数，无法证明真实联网。',
    priority: 46,
  },
  identity_uncertain: {
    text: '身份表述不明确',
    description: '模型只给出通用 AI 助手身份，未明确说明 Claude/Anthropic；仅作为弱信号。',
    priority: 20,
  },
  identity_mismatch: {
    text: '身份不一致',
    description: '模型明确自报为 OpenAI、ChatGPT、GPT、Gemini 等其他厂商或模型身份；仅作为低权重身份异常信号。',
    priority: 48,
  },
  multimodal_fallback_used: {
    text: '文本 fallback',
    description: '文档探针使用普通 text content block 传入 marker，避免 document block 兼容性导致误判。',
    priority: 18,
  },
  signature_not_supported: {
    text: 'Signature 不支持',
    description: '当前链路不支持或未透传 Thinking Signature，说明 ClaudeCode 链路不可验证。',
    priority: 46,
  },
  provider_error_variant: {
    text: '错误形态变体',
    description: '上游返回了同类拒绝，但错误文案和官方参考不完全一致，通常作为轻微代理痕迹处理。',
    priority: 30,
  },
  upstream_error_rewrapped: {
    text: '上游错误被重包',
    description: '候选网关没有保留 Anthropic 原生错误 envelope，可能破坏 Claude Code 按错误类型和文案执行的自动恢复。',
    priority: 72,
  },
  stream_buffered_by_gateway: {
    text: 'SSE 被网关缓冲',
    description: 'SSE 事件结构存在，但首事件几乎到总请求结束才到达，说明网关可能先聚合完整响应再转发。',
    priority: 68,
  },
  gateway_model_alias_capability_mismatch: {
    text: '模型 alias 能力错配',
    description: '网关模型 alias 的 adaptive thinking、effort 或工具能力与返回模型/官方基线不一致。',
    priority: 70,
  },
  latency_outlier: {
    text: '延迟异常',
    description: '请求延迟明显偏高，可能是中转链路、排队或上游不稳定。',
    priority: 22,
  },
  regex_keypoint_missing: {
    text: '关键点缺失',
    description: '输出没有命中探针要求的关键证据，可能未真正处理输入。',
    priority: 58,
  },
  required_keypoint_missing: {
    text: '必要内容缺失',
    description: '输出缺少必要关键词或关键结论，遵循度不足。',
    priority: 56,
  },
  exact_output_mismatch: {
    text: '精确输出不符',
    description: '要求精确回显时输出不一致，可能发生 prompt 忽略或中间层改写。',
    priority: 54,
  },
};

function infoFor(label: string): LabelInfo {
  if (label.startsWith('json_missing:')) {
    const field = label.split(':', 2)[1] || '-';
    return {
      text: `JSON 缺字段 ${field}`,
      description: `返回 JSON 缺少必填字段 ${field}。`,
      priority: 74,
    };
  }
  if (label.startsWith('missing:')) {
    const token = label.split(':').slice(1).join(':') || '-';
    return {
      text: `缺少 ${token}`,
      description: `输出未包含探针要求的关键内容：${token}。`,
      priority: 58,
    };
  }
  return LABELS[label] ?? { text: label, description: label, priority: 0 };
}

export function labelText(label: string): string {
  return infoFor(label).text;
}

export function labelDescription(label: string): string {
  return infoFor(label).description;
}

export function labelTooltip(label: string): string {
  const description = labelDescription(label);
  return description === label ? label : `${label}：${description}`;
}

export function topRiskLabels(probes: ClaudeCodeDiagnosticProbe[], limit = 6): string[] {
  const labels = new Map<string, number>();
  for (const probe of probes) {
    if (probe.status !== 'fail' && probe.status !== 'warning') continue;
    if (probe.severity === 'reference') continue;
    for (const label of probe.labels ?? []) {
      labels.set(label, Math.max(labels.get(label) ?? 0, infoFor(label).priority));
    }
  }
  return [...labels.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label]) => label);
}

export function probeDiagnosis(probe: ClaudeCodeDiagnosticProbe): string {
  const labels = probe.labels ?? [];
  if (probe.reason?.trim()) return probe.reason.trim();
  if (probe.error_detail?.trim()) return probe.error_detail.trim();
  if (probe.status === 'pass' && labels.length === 0) return '测试通过，未发现该项异常。';
  const evidence = `${probe.evidence_excerpt ?? ''}\n${probe.detail ?? ''}`.toLowerCase();
  if (evidence.includes('400') && /(temperature|top_p|top_k|budget_tokens|output_config|thinking|display|cache_control|image|document|web_search|web search|tool)/.test(evidence)) {
    return '上游返回 400，优先按 Opus 4.7/4.8+ 协议字段不兼容或中转网关字段改写问题处理。';
  }
  const primary = topRiskLabels([probe], 1)[0] ?? labels[0];
  if (primary) return labelDescription(primary);
  if (probe.evidence_excerpt) return probe.evidence_excerpt;
  if (probe.detail) return probe.detail;
  if (probe.status === 'queued') return '等待执行该探针。';
  if (probe.status === 'running') return '正在执行该探针。';
  return '暂无可解释标签，请结合原始证据继续判断。';
}
