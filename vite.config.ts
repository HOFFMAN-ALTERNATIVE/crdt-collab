import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: './',
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: { port: 5173 },
});
