import type { Channel, ChannelRole, ChannelTaxonomySetting } from './types';

export const defaultRoleLabels: Record<ChannelRole, string> = {
  gold: '金标 Anthropic',
  official_cloud: '官方云参考',
  candidate: '待测第三方',
  negative: '负样本',
};

export const defaultProviderTypeLabels: Record<string, string> = {
  anthropic: 'Anthropic',
  aws_bedrock: 'AWS Bedrock',
  azure_foundry: 'Azure AI Foundry',
  third_party_anthropic: 'Third-party Anthropic compatible',
  third_party_openai_compatible: 'Third-party OpenAI compatible',
  openai_compatible: 'OpenAI compatible',
  custom: 'Custom',
};

export const roleColor: Record<ChannelRole, string> = {
  gold: 'gold',
  official_cloud: 'blue',
  candidate: 'purple',
  negative: 'red',
};

export const roleKeys: ChannelRole[] = ['gold', 'official_cloud', 'candidate', 'negative'];
export const providerTypeKeys = Object.keys(defaultProviderTypeLabels);

export function roleLabel(role: ChannelRole, taxonomy?: ChannelTaxonomySetting) {
  return taxonomy?.role_labels?.[role] || defaultRoleLabels[role] || role;
}

export function providerTypeLabel(providerType: string, taxonomy?: ChannelTaxonomySetting) {
  return taxonomy?.provider_type_labels?.[providerType] || defaultProviderTypeLabels[providerType] || providerType;
}

export function roleOptions(taxonomy?: ChannelTaxonomySetting) {
  return roleKeys.map((role) => ({ value: role, label: roleLabel(role, taxonomy) }));
}

export function providerOptions(taxonomy?: ChannelTaxonomySetting) {
  return providerTypeKeys.map((providerType) => ({ value: providerType, label: providerTypeLabel(providerType, taxonomy) }));
}

export const referenceRoles = new Set<ChannelRole>(['gold', 'official_cloud']);

export function isReferenceChannel(channel: Channel) {
  return referenceRoles.has(channel.role);
}

export function isCandidateChannel(channel: Channel) {
  return channel.role === 'candidate' || channel.role === 'negative';
}
