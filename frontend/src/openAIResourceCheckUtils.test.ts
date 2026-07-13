import { describe, expect, it } from 'vitest';
import { capabilityState, mixedRoutingReasonText, OPENAI_COMMON_MODEL_OPTIONS, openAIResourcePayload, probeAttemptStatusMeta, probeDifferenceMeta, probeExecutionMeta, resourceFamilyMeta } from './openAIResourceCheckUtils';

describe('OpenAI/Codex resource check helpers', () => {
  it('builds the new auto-detection payload', () => {
    expect(openAIResourcePayload({
      base_url: ' https://relay.example/v1 ',
      api_key: ' gateway-key ',
      model: ' gpt-5-codex ',
      detection_mode: 'codex_relay',
      probe_depth: 'deep',
    })).toEqual({
      base_url: 'https://relay.example/v1',
      api_key: 'gateway-key',
      organization: null,
      project: null,
      model: 'gpt-5-codex',
      detection_mode: 'codex_relay',
      probe_depth: 'deep',
    });
  });

  it('renders unexecuted optional capabilities separately from failures', () => {
    expect(capabilityState(null)).toEqual({ color: 'default', text: '未执行' });
    expect(capabilityState(true)).toEqual({ color: 'green', text: '通过' });
    expect(capabilityState(false)).toEqual({ color: 'orange', text: '不支持 / 未通过' });
  });

  it('uses cautious language for Codex relay inference', () => {
    expect(resourceFamilyMeta('codex_compatible_relay_likely')).toEqual({ color: 'purple', text: '疑似 Codex-compatible 中转' });
    expect(resourceFamilyMeta('official_openai_api_likely').text).toBe('OpenAI API 官方直连高一致');
  });

  it('offers current common models without GPT-4.1 defaults', () => {
    const models = OPENAI_COMMON_MODEL_OPTIONS.map((item) => item.value);
    expect(models).toContain('gpt-5.6-luna');
    expect(models).toContain('gpt-5.6-terra');
    expect(models).toContain('gpt-5.6-sol');
    expect(models.some((model) => model.includes('4.1'))).toBe(false);
  });

  it('renders probe execution and difference strength in user-facing language', () => {
    expect(probeExecutionMeta('passed')).toEqual({ color: 'green', text: '通过' });
    expect(probeExecutionMeta('not_run')).toEqual({ color: 'default', text: '未执行' });
    expect(probeDifferenceMeta('strong')).toEqual({ color: 'purple', text: '强区分项' });
    expect(probeDifferenceMeta('supporting')).toEqual({ color: 'blue', text: '辅助区分项' });
  });

  it('renders operational failures as unavailable samples instead of authenticity failures', () => {
    expect(probeAttemptStatusMeta('operational_failure')).toEqual({ color: 'gold', text: '不可用样本' });
    expect(probeAttemptStatusMeta('warning')).toEqual({ color: 'orange', text: '存在差异' });
  });

  it('renders mixed routing reasons with concrete model families', () => {
    expect(mixedRoutingReasonText({
      probe: 'chat_vs_responses',
      reason: 'cross_protocol_model_family_changed',
      chat_models: ['gpt-5.6'],
      response_models: ['gpt-4o'],
    })).toBe('Chat 与 Responses 返回不同模型家族：gpt-5.6 / gpt-4o');
  });
});
