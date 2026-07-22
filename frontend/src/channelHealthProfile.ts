export const healthStatusMeta: Record<string, { label: string; color: string }> = {
  ok: { label: '健康', color: 'green' },
  healthy: { label: '健康', color: 'green' },
  watch: { label: '观察', color: 'gold' },
  degraded: { label: '需关注', color: 'red' },
  critical: { label: '严重', color: 'red' },
  insufficient_data: { label: '样本不足', color: 'default' },
  stale: { label: '数据过期', color: 'orange' },
  inconclusive: { label: '参考不足', color: 'default' },
};

export const healthDimensionMeta: Record<string, { label: string; color: string }> = {
  availability: { label: '运行健康', color: '#1677ff' },
  performance: { label: '性能', color: '#13c2c2' },
  protocol: { label: '来源一致性', color: '#722ed1' },
  quality: { label: '能力质量', color: '#eb2f96' },
};

export function healthStatusLabel(status?: string | null): string {
  return healthStatusMeta[status || '']?.label || status || '-';
}

export function healthStatusColor(status?: string | null): string {
  return healthStatusMeta[status || '']?.color || 'default';
}

export function healthDimensionLabel(key: string): string {
  return healthDimensionMeta[key]?.label || key;
}

export function healthDimensionColor(key: string): string {
  return healthDimensionMeta[key]?.color || '#8c8c8c';
}

export function formatHealthReason(code: string): string {
  const labels: Record<string, string> = {
    request_failures_present: '存在请求失败',
    protocol_mismatch: '协议字段异常',
    quality_regression: '能力质量回归',
    latency_p95_high: 'P95 延迟偏高',
    ttft_p95_high: '首 token 延迟偏高',
    throughput_low: '吞吐偏低',
    baseline_inconclusive: '官方参考样本不足',
    baseline_unhealthy: '官方参考异常',
    degraded_two_windows: '连续两个窗口异常',
    critical_consecutive_failure: '连续失败达到严重阈值',
    critical_protocol_anomaly: '严重协议异常',
    recovered_two_windows: '连续两个窗口恢复正常',
    data_stale: '数据已过期',
  };
  return labels[code] || code;
}
