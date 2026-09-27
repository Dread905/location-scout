import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' }, // MapLibre's worker is an ES module
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3003',
    },
  },
  build: {
    outDir: 'dist',
  },
});
