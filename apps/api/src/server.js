import express from 'express';
import cors from 'cors';
import { pool, query } from './db.js';
import householdRoutes from './routes/household.js';
import discoverRoutes from './routes/discover.js';
import tripRoutes from './routes/trips.js';
import planRoutes from './routes/plan.js';
import conceptRoutes from './routes/concepts.js';
import { places as placeRoutes, visits as visitRoutes } from './routes/places.js';

const app = express();

// JSON API only — no templates, no static assets, no server-rendered HTML.
// The web app is a separate Expo workspace that talks to this over HTTP.
app.use(express.json({ limit: '1mb' })); // member photos travel as data URLs
app.use(cors({ origin: true }));

app.get('/health', async (_req, res) => {
  try {
    await query('select 1');
    res.json({ ok: true, service: 'roam-api', db: 'up' });
  } catch (err) {
    res.status(503).json({ ok: false, service: 'roam-api', db: 'down', error: err.message });
  }
});

app.use('/api/household', householdRoutes);
app.use('/api/discover', discoverRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/plan', planRoutes);
app.use('/api/concepts', conceptRoutes);
app.use('/api/places', placeRoutes);
app.use('/api/visits', visitRoutes);

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.code || 'internal_error', message: err.message });
});

const port = Number(process.env.PORT) || 4000;
// 0.0.0.0 rather than localhost: the container/platform decides the interface.
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`roam-api listening on 0.0.0.0:${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}

export default app;
