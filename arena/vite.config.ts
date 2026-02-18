import { reactRouter } from '@react-router/dev/vite';
import UnoCSS from 'unocss/vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig, type Plugin } from 'vite';

function clientChunks(): Plugin {
  return {
    name: 'client-chunks',
    config(_, { isSsrBuild }) {
      if (!isSsrBuild) {
        return {
          build: {
            rollupOptions: {
              output: {
                manualChunks: {
                  'react-vendor': ['react', 'react-dom', 'react-router'],
                  'web3-vendor': ['wagmi', 'viem', '@tanstack/react-query', 'connectkit'],
                  'chart-vendor': ['chart.js', 'react-chartjs-2'],
                  'motion-vendor': ['framer-motion'],
                },
              },
            },
          },
        };
      }
    },
  };
}

export default defineConfig({
  plugins: [
    UnoCSS(),
    reactRouter(),
    tsconfigPaths(),
    clientChunks(),
  ],
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      events: 'events',
    },
  },
  server: {
    proxy: {
      // Proxy operator API calls to avoid CORS issues in development
      '/operator-api': {
        target: 'http://localhost:9200',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/operator-api/, ''),
      },
    },
  },
});
