import { Space, Typography } from 'antd';
import { SystemMaintenancePage } from '../components/SystemMaintenanceModal';

export default function ResourceLogManagement() {
  return (
    <Space direction="vertical" size={20} className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Text className="section-kicker">RESOURCE & LOGS</Typography.Text>
          <Typography.Title level={2}>资源与日志管理</Typography.Title>
          <Typography.Paragraph>
            查看系统资源占用，预估可清理日志，并执行已结束任务的清理操作。
          </Typography.Paragraph>
        </div>
      </div>

      <SystemMaintenancePage />
    </Space>
  );
}
