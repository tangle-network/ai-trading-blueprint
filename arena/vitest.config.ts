import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import path from 'node:path';

const stubs = path.resolve(__dirname, 'src/test/stubs');

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // Linked packages have broken transitive deps in their node_modules.
      // Alias to lightweight stubs that provide the same exports.
      '@tangle/blueprint-ui/components': path.join(stubs, 'blueprint-ui-components.tsx'),
      '@tangle/blueprint-ui': path.join(stubs, 'blueprint-ui.ts'),
      '@tangle/agent-ui': path.join(stubs, 'empty.ts'),
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
