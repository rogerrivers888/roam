import express from 'express';
import { perSearchCost } from './sources/pricing.js';
import { usageBetween, windows } from './sources/usage.js';
import cors from 'cors';
import { pool, query } from './db.js';
import householdRoutes from './routes/household.js';
import discoverRoutes from './routes/discover.js';
import tripRoutes from './routes/trips.js';
import journeyRoutes from './routes/journey.js';
import planRoutes from './routes/plan.js';
import tasteRoutes from './routes/tastes.js';
import conceptRoutes from './routes/concepts.js';
import prototypeRoutes from './routes/prototypes.js';
import groupRoutes, { startReminderLoop } from './routes/groups.js';
import { places as placeRoutes, visits as visitRoutes } from './routes/places.js';
import { atlas as atlasRoutes } from './routes/atlas.js';
import { menu as menuRoutes, orders as orderRoutes } from './routes/menus.js';
import { offline as offlineRoutes } from './routes/offline.js';
import { startOwnLoop } from './sources/own.js';
import { photoFor } from './sources/google.js';
import { currentHousehold } from './routes/household.js';
import { SCOUT_MONTHLY_RUNS } from './sources/localscout.js';
import { enabledSources, defaultSourceKeys, loadSourceSettings, setSourceOff, sourceHasKey, sourceOff, sourceKeys } from './sources/index.js';
import { routingEnabled } from './sources/routing.js';

const app = express();

// JSON API only — no templates, no static assets, no server-rendered HTML.
// The web app is a separate Expo workspace that talks to this over HTTP.
app.use(express.json({ limit: '1mb' })); // member photos travel as data URLs
app.use(cors({ origin: true }));

app.get('/health', async (_req, res) => {
  try {
    await query('select 1');
    // Which build answered: Railway sets the commit on the deployment, so
    // "is my change live yet" is a question the API can answer itself.
    res.json({ ok: true, service: 'roam-api', db: 'up', commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null });
  } catch (err) {
    res.status(503).json({ ok: false, service: 'roam-api', db: 'down', error: err.message });
  }
});

