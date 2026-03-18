/**
 * Express app entry: static assets, API routes, and request-scoped telemetry context.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { router } from './routes/api.js';
import { logger } from './lib/logger.js';
import { getDb } from './lib/db.js';
import { hasPostgresConfig } from './lib/postgres.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, _res, next) => {
  req.requestId = uuidv4();
  req.traceId = uuidv4();
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', router);

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

if (!hasPostgresConfig()) {
  getDb(); // Ensure SQLite DB and migrations are ready in fallback mode.
}
app.listen(PORT, () => {
  logger.info('VibeRegress running', { port: PORT, url: `http://localhost:${PORT}` });
});
