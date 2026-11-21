import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: dir,
  plugins: [react()],
  build: {
    outDir: path.join(dir, '..', 'dist'),
    emptyOutDir: true,
  },
  server: {
    proxy: { '/api': 'http://localhost:8080' },
  },
});
