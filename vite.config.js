import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { app, checkEnv } from './server.js';
import { startBackground } from './alerts.js';

export default defineConfig({
  plugins: [
    react(),
    {
      // Serves /auth/* and /api/gh/* from the same dev server: one command, one port, any OS.
      name: 'git-help-api',
      configureServer(server) {
        checkEnv();
        server.middlewares.use(app);
        startBackground(); // overdue checks every 15 min + the Slack Socket Mode listener for replies
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true, // must match the OAuth callback URL
    watch: { ignored: ['**/.data/**'] }, // the local Slack database (slack.js) changes during syncs
  },
});
