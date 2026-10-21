import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 除 core 单测外，也覆盖桌面端主进程的纯逻辑（SSRF 校验、m3u8 改写等）
    include: ['packages/**/*.test.ts', 'apps/desktop/src/main/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
