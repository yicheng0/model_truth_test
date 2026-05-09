import type { Channel, ChannelTaxonomySetting } from './types';

export const defaultRoleLabels: Record<string, string> = {
  gold: '金标 Anthropic',
  official_cloud: '官方云参考',
  candidate: '待测第三方',
  negative: '负样本',
};

export const defaultProviderTypeLabels: Record<string, string> = {};

export const roleColor: Record<string, string> = {
  gold: 'gold',
  official_cloud: 'blue',
  candidate: 'purple',
  negative: 'red',
};

export const roleKeys = ['gold', 'official_cloud', 'candidate', 'negative'];
export const providerTypeKeys = Object.keys(defaultProviderTypeLabels);
export const defaultModelOptions: string[] = [];

export function roleLabel(role: string, taxonomy?: ChannelTaxonomySetting) {
  return taxonomy?.role_labels?.[role] || defaultRoleLabels[role] || role;
}

export function providerTypeLabel(providerType: string, taxonomy?: ChannelTaxonomySetting) {
  return taxonomy?.provider_type_labels?.[providerType] || defaultProviderTypeLabels[providerType] || providerType;
}

export function roleOptions(taxonomy?: ChannelTaxonomySetting) {
  return Object.keys(taxonomy?.role_labels ?? defaultRoleLabels).map((role) => ({ value: role, label: roleLabel(role, taxonomy) }));
}

export function providerOptions(taxonomy?: ChannelTaxonomySetting) {
  return Object.keys(taxonomy?.provider_type_labels ?? defaultProviderTypeLabels).map((providerType) => ({ value: providerType, label: providerTypeLabel(providerType, taxonomy) }));
}

export function isReferenceChannel(channel: Channel) {
  return channel.is_reference;
}

export function isCandidateChannel(channel: Channel) {
  return !channel.is_reference;
}
