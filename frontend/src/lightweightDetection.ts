import type { ClaudeCodeProbeResult, ClaudeCodeTestResult } from './types';

export type LightweightCheckStatus = 'passed' | 'warning' | 'failed' | 'unavailable' | 'not_tested';

export type LightweightCheck = {
  key: string;
  title: string;
  status: LightweightCheckStatus;
  summary: string;
  probeKeys: string[];
};

const CHECK_DEFINITIONS = [
  { key: 'connectivity', title: '连接与鉴权', probes: ['basic_echo'] },
  { key: 'protocol', title: '协议规范性', probes: ['basic_shape', 'response_body_shape', 'usage_metadata'] },
  { key: 'message_id', title: '消息标识规范', probes: ['message_id_source'] },
  { key: 'model_identity', title: '模型声明一致性', probes: ['model_self_report', 'knowledge_cutoff'] },
  { key: 'thinking_signature', title: 'Thinking / Signature', probes: ['thinking_signature', 'signature_interop'] },
  { key: 'tool_use', title: '工具调用', probes: ['tool_use_shape'] },
  { key: 'structured_output', title: '结构化输出', probes: ['strict_json_schema'] },
  { key: 'streaming', title: '流式响应', probes: ['stream_lifecycle', 'stream_realtime'] },
  { key: 'context', title: '多轮上下文', probes: ['multi_turn_state', 'instruction_following', 'system_prompt_leak'] },
  { key: 'capability', title: '能力一致性', probes: ['repeatability_nonce_pair', 'knowledge_cutoff', 'instruction_following'] },
] as const;

function normalizedProbeKey(probe: ClaudeCodeProbeResult) {
  return probe.key.replace(/#\d+$/, '');
}

function aggregateStatus(probes: ClaudeCodeProbeResult[]): LightweightCheckStatus {
  if (!probes.length) return 'not_tested';
  const statuses = probes.map((probe) => probe.status);
  if (statuses.some((status) => status === 'fail' || status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'warning')) return 'warning';
  if (statuses.every((status) => status === 'skipped' || status === 'not_applicable')) return 'unavailable';
  if (statuses.some((status) => status === 'pass' || status === 'passed')) return 'passed';
  return 'not_tested';
}

export function buildLightweightChecks(result: ClaudeCodeTestResult): LightweightCheck[] {
  return CHECK_DEFINITIONS.map((definition) => {
    const probes = result.probes.filter((probe) => definition.probes.some((key) => normalizedProbeKey(probe) === key));
    const status = aggregateStatus(probes);
    const evidence = probes.find((probe) => probe.status === 'fail' || probe.status === 'warning') ?? probes[0];
    return {
      key: definition.key,
      title: definition.title,
      status,
      summary: evidence?.reason || evidence?.evidence_excerpt || (status === 'not_tested' ? '本轮未执行该项探针' : '已记录对应探针证据'),
      probeKeys: probes.map((probe) => probe.key),
    };
  });
}

type UnsafeHistoryInput = {
  id: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  score: number;
  status: string;
  createdAt: string;
};

export type SafeDetectionHistory = {
  id: string;
  endpointHost: string;
  model: string;
  score: number;
  status: string;
  createdAt: string;
};

export function sanitizeDetectionHistory(input: UnsafeHistoryInput): SafeDetectionHistory {
  let endpointHost = input.baseUrl;
  try {
    endpointHost = new URL(input.baseUrl).host;
  } catch {
    endpointHost = input.baseUrl.replace(/^https?:\/\//, '').split('/')[0];
  }
  return { id: input.id, endpointHost, model: input.model, score: input.score, status: input.status, createdAt: input.createdAt };
}
