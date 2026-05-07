import { useEffect, useState } from 'react';
import { Button, Card, Checkbox, Form, Input, InputNumber, Select, Space, Typography, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { Channel, TestSuite } from '../types';

export default function CreateRun() {
  const [suites, setSuites] = useState<TestSuite[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([api.suites(), api.channels()]).then(([suiteData, channelData]) => {
      setSuites(suiteData);
      setChannels(channelData);
    });
  }, []);

  async function submit(values: any) {
    setLoading(true);
    try {
      const grouped: Record<string, string[]> = {};
      for (const channel of channels) {
        if (values.channel_ids?.includes(channel.id)) {
          grouped[channel.role] = [...(grouped[channel.role] ?? []), channel.id];
        }
      }
      const run = await api.startRun({
        name: values.name,
        suite_id: values.suite_id,
        channel_ids: grouped,
        repeat_count: values.repeat_count,
        concurrency: values.concurrency,
        use_mock: values.use_mock ?? true,
      });
      message.success('检测任务已创建');
      navigate(`/runs/${run.id}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-stack">
      <Card title={<span style={{ fontSize: '18px', fontWeight: 600 }}>创建检测任务</span>} bordered={false}>
        <Form layout="vertical" onFinish={submit} initialValues={{ repeat_count: 1, concurrency: 4, use_mock: true }}>
          <Form.Item label="任务名" name="name" rules={[{ required: true }]}>
            <Input size="large" placeholder="Sonnet 4.5 渠道真实性测试" />
          </Form.Item>
          <Form.Item label="测试集" name="suite_id" rules={[{ required: true }]}>
            <Select size="large" placeholder="选择测试集" options={suites.map((suite) => ({ value: suite.id, label: `${suite.name} (${suite.version ?? '未标版'})` }))} />
          </Form.Item>
          <Form.Item label="参与渠道" name="channel_ids" rules={[{ required: true }]}>
            <Checkbox.Group style={{ width: '100%' }}>
              <Space direction="vertical" style={{ width: '100%' }}>
                {channels.map((channel) => (
                  <div key={channel.id} style={{ padding: '12px 16px', background: 'var(--color-bg-subtle)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border-light)' }}>
                    <Checkbox value={channel.id} style={{ fontWeight: 500 }}>
                      {channel.name} <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400 }}>· {channel.role}</span>
                    </Checkbox>
                  </div>
                ))}
              </Space>
            </Checkbox.Group>
          </Form.Item>
          <Space size="large" wrap style={{ marginBottom: '16px' }}>
            <Form.Item label="重复次数" name="repeat_count" style={{ marginBottom: 0 }}>
              <InputNumber size="large" min={1} max={5} style={{ width: '120px' }} />
            </Form.Item>
            <Form.Item label="并发度" name="concurrency" style={{ marginBottom: 0 }}>
              <InputNumber size="large" min={1} max={16} style={{ width: '120px' }} />
            </Form.Item>
            <Form.Item label="模拟执行" name="use_mock" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox style={{ marginTop: '32px' }}>使用内置 mock client</Checkbox>
            </Form.Item>
          </Space>
          <Typography.Paragraph type="secondary" style={{ marginBottom: '24px', fontSize: '14px' }}>
            第一版默认使用 mock client 完成全流程验证；接入真实密钥后可切换实时调用。
          </Typography.Paragraph>
          <Button type="primary" size="large" htmlType="submit" loading={loading} style={{ height: '44px', fontWeight: 600 }}>
            启动检测
          </Button>
        </Form>
      </Card>
    </div>
  );
}

