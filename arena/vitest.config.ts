import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import path from 'node:path';

const stubs = path.resolve(__dirname, 'src/test/stubs');

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // Stub browser-heavy packages we don't need to exercise in unit tests.
      '@tangle-network/sandbox-ui/chat': path.join(
        stubs,
        'sandbox-ui-chat.tsx',
      ),
      '@tangle-network/sandbox-ui/hooks': path.join(
        stubs,
        'sandbox-ui-hooks.ts',
      ),
      '@tangle-network/sandbox-ui/utils': path.join(
        stubs,
        'sandbox-ui-utils.ts',
      ),
      '@tangle-network/sandbox-ui': path.join(stubs, 'empty.ts'),
      'framer-motion': path.join(stubs, 'framer-motion.tsx'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    css: false,
  },
});
