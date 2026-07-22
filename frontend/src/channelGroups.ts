import type { Channel } from './types';

export function channelsForGroup(channels: Channel[], groupId?: string) {
  if (!groupId) return channels;
  return channels.filter((channel) => (channel.groups ?? []).some((group) => group.id === groupId));
}

export function selectedOutsideGroupCount(channels: Channel[], selectedIds: string[], groupId?: string) {
  if (!groupId) return 0;
  const visibleIds = new Set(channelsForGroup(channels, groupId).map((channel) => channel.id));
  return selectedIds.filter((id) => !visibleIds.has(id)).length;
}
