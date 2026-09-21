import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // 当前只测试纯逻辑模块（lib / hooks 的纯函数）。
    // 若将来要测 React 组件，需改装 jsdom 并补 jsdom 依赖。
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
  },
});
