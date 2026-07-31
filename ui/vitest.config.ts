import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/__tests__/setup.ts'],
  },
  resolve: {
    conditions: ['development', 'browser'],
    alias: {
      // Mirror SolidStart's `~` → src/ alias so components that use it
      // (e.g. AllGraphTab → ~/lib/turn-utils) are importable from tests.
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
