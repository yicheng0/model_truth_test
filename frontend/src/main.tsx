import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#9a563f',
          colorInfo: '#2563eb',
          colorSuccess: '#2f8f66',
          borderRadius: 8,
          fontFamily: '"Inter", "Noto Sans SC", system-ui, sans-serif',
        },
        components: {
          Card: { borderRadiusLG: 8 },
          Button: { borderRadius: 8 },
          Table: { headerBg: '#f5f7fa', rowHoverBg: '#f8fafc' },
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ConfigProvider>
  </React.StrictMode>,
);
