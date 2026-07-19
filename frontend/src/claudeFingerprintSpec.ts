export type ClaudeEvidenceTier = {
  key: 'provenance' | 'continuity' | 'protocol' | 'behavior';
  title: string;
  weight: '最高' | '高' | '中' | '低';
  signals: string;
  caveat: string;
};

export type ClaudeChannelDifference = {
  key: 'anthropic_direct' | 'official_cloud' | 'gateway_or_reverse' | 'non_claude';
  title: string;
  expected: string;
  redFlags: string;
  conclusion: string;
};

export type ClaudeAccessPath = {
  key: 'anthropic_endpoint_configured' | 'claude_code_gateway_like' | 'translated_gateway' | 'transparent_unresolved';
  title: string;
  description: string;
  evidence: string;
};

export type UpstreamIntegrityClassification =
  | 'signature_chain_verified'
  | 'mixed_routing_suspected'
  | 'protocol_reconstruction_suspected'
  | 'model_swap_suspected'
  | 'insufficient_evidence'
  | 'operationally_inconclusive';

export const CLAUDE_RESOURCE_IDENTITY_META: Record<string, { label: string; color: string; description: string }> = {
  anthropic_api_key_configured: { label: 'Anthropic API Key 已配置', color: 'green', description: '调用方把 API Key 发送到 api.anthropic.com；仍需账单或 request-id 回查确认账号归属。' },
  gateway_credential_configured: { label: '网关凭据已配置', color: 'purple', description: '自定义网关接受凭据；远端是 API Key、OAuth、云凭据还是代理仍未解析。' },
  cloud_provider_credentials: { label: '云提供商凭据已配置', color: 'blue', description: '调用方配置指向云提供商；具体模型和账号来源需云审计确认。' },
  claude_code_oauth_confirmed: { label: '本机 Claude Code OAuth 已确认', color: 'green', description: '仅表示本机 CLI auth status 的登录状态，不代表远程渠道使用该 OAuth。' },
  insufficient_evidence: { label: '资源来源证据不足', color: 'default', description: '响应和网关兼容证据不能独立确认 Claude Code OAuth 或 API 账号来源。' },
};

export const UPSTREAM_INTEGRITY_META: Record<UpstreamIntegrityClassification, { label: string; color: string; description: string }> = {
  signature_chain_verified: { label: 'Signature 链路已验证', color: 'green', description: '双向 signature 与篡改对照通过；证明 Claude signature 链路，不等于官方直连。' },
  mixed_routing_suspected: { label: '疑似混合路由', color: 'red', description: '重复采样出现关联硬协议特征切换或 signature 验证间歇变化。' },
  protocol_reconstruction_suspected: { label: '疑似协议重建', color: 'orange', description: '多个独立参数、错误或 SSE 边界持续偏离官方基线。' },
  model_swap_suspected: { label: '疑似换模或严重降级', color: 'red', description: 'Signature 不可验证，并伴随至少两类独立硬异常。' },
  insufficient_evidence: { label: '证据不足', color: 'default', description: '缺少可比官方基线、模型不兼容或仅有网关兼容证据。' },
  operationally_inconclusive: { label: '运营异常，无法判定', color: 'gold', description: '本轮仅获得认证、配额、限流、超时或服务端错误。' },
};

export const CLAUDE_EVIDENCE_TIERS: ClaudeEvidenceTier[] = [
  {
    key: 'provenance',
    title: 'L1 来源与控制面',
    weight: '最高',
    signals: '官方域名/云资源、账号账单、IAM/CloudTrail/Azure Monitor、TLS 与组织侧 request id 可回查。',
    caveat: '只有资源所有者或云审计能证明来源；第三方 URL 即使完全兼容，也不能靠响应字段证明官方直连。',
  },
  {
    key: 'continuity',
    title: 'L2 跨请求密码学连续性',
    weight: '高',
    signals: 'Thinking signature 原样回传、跨轮工具调用连续性、被篡改 thinking block 的原生拒绝。',
    caveat: '更能发现协议转换和中间层丢字段，但官方云或能力裁剪链路也可能不支持，失败不能单独判非 Claude。',
  },
  {
    key: 'protocol',
    title: 'L3 原生协议一致性',
    weight: '中',
    signals: 'message/usage/stop reason、msg_/toolu_、SSE 生命周期、参数边界与错误 schema。',
    caveat: '这些字段和错误文本都可仿造；只能证明 Claude-compatible 程度，不能单独证明官方来源。',
  },
  {
    key: 'behavior',
    title: 'L4 行为与自报',
    weight: '低',
    signals: '身份回答、风格、安全边界、能力题、低温重复性和延迟分布。',
    caveat: '受系统提示、模型版本、路由和采样影响最大，只能与前三层联合使用。',
  },
];