app.use('/api/household', householdRoutes);
app.use('/api/discover', discoverRoutes);
app.use('/api/trips', journeyRoutes);
app.use('/api/trips', tripRoutes);
// The family's table (/api/plan/tastes…) is mounted first: the planner's own
// router ends in a catch-all GET /:sessionId that would swallow these paths.
app.use('/api/plan', tasteRoutes);
app.use('/api/plan', planRoutes);
app.use('/api/concepts', conceptRoutes);
app.use('/api/prototypes', prototypeRoutes);
app.use('/api/places', placeRoutes);
app.use('/api/visits', visitRoutes);
app.use('/api/atlas', atlasRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/offline', offlineRoutes);
// Group trips: the organiser's door (/api/trips/:id/group, /api/groups/…) and
// the invite link's (/api/join/:token), which shows a checklist and no roster.
app.use('/api', groupRoutes);

/** Licensed review text must not be crawlable (Tripadvisor review implementation policy); the API is not a website. */
app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

/** Which sources are live — the Settings screen shows this. */
app.get('/api/sources', async (_req, res, next) => {
  try {
  // Opt-in sources (Tripadvisor) are live but only run when a search names them; report how often that has happened.
  const live = enabledSources({ includeOptIn: true });
  const household = await currentHousehold();
  const w = await windows();
  const [all, month] = await Promise.all([usageBetween(household.id), usageBetween(household.id, w.month_start, w.next_month_start)]);
  const ta = { all: all.lines.tripadvisor, month: month.lines.tripadvisor };
  // What one search costs on each source, so the picker can say it before the
  // search runs. The scout's figure is measured from this month's runs.
  const scout = month.lines.scout;
  const cost = perSearchCost({ scoutAvgUsd: scout?.calls ? scout.costUsd / scout.calls : null });
  res.json({
    cost,
    enabled: live.map((s) => ({ key: s.key, label: s.label, attribution: s.attribution?.text ?? null, optIn: Boolean(s.optIn) })),
    routing: routingEnabled() ? 'google-routes' : 'estimated',
    defaults: defaultSourceKeys(),
    usage: { tripadvisor: { searchesAllTime: ta.all?.calls ?? 0, searchesThisMonth: ta.month?.calls ?? 0, locationsAllTime: Math.round(ta.all?.units ?? 0), locationsFree: 1000 } },
    available: [
      { key: 'google', label: 'Google Places + Routes', env: 'GOOGLE_MAPS_API_KEY' },
      { key: 'tripadvisor', label: 'Tripadvisor', env: 'TRIPADVISOR_API_KEY' },
      { key: 'ticketmaster', label: 'Ticketmaster events', env: 'TICKETMASTER_API_KEY' },
      { key: 'seatgeek', label: 'SeatGeek events', env: 'SEATGEEK_CLIENT_ID' },
      { key: 'predicthq', label: 'PredictHQ events (incl. community)', env: 'PREDICTHQ_API_KEY' },
      { key: 'datathistle', label: 'Data Thistle UK listings', env: 'DATATHISTLE_API_KEY' },
      { key: 'scout', label: 'Local scout (Claude reads local what\'s-on pages)', env: 'ROAM_LOCAL_SCOUT=on' },
    ].map((a) => ({ ...a, on: live.some((s) => s.key === a.key), hasKey: sourceHasKey(a.key), off: sourceOff(a.key), optIn: Boolean(live.find((s) => s.key === a.key)?.optIn) })),
  });
  } catch (err) {
    next(err);
  }
});

/**
 * Switch a live source off or back on from Settings › Providers. Non-secret
 * configuration: the key stays where it is; a source without one cannot be
 * switched on from here.
 */
app.patch('/api/sources/:key', async (req, res, next) => {
  try {
    const key = String(req.params.key);
    if (!sourceKeys().includes(key)) return res.status(404).json({ error: 'unknown_source' });
    const on = Boolean(req.body?.on);
    if (on && !sourceHasKey(key)) return res.status(409).json({ error: 'no_key', message: 'This source has no key yet; the owner adds it through Doppler.' });
    const off = await setSourceOff(key, !on);
    res.json({ key, on: on && sourceHasKey(key), off });
  } catch (err) {
    next(err);
  }
});

/**
 * Google photos are fetched here so the key never reaches the browser, and
 * nothing is written down: a photo already fetched is held in memory for an
 * hour (sources/google.js) and dies with the process.
 *
 * The provider call is recorded only when Google was actually asked. Billing
 * for a picture we already had would misreport the spend, and the whole point
 * of holding it is that we stopped asking.
 */
app.get('/api/photos/google', async (req, res) => {
  try {
    const name = String(req.query.name || '');
    if (!/^places\/[^/]+\/photos\/[^/]+$/.test(name)) return res.status(400).end();
    const household = await currentHousehold();
    const photo = await photoFor(name, Math.min(1200, Number(req.query.w) || 480));
    if (!photo) return res.status(404).json({ error: 'no_photo', message: 'The provider has no photo by that name.' });
    if (!photo.cached) {
      await query('insert into provider_calls (household_id, provider, purpose, units) values ($1, $2, $3, $4)', [household.id, 'google-places', 'photo', { 'google-photos': 1 }]).catch(() => null);
    }
    res.setHeader('content-type', photo.contentType);
    res.setHeader('cache-control', 'private, max-age=3600');
    res.send(photo.body);
  } catch (err) {
    // The status the provider gave, so a quota that has run out reads as one.
    console.error('photo', err.message);
    res.status(err.status === 403 || err.status === 429 ? 429 : 502).json({ error: 'photo_unavailable', message: err.message });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.code || 'internal_error', message: err.message });
});

const port = Number(process.env.PORT) || 4000;
// 0.0.0.0 rather than localhost: the container/platform decides the interface.
await loadSourceSettings();
// The owned place layer researches in the background: anything a household has
// claimed but that has not been looked at yet, and the sweep that discards any
// fact whose licence has run out (sources/own.js).
startOwnLoop();
// Roam chases the group, the organiser does not (owner, 4 Sep 2026): any run
// whose morning has passed is written once, whether or not anyone is looking.
startReminderLoop();
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`roam-api listening on 0.0.0.0:${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}

export default app;
