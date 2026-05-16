import { Button, Card, Descriptions, Drawer, Space, Typography, message } from 'antd';
import { ClipboardCopy } from 'lucide-react';
import type { ChannelAlert } from '../types';
import {
  alertChannelId,
  alertChannelDisplay,
  alertChannelModel,
  alertErrorText,
  alertLogText,
  alertProbeCompletedAt,
  alertProbeSource,
  alertProbeTitle,
  alertRequestId,
  alertResponseId,
  alertResultId,
} from '../scheduledAlertLog';
import { formatDateTime } from '../time';

type AlertLogDrawerProps = {
  alert: ChannelAlert | null;
  channel: string;
  onClose: () => void;
};

async function copyText(text: string, successText: string) {
  await navigator.clipboard?.writeText(text);
  message.success(successText);
}

export default function AlertLogDrawer({ alert, channel, onClose }: AlertLogDrawerProps) {
  const requestId = alert ? alertRequestId(alert) : '';
  const messageId = alert ? alertResponseId(alert) : '';
  const error = alert ? alertErrorText(alert) : '';
  const alertCreatedAt = alert ? formatDateTime(alert.created_at) : '';
  const probeCompletedAt = alert ? formatDateTime(alertProbeCompletedAt(alert)) || formatDateTime(alert.created_at) : '';
  const probeTitle = alert ? alertProbeTitle(alert) : '';
  const channelId = alert ? alertChannelId(alert) : '';
  const channelModel = alert ? alertChannelModel(alert) : '';
  const probeSource = alert ? alertProbeSource(alert) : '';
  const resultId = alert ? alertResultId(alert) : '';
  const channelDisplay = alert ? alertChannelDisplay(alert, channel) : channel;
  const logText = alertLogText({
    alertCreatedAt,
    probeCompletedAt,
    probeTitle,
    channel: channelDisplay,
    channelId,
    channelModel,
    probeSource,
    resultId,
    messageId,
    requestId,
    error,
  });

  return (
    <Drawer
      title="日志详情"
      open={Boolean(alert)}
      onClose={onClose}
      width={560}
      extra={alert ? <Button icon={<ClipboardCopy size={15} />} onClick={() => void copyText(logText, '日志已复制')}>复制日志</Button> : null}
    >
      {alert ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="告警创建时间">{alertCreatedAt || '-'}</Descriptions.Item>
            <Descriptions.Item label="探针完成时间">{probeCompletedAt || '-'}</Descriptions.Item>
            <Descriptions.Item label="异常探针">{probeTitle || '-'}</Descriptions.Item>
            <Descriptions.Item label="渠道">{channelDisplay || '-'}</Descriptions.Item>
            <Descriptions.Item label="渠道 ID">{channelId || '-'}</Descriptions.Item>
            <Descriptions.Item label="渠道模型">{channelModel || '-'}</Descriptions.Item>
            <Descriptions.Item label="探针来源">{probeSource || '-'}</Descriptions.Item>
            <Descriptions.Item label="Result ID">
              <Typography.Text copyable={{ text: resultId, onCopy: () => message.success('Result ID 已复制') }}>{resultId || '-'}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="Message ID">
              <Typography.Text copyable={{ text: messageId, onCopy: () => message.success('Message ID 已复制') }}>{messageId || '-'}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="Request ID">
              <Typography.Text copyable={{ text: requestId, onCopy: () => message.success('Request ID 已复制') }}>{requestId || '-'}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="报错内容">{error || '-'}</Descriptions.Item>
          </Descriptions>
          <Card size="small" title="日志原文" bordered={false}>
            <pre className="output-drawer-pre">{logText}</pre>
          </Card>
        </Space>
      ) : null}
    </Drawer>
  );
}