export const CLAUDE_CHANNEL_DIFFERENCES: ClaudeChannelDifference[] = [
  {
    key: 'anthropic_direct',
    title: 'Anthropic 官方直连',
    expected: 'api.anthropic.com Messages API；Anthropic request-id 可追踪；原生 message、SSE、tool_use、thinking 与 server tools。',
    redFlags: '官方域名却返回 OpenAI shape、缺少关键协议字段、模型名被静默替换，或组织侧无法回查 request id。',
    conclusion: '来源证据和协议证据同时成立时，才可称官方直连。',
  },
  {
    key: 'official_cloud',
    title: 'Bedrock / Foundry / Vertex 官方云',
    expected: '认证、endpoint、模型 ID、request id 和流式封装存在合法差异；应落在官方云参考带，而非逐字段复制 Anthropic 直连。',
    redFlags: '声称某云渠道却没有相应云资源、认证/审计痕迹，或响应长期落在另一协议族。',
    conclusion: '可判为官方云参考渠道，不应要求与 Anthropic 直连完全相同。',
  },
  {
    key: 'gateway_or_reverse',
    title: 'LLM Gateway / 逆向 / 中转',
    expected: '自定义 Base URL 合法存在，可能保留或转换 Messages API；常见 header 裁剪、错误文案变化、模型别名改写和能力缺失。',
    redFlags: '跨轮 signature 丢失、参数被吞、SSE 重组、OpenAI fallback、nonce 串线、缓存回放或模型名不一致。',
    conclusion: '通过只能说明 Claude-compatible 或官转高一致性，不能证明官方直连；异常组合才提高疑似改写/换模风险。',
  },
  {
    key: 'non_claude',
    title: '非 Claude 或模型替换',
    expected: '可能自报 Claude，也可能伪造 msg_/toolu_，但多层协议边界、工具、上下文、能力和重复性通常难以长期同时贴合参考带。',
    redFlags: 'OpenAI/Gemini shape、硬参数不执行、能力持续低于官方带、跨请求串线，以及明确泄露其他模型身份。',
    conclusion: '需要多项独立异常和重复采样后，才使用“疑似换模”或“likely non-Claude”口径。',
  },
];

export const CLAUDE_ACCESS_PATHS: ClaudeAccessPath[] = [
  {
    key: 'anthropic_endpoint_configured',
    title: '已配置 Anthropic 官方端点',
    description: '目标为 api.anthropic.com；这只确认端点配置，仍需用账号账单和 request id 回查来源。',
    evidence: '官方域名、组织侧 request id、账单与控制面记录。',
  },
  {
    key: 'claude_code_gateway_like',
    title: 'Claude Code 网关兼容链路',
    description: '自定义 Base URL 接受 Claude Code 客户端契约；说明网关兼容，不等于官方直连。',
    evidence: 'x-claude-code-*、attribution block、/v1/models、count_tokens、beta/body 配对和中转响应头。',
  },
  {
    key: 'translated_gateway',
    title: '协议翻译网关',
    description: '发现 OpenAI/Gemini shape、fallback、SSE 重建或模型字段改写等协议翻译痕迹。',
    evidence: '协议族、错误 envelope、message/tool id、stream lifecycle 和模型名差异。',
  },
  {
    key: 'transparent_unresolved',
    title: '透明转发，来源无法解析',
    description: '只看响应无法区分官方上游、OAuth/API 透明转发与无改写代理；不得据此标成官方直连。',
    evidence: '普通 Messages 响应一致，但缺少可回查的来源或网关控制面证据。',
  },
];
