import { Form, Input, Select, Tag, Typography } from 'antd';
import type { Rule } from 'antd/es/form';
import { hasStoredApiKey } from '../channelCredentials';
import type { Channel, TestSuite } from '../types';

export type RuntimeCredentialValues = {
  api_key?: string;
};

export const DEFAULT_SUITE_ID = 'claude_full_35';

export function getDefaultSuite(suites?: TestSuite[]) {
  return suites?.find((suite) => suite.id === DEFAULT_SUITE_ID) ?? suites?.[0];
}

export function parseConcurrencySteps(value?: string) {
  const steps = (value || '1,4,8')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
  return steps.length ? Array.from(new Set(steps)) : [1];
}

export function selectedChannels(channels: Channel[] | undefined, selectedIds: string[] = []) {
  const channelById = new Map((channels ?? []).map((channel) => [channel.id, channel]));
  return selectedIds.map((id) => channelById.get(id)).filter((channel): channel is Channel => Boolean(channel));
}

export function channelSelectOptions(channels: Channel[] = [], tag?: { color: string; label: string }) {
  return channels.map((channel) => ({
    value: channel.id,
    disabled: !channel.enabled,
    searchLabel: `${channel.name} ${channel.model_name ?? ''}`,
    label: (
      <span className="channel-select-option">
        <span>
          <strong>{channel.name}</strong>
          <small>{channel.model_name || '未配置模型'}</small>
        </span>
        {tag ? <Tag color={tag.color}>{tag.label}</Tag> : null}
        {!channel.enabled ? <Tag>已停用</Tag> : null}
      </span>
    ),
  }));
}

export const atLeastOneChannelRule = (message: string): Rule => ({
  validator: (_, value: string[] = []) => (value.length ? Promise.resolve() : Promise.reject(new Error(message))),
});

export const atLeastTwoChannelsRule = (message: string): Rule => ({
  validator: (_, value: string[] = []) => (value.length >= 2 ? Promise.resolve() : Promise.reject(new Error(message))),
});

type ChannelSelectProps = {
  loading?: boolean;
  placeholder: string;
  channels: Channel[];
  tag?: { color: string; label: string };
  notFoundContent?: string;
};

export function ChannelMultiSelect({ loading, placeholder, channels, tag, notFoundContent }: ChannelSelectProps) {
  return (
    <Select
      mode="multiple"
      size="large"
      showSearch
      allowClear
      maxTagCount="responsive"
      loading={loading}
      placeholder={placeholder}
      optionFilterProp="searchLabel"
      options={channelSelectOptions(channels, tag)}
      notFoundContent={notFoundContent}
    />
  );
}

type RuntimeCredentialsFieldsProps = {
  channels: Channel[];
};

export function RuntimeCredentialsFields({ channels }: RuntimeCredentialsFieldsProps) {
  if (!channels.length) return null;

  return (
    <div className="runtime-credentials">
      <div className="credential-heading">
        <Typography.Text strong>运行时凭据</Typography.Text>
        <Typography.Text type="secondary">已配置渠道会自动使用渠道管理中的 API Key；未配置渠道需为本次任务补充。</Typography.Text>
      </div>
      {channels.map((channel) => (
        <div className="credential-row" key={channel.id}>
          <div className="credential-channel">
            <strong>{channel.name}</strong>
            <small>{channel.model_name || '未配置模型'}</small>
          </div>
          {hasStoredApiKey(channel) ? (
            <div className="credential-status">
              <Tag color="green">已配置</Tag>
              <Typography.Text type="secondary">使用渠道管理中的 API Key</Typography.Text>
            </div>
          ) : (
            <Form.Item
              label="API Key"
              name={['runtime_credentials', channel.id, 'api_key']}
              rules={[
                {
                  validator: (_, value: string | undefined) =>
                    value?.trim() ? Promise.resolve() : Promise.reject(new Error('请输入该渠道的 API Key')),
                },
              ]}
            >
              <Input autoComplete="off" placeholder="sk-ant-..." />
            </Form.Item>
          )}
        </div>
      ))}
    </div>
  );
}
