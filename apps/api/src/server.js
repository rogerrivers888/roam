import express from 'express';
import cors from 'cors';
import { pool, query } from './db.js';
import householdRoutes from './routes/household.js';
import discoverRoutes from './routes/discover.js';
import tripRoutes from './routes/trips.js';
import planRoutes from './routes/plan.js';
import conceptRoutes from './routes/concepts.js';
import { places as placeRoutes, visits as visitRoutes } from './routes/places.js';
import { atlas as atlasRoutes } from './routes/atlas.js';
import { fetchPhoto } from './sources/google.js';
import { currentHousehold } from './routes/household.js';
import { enabledSources } from './sources/index.js';
import { routingEnabled } from './sources/routing.js';

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
app.use('/api/atlas', atlasRoutes);

/** Licensed review text must not be crawlable (Tripadvisor review implementation policy); the API is not a website. */
app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

/** Which sources are live — the Settings screen shows this. */
app.get('/api/sources', (_req, res) => {
  res.json({
    enabled: enabledSources().map((s) => ({ key: s.key, label: s.label, attribution: s.attribution?.text ?? null })),
    routing: routingEnabled() ? 'google-routes' : 'estimated',
    available: [
      { key: 'google', label: 'Google Places + Routes', env: 'GOOGLE_MAPS_API_KEY' },
      { key: 'tripadvisor', label: 'Tripadvisor', env: 'TRIPADVISOR_API_KEY' },
      { key: 'ticketmaster', label: 'Ticketmaster events', env: 'TICKETMASTER_API_KEY' },
    ].map((a) => ({ ...a, on: enabledSources().some((s) => s.key === a.key) })),
  });
});

/** Google photos are fetched here so the key never reaches the browser; nothing is stored. */
app.get('/api/photos/google', async (req, res) => {
  try {
    const name = String(req.query.name || '');
    if (!/^places\/[^/]+\/photos\/[^/]+$/.test(name)) return res.status(400).end();
    const household = await currentHousehold();
    await query('insert into provider_calls (household_id, provider, purpose) values ($1, $2, $3)', [household.id, 'google-places', 'photo']);
    const photo = await fetchPhoto(name, Math.min(1200, Number(req.query.w) || 480));
    if (!photo) return res.status(404).end();
    res.setHeader('content-type', photo.contentType);
    res.setHeader('cache-control', 'private, max-age=3600');
    res.send(photo.body);
  } catch (err) {
    res.status(502).json({ error: 'photo_unavailable', message: err.message });
  }
});

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
