import type { Channel, ChannelRole } from './types';

export type ChannelPreset = Pick<Channel, 'id' | 'name' | 'provider_type' | 'role' | 'base_url' | 'model_name'>;

export const fixedReferenceChannels: ChannelPreset[] = [
  {
    id: 'anthropic_official',
    name: 'Anthropic Official',
    provider_type: 'anthropic',
    role: 'gold',
    base_url: 'https://api.anthropic.com',
    model_name: 'claude-sonnet-4-5',
  },
  {
    id: 'aws_bedrock',
    name: 'AWS Bedrock Claude',
    provider_type: 'aws_bedrock',
    role: 'official_cloud',
    base_url: 'bedrock-runtime',
    model_name: 'anthropic.claude-sonnet-4-5-v1:0',
  },
  {
    id: 'azure_foundry',
    name: 'Azure AI Foundry Claude',
    provider_type: 'azure_foundry',
    role: 'official_cloud',
    base_url: 'https://example.services.ai.azure.com',
    model_name: 'claude-sonnet-4-5',
  },
];

export const fixedReferenceChannelIds = new Set(fixedReferenceChannels.map((channel) => channel.id));

export const referenceRoles = new Set<ChannelRole>(['gold', 'official_cloud']);

export function isReferenceChannel(channel: Channel) {
  return referenceRoles.has(channel.role);
}

export function isCandidateChannel(channel: Channel) {
  return channel.role === 'candidate' || channel.role === 'negative';
}
