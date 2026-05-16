import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react-router-dom')) return 'router';
            if (id.includes('@tanstack/react-query')) return 'query';
            if (id.includes('recharts')) return 'charts';
            if (id.includes('react-dom') || id.includes('/react/')) return 'react';
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.VITE_PROXY_TARGET ?? 'http://localhost:8000',
    },
  },
});
