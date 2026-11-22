import { defineConfig } from 'vite';

// Прокси для облачных сервисов (обход CORS при работе в браузере).
const proxy = {
  '/api/stability': {
    target: 'https://api.stability.ai',
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api\/stability/, ''),
  },
  '/api/topaz': {
    target: 'https://api.topazlabs.com',
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api\/topaz/, ''),
  },
};

export default defineConfig({
  server: { port: 5178, strictPort: true, proxy },
  preview: { port: 5178, proxy },
  build: { target: 'es2022' },
});
