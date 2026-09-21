import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // 单元测试只覆盖不依赖 NestJS DI 反射的纯逻辑模块。
    // server/tsconfig.json 开启了 emitDecoratorMetadata，esbuild 不支持该选项，
    // 但纯逻辑测试不需要它，因此这里不做额外配置。
  },
});
