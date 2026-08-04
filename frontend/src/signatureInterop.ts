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

export function findRecommendedSignatureRelay(
  channels: SignatureChannelLike[],
  source: SignatureChannelLike | undefined,
) {
  const candidates = channels.filter((channel) => !channel.is_reference);
  if (!source) return candidates[0];
  const sourceKey = signatureModelComparisonKey(source.model_name);
  return candidates.find((channel) => signatureModelComparisonKey(channel.model_name) === sourceKey)
    || candidates[0];
}

export function signatureModelsComparable(
  source: SignatureChannelLike | undefined,
  relay: SignatureChannelLike | undefined,
) {
  if (!source || !relay || !source.model_name || !relay.model_name) return true;
  return signatureModelComparisonKey(source.model_name) === signatureModelComparisonKey(relay.model_name);
}
