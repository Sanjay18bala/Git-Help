// Production server: the built frontend (`npm run build`), the API from server.js, and the background job that
// sends overdue alerts and digests. Run with `npm start`; the Dockerfile runs this too.
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, checkEnv } from './server.js';
import { startBackground } from './alerts.js';

checkEnv();
const dist = join(dirname(fileURLToPath(import.meta.url)), 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('No frontend build found. Run `npm run build` first.');
  process.exit(1);
}

const appUrl = process.env.APP_URL ?? 'http://localhost:5173';
const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(appUrl);
const port = Number(process.env.PORT || new URL(appUrl).port || 5173);
const host = process.env.HOST || (local ? '127.0.0.1' : '0.0.0.0'); // local: not reachable from the network

const server = express();
server.disable('x-powered-by');
server.use(app);
server.use('/assets', express.static(join(dist, 'assets'), { immutable: true, maxAge: '1y' })); // hashed file names
server.use(express.static(dist, { index: false }));
// Every other GET is a client-side route (/repos/…, /attention, /settings): serve the app.
server.use((req, res, next) => (req.method === 'GET' ? res.sendFile(join(dist, 'index.html')) : next()));

server.listen(port, host, () => console.log(`GitHelp is running at ${appUrl}`));
startBackground();
