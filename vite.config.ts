import { defineConfig, loadEnv, type Plugin } from 'vite';
import handler from './api/token.js';

function tokenEndpoint(): Plugin {
  return {
    name: 'ably-token-endpoint',
    configureServer(server) {
      server.middlewares.use('/api/token', (req, res) => {
        handler(req, res).catch((err: unknown) => {
          res.statusCode = 500;
          res.end(String(err));
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (env.ABLY_API_KEY) process.env.ABLY_API_KEY = env.ABLY_API_KEY;
  return { plugins: [tokenEndpoint()] };
});
