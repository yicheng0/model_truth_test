export type SignatureChannelLike = {
  id: string;
  model_name?: string | null;
  is_reference?: boolean;
};

export function signatureModelComparisonKey(modelName?: string | null) {
  return String(modelName || '')
    .trim()
    .toLowerCase()
    .replace(/-(?:low|medium|high|xhigh|max)$/, '');
}

export function findRecommendedSignaturePair(channels: SignatureChannelLike[]) {
  const source = channels.find((channel) => !channel.is_reference);
  const relays = channels.filter((channel) => channel.is_reference);
  if (!source) return { source: undefined, relay: relays[0] };
  const sourceKey = signatureModelComparisonKey(source.model_name);
  const relay = relays.find((channel) => signatureModelComparisonKey(channel.model_name) === sourceKey)
    || relays[0];
  return { source, relay };
}

export function isReverseSignaturePair(
  source: SignatureChannelLike | undefined,
  relay: SignatureChannelLike | undefined,
) {
  return Boolean(source?.is_reference && relay && !relay.is_reference);
}

export function signatureModelsComparable(
  source: SignatureChannelLike | undefined,
  relay: SignatureChannelLike | undefined,
) {
  if (!source || !relay || !source.model_name || !relay.model_name) return true;
  return signatureModelComparisonKey(source.model_name) === signatureModelComparisonKey(relay.model_name);
}

export function signatureResultMessage(result: {
  ok: boolean;
  signature_ok?: boolean | null;
  status: string;
  classification?: string | null;
  identity_labels?: string[];
}) {
  if (result.identity_labels?.includes('kiro_identity_leak')) return '[HIGH RISK] 疑似 Kiro 路由混入';
  if (result.classification === 'not_comparable' || result.status === 'not_comparable') return '[需调整] Source 与 Relay 模型不可比';
  if (result.signature_ok === true && result.ok) return '[PASS] Source Signature 已被官方 Relay 接受';
  if (result.signature_ok === true) return '[身份异常] Signature 已接受，但 Source 身份检测未通过';
  if (result.signature_ok == null) return '[无法判定] Signature 未完成验证';
  return '[FAIL] Source Signature 未被官方 Relay 接受';
}
