import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5199, strictPort: true },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1200 },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // plugin registries use import.meta.glob: a cached registry module would miss newly added plugins
    fsModuleCache: false,
  },
} as any);
