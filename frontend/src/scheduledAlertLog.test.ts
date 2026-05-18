import { describe, expect, it } from 'vitest';
import type { ChannelAlert } from './types';
import {
  alertChannelId,
  alertChannelDisplay,
  alertChannelModel,
  alertErrorText,
  alertLogText,
  alertOutcomeColor,
  alertOutcomeLabel,
  alertProbeCompletedAt,
  alertProbeSource,
  alertProbeTitle,
  alertRequestId,
  alertResponseId,
  alertResultId,
} from './scheduledAlertLog';

const baseAlert: ChannelAlert = {
  id: 'alert_1',
  run_id: 'run_1',
  report_id: 'report_1',
  channel_id: 'channel_1',
  status: 'pending_review',
  severity: 'high',
  grade: 'D',
  final_score: 72,
  notification_status: 'pending',
};

describe('scheduled alert log helpers', () => {
  it('extracts request id and detailed error text', () => {
    const alert: ChannelAlert = {
      ...baseAlert,
      message: '渠道自动巡检异常：示例错误',
      evidence_summary: {
        channel_id: 'channel_1',
        channel_model_name: 'claude-sonnet',
        provider_endpoint: 'https://api.example.com/v1/messages',
        model_request_request_id: 'req_123',
        model_request_message_id: 'msg_123',
        model_request_result_id: 'result_123',
        error_message: '接口超时',
      },
    };

    expect(alertChannelId(alert)).toBe('channel_1');
    expect(alertChannelModel(alert)).toBe('claude-sonnet');
    expect(alertResponseId(alert)).toBe('msg_123');
    expect(alertRequestId(alert)).toBe('req_123');
    expect(alertResultId(alert)).toBe('result_123');
    expect(alertProbeSource(alert)).toBe('https://api.example.com/v1/messages');
    expect(alertErrorText(alert)).toBe('接口超时');
  });

  it('formats smart report channel labels with provider type', () => {
    const alert: ChannelAlert = {
      ...baseAlert,
      channel_id: '9335-tokenflow-aws',
      evidence_summary: {
        channel_id: '9335-tokenflow-aws',
        channel_name: '阿宝',
        channel_account_type: 'aws',
        channel_provider_type: 'aws_bedrock',
      },
    };

    expect(alertChannelDisplay(alert, '阿宝')).toBe('阿宝');
  });

  it('prefers the channel record name over evidence channel_name', () => {
    const alert: ChannelAlert = {
      ...baseAlert,
      channel_id: '9029-tokenflow-aws',
      evidence_summary: {
        channel_id: '9029-tokenflow-aws',
        channel_name: '9029-风雨-aws_bedrock',
        channel_account_type: 'aws',
        channel_provider_type: 'aws_bedrock',
      },
    };

    expect(alertChannelDisplay(alert, '风雨')).toBe('风雨');
    expect(
      alertLogText({
        alertCreatedAt: '2026-05-16 10:20:30',
        probeCompletedAt: '2026-05-16 10:19:30',
        probeTitle: 'Web Search tool',
        channel: alertChannelDisplay(alert, '风雨'),
        channelId: '9029-风雨-aws',
        channelModel: 'claude-sonnet',
        probeSource: 'api / openai_chat_completions',
        resultId: 'result_123',
        messageId: 'msg_123',
        requestId: 'req_789',
        error: '接口超时',
      }),
    ).toContain('渠道：风雨');
    expect(
      alertLogText({
        alertCreatedAt: '2026-05-16 10:20:30',
        probeCompletedAt: '2026-05-16 10:19:30',
        probeTitle: 'Web Search tool',
        channel: alertChannelDisplay(alert, '风雨'),
        channelId: '9029-风雨-aws',
        channelModel: 'claude-sonnet',
        probeSource: 'api / openai_chat_completions',
        resultId: 'result_123',
        messageId: 'msg_123',
        requestId: 'req_789',
        error: '接口超时',
      }),
    ).toContain('渠道 ID：9029-风雨-aws');
  });

  it('falls back to model request errors and labels', () => {
    const alert: ChannelAlert = {
      ...baseAlert,
      message: '渠道自动巡检异常',
      evidence_summary: {
        model_requests: [
          { title: '模型请求', error: '拒绝参数', request_id: 'req_456' },
        ],
        label_explanations: [{ label: 'x', description: '疑似逆向或中间层改写' }],
      },
    };

    expect(alertRequestId(alert)).toBe('req_456');
    expect(alertErrorText(alert)).toBe('模型请求：拒绝参数');
    expect(alertProbeTitle(alert)).toBe('模型请求');
  });

  it('uses classification text for claude and aws_resource alerts', () => {
    const awsExpectedErrorAlert: ChannelAlert = {
      ...baseAlert,
      evidence_summary: {
        classification_status: 'aws_resource',
        classification_label: 'AWS 资源',
        classification_reason: '三项自动巡检探针均命中 Bedrock/Claude 原生参数拒绝形态，资源按 AWS 路径处理。',
      },
    };
    const awsAlert: ChannelAlert = {
      ...baseAlert,
      evidence_summary: {
        classification_status: 'aws_resource',
        classification_label: 'AWS 资源',
        classification_reason: '三项自动巡检探针均通过，资源按 AWS 路径处理。',
      },
    };

    expect(alertProbeTitle(awsExpectedErrorAlert)).toBe('AWS 资源');
    expect(alertErrorText(awsExpectedErrorAlert)).toBe('AWS 资源，三项自动巡检探针均命中 Bedrock/Claude 原生参数拒绝形态，资源按 AWS 路径处理。');
    expect(alertProbeTitle(awsAlert)).toBe('AWS 资源');
    expect(alertErrorText(awsAlert)).toContain('AWS 资源');
  });

  it('selects the failing probe and its completed time from multiple model requests', () => {
    const alert: ChannelAlert = {
      ...baseAlert,
      evidence_summary: {
        model_requests: [
          {
            title: 'Thinking temperature 冲突',
            request_id: 'req_ok',
            completed_at: '2026-05-16T01:00:00Z',
            labels: [],
          },
          {
            title: 'Web Search tool',
            request_id: 'req_fail',
            created_at: '2026-05-16T01:02:00Z',
            completed_at: '2026-05-16T01:02:03Z',
            labels: ['web_search_not_rejected'],
          },
        ],
      },
    };

    expect(alertProbeTitle(alert)).toBe('Web Search tool');
    expect(alertProbeCompletedAt(alert)).toBe('2026-05-16T01:02:03Z');
    expect(alertRequestId(alert)).toBe('req_fail');
    expect(alertErrorText(alert)).toBe('Web Search tool：探针触发异常标签');
  });

  it('falls back to probe created time when completed time is missing', () => {
    const alert: ChannelAlert = {
      ...baseAlert,
      evidence_summary: {
        model_requests: [
          {
            title: 'thinking.adaptive.enabled',
            request_id: 'req_adaptive',
            created_at: '2026-05-16T01:03:04Z',
            labels: ['thinking_adaptive_enabled_not_rejected'],
          },
        ],
      },
    };

    expect(alertProbeCompletedAt(alert)).toBe('2026-05-16T01:03:04Z');
  });

  it('formats compact log text and outcome labels', () => {
    expect(alertOutcomeLabel('resolved')).toBe('成功');
    expect(alertOutcomeColor('resolved')).toBe('green');
    expect(alertOutcomeLabel('pending_review')).toBe('失败');
    expect(alertOutcomeColor('pending_review')).toBe('red');
    expect(
      alertLogText({
        alertCreatedAt: '2026-05-16 10:20:30',
        probeCompletedAt: '2026-05-16 10:19:30',
        probeTitle: 'Web Search tool',
        channel: '渠道 A (channel_1)',
        channelId: 'channel_1',
        channelModel: 'claude-sonnet',
        probeSource: 'api / openai_chat_completions',
        resultId: 'result_123',
        messageId: 'msg_123',
        requestId: 'req_789',
        error: '接口超时',
      }),
    ).toContain('Result ID：result_123');
    expect(
      alertLogText({
        alertCreatedAt: '2026-05-16 10:20:30',
        probeCompletedAt: '2026-05-16 10:19:30',
        probeTitle: 'Web Search tool',
        channel: '渠道 A (channel_1)',
        channelId: 'channel_1',
        channelModel: 'claude-sonnet',
        probeSource: 'api / openai_chat_completions',
        resultId: 'result_123',
        messageId: 'msg_123',
        requestId: 'req_789',
        error: '接口超时',
      }),
    ).toContain('Result ID：result_123');
  });
});
