import { describe, expect, it } from 'vitest';
import { channelsForGroup, selectedOutsideGroupCount } from './channelGroups';
import type { Channel } from './types';

const channels: Channel[] = [
  { id: 'cc-1', name: 'CC 1', provider_type: 'custom', role: 'candidate', is_reference: false, enabled: true, groups: [{ id: 'grp_cc', key: 'cc', name: 'CC' }] },
  { id: 'aws-1', name: 'AWS 1', provider_type: 'aws_bedrock', role: 'candidate', is_reference: false, enabled: true, groups: [{ id: 'grp_aws', key: 'aws', name: 'AWS' }] },
  { id: 'none-1', name: 'None', provider_type: 'custom', role: 'candidate', is_reference: false, enabled: true, groups: [] },
];

describe('channel group filtering', () => {
  it('shows all channels without a selected group and only members with a selected group', () => {
    expect(channelsForGroup(channels, undefined).map((channel) => channel.id)).toEqual(['cc-1', 'aws-1', 'none-1']);
    expect(channelsForGroup(channels, 'grp_cc').map((channel) => channel.id)).toEqual(['cc-1']);
  });

  it('keeps existing selections measurable when they are outside the visible group', () => {
    expect(selectedOutsideGroupCount(channels, ['cc-1', 'aws-1'], 'grp_cc')).toBe(1);
    expect(selectedOutsideGroupCount(channels, ['cc-1', 'missing'], 'grp_cc')).toBe(1);
    expect(selectedOutsideGroupCount(channels, ['cc-1'], undefined)).toBe(0);
  });
});
