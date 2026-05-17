import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Descriptions, Modal, Popconfirm, Progress, Space, Statistic, message } from 'antd';
import { DatabaseZap } from 'lucide-react';
import { api, getErrorMessage } from '../api';
import { useAdminAccess } from '../adminAccess';
import type { RunLogCleanupResult } from '../types';

function formatBytes(value?: number | null) {
  if (value === null || value === undefined) return '-';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

function cleanupSummary(result?: RunLogCleanupResult | null) {
  if (!result) return '暂无预估数据';
  return `可清理 ${result.deleted_runs} 个任务，${result.deleted_results} 条结果，${result.deleted_reports} 份报告，${result.deleted_alerts} 条告警`;
}

function SystemMaintenanceBody({
  open,
}: {
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const { isAdminMode } = useAdminAccess();
  const usage = useQuery({
    queryKey: ['systemUsage'],
    queryFn: api.systemUsage,
    enabled: open,
  });
  const preview = useQuery({
    queryKey: ['cleanupRunLogsPreview'],
    queryFn: () => api.cleanupRunLogs(true),
    enabled: open && isAdminMode,
    staleTime: 60_000,
  });
  const cleanup = useMutation({
    mutationFn: () => api.cleanupRunLogs(false),
    onSuccess: async (result) => {
      message.success(`已清理 ${result.deleted_runs} 个任务日志`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['runs'] }),
        queryClient.invalidateQueries({ queryKey: ['reports'] }),
        queryClient.invalidateQueries({ queryKey: ['alerts'] }),
        queryClient.invalidateQueries({ queryKey: ['systemUsage'] }),
        queryClient.invalidateQueries({ queryKey: ['cleanupRunLogsPreview'] }),
      ]);
    },
    onError: (error) => message.error(getErrorMessage(error)),
  });

  const data = usage.data;
  const cleanupDisabled = !isAdminMode || cleanup.isPending || !preview.data?.deleted_runs;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {usage.isError ? (
        <Alert
          type="error"
          showIcon
          message="资源占用加载失败"
          description={getErrorMessage(usage.error)}
          action={<Button onClick={() => usage.refetch()}>重试</Button>}
        />
      ) : null}
      {preview.isError ? (
        <Alert
          type="error"
          showIcon
          message="清理预估加载失败"
          description={getErrorMessage(preview.error)}
          action={<Button onClick={() => preview.refetch()}>重试</Button>}
        />
      ) : null}
      {!isAdminMode ? (
        <Alert
          type="info"
          showIcon
          message="管理员模式未启用"
          description="日志清理属于破坏性操作，需要在本浏览器配置管理员密钥后才能预估和执行。"
        />
      ) : null}
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space wrap size={12}>
          <Card size="small" style={{ width: 170 }}>
            <Statistic title="磁盘已用" value={data?.disk_used_percent ?? 0} precision={1} suffix="%" loading={usage.isLoading} />
          </Card>
          <Card size="small" style={{ width: 170 }}>
            <Statistic title="磁盘可用" value={formatBytes(data?.disk_free_bytes)} loading={usage.isLoading} />
          </Card>
          <Card size="small" style={{ width: 170 }}>
            <Statistic title="内存已用" value={data?.memory_used_percent ?? '-'} precision={1} suffix={data?.memory_used_percent === null || data?.memory_used_percent === undefined ? '' : '%'} loading={usage.isLoading} />
          </Card>
          <Card size="small" style={{ width: 170 }}>
            <Statistic title="数据库大小" value={formatBytes(data?.database_size_bytes)} loading={usage.isLoading} />
          </Card>
        </Space>
        <Progress
          percent={Math.round(data?.disk_used_percent ?? 0)}
          status={(data?.disk_used_percent ?? 0) >= 90 ? 'exception' : 'normal'}
        />
        <Descriptions size="small" column={2} bordered>
          <Descriptions.Item label="监控路径">{data?.disk_path ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="数据库">{data?.database_path ?? '非 SQLite 或不可定位'}</Descriptions.Item>
          <Descriptions.Item label="任务数">{data?.run_count ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="结果数">{data?.result_count ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="报告数">{data?.report_count ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="告警数">{data?.alert_count ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="清理预估" span={2}>
            {!isAdminMode ? '管理员模式未启用' : preview.isLoading ? '正在计算...' : preview.isError ? '暂未取得预估数据，可稍后重试' : cleanupSummary(preview.data)}
          </Descriptions.Item>
          <Descriptions.Item label="保留任务" span={2}>
            运行中/待执行 {preview.data?.skipped_running_runs ?? data?.cleanup_skipped_baseline_run_count ?? 0} 个，指纹引用 {preview.data?.skipped_baseline_runs ?? 0} 个
          </Descriptions.Item>
        </Descriptions>
        <Alert
          type="warning"
          showIcon
          message="清理只删除已结束任务的日志数据"
          description="渠道、测试集、自动巡检配置和渠道指纹会保留。被渠道指纹引用的任务不会被清理。"
        />
        <Space wrap>
          <Popconfirm
            title="清理已结束日志"
            description="会删除已完成、失败、取消和中断的任务日志；运行中任务和渠道指纹引用任务会保留。"
            okText="确认清理"
            cancelText="返回"
            onConfirm={() => cleanup.mutate()}
            disabled={cleanupDisabled}
          >
            <Button danger type="primary" loading={cleanup.isPending} disabled={cleanupDisabled} icon={<DatabaseZap size={16} />}>
              清理已结束日志
            </Button>
          </Popconfirm>
        </Space>
      </Space>
    </Space>
  );
}

export function SystemMaintenancePage() {
  return <SystemMaintenanceBody open />;
}

export function SystemMaintenanceModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      title="资源与日志清理"
      open={open}
      onCancel={onClose}
      width={760}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      <SystemMaintenanceBody open={open} />
    </Modal>
  );
}
