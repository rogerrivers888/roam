import express from 'express';
import { perSearchCost } from './sources/pricing.js';
import { usageBetween, windows } from './sources/usage.js';
import cors from 'cors';
import { ping, pool } from './db.js';
import householdRoutes from './routes/household.js';
import discoverRoutes from './routes/discover.js';
import tripRoutes from './routes/trips.js';
import journeyRoutes from './routes/journey.js';
import planRoutes from './routes/plan.js';
import tasteRoutes from './routes/tastes.js';
import conceptRoutes from './routes/concepts.js';
import prototypeRoutes from './routes/prototypes.js';
import groupRoutes, { startReminderLoop } from './routes/groups.js';
import accountRoutes from './routes/accounts.js';
import adminRoutes from './routes/admin.js';
import { adminRouter as libraryAdminRoutes, atlasRouter as libraryAtlasRoutes, imageRouter as libraryImageRoutes } from './routes/library.js';
import { router as localityRoutes } from './routes/localities.js';
import { resumeInterrupted } from './sources/harvest.js';
import activityRoutes from './routes/activity.js';
import { places as placeRoutes, visits as visitRoutes } from './routes/places.js';
import { atlas as atlasRoutes } from './routes/atlas.js';
import { inspire as inspireRoutes } from './routes/inspire.js';
import { menu as menuRoutes, orders as orderRoutes } from './routes/menus.js';
import { offline as offlineRoutes } from './routes/offline.js';
import { startOwnLoop } from './sources/own.js';
import scoutRoutes, { areaRouter } from './routes/scout.js';
import shelfRoutes from './routes/shelves.js';
import { startScoutLoop } from './sources/scoutArea.js';
import { photoFor } from './sources/google.js';
import { currentHousehold } from './routes/household.js';
import { SCOUT_MONTHLY_RUNS } from './sources/localscout.js';
import { enabledSources, defaultSourceKeys, loadSourceSettings, setSourceOff, sourceHasKey, sourceOff, sourceKeys, bedRatesOn } from './sources/index.js';
import { routingEnabled } from './sources/routing.js';
import sessionRoutes, { devices as deviceRoutes } from './routes/session.js';
import { authConfigured, deployed, originAllowed, requireSession } from './auth.js';
import { requireDoor } from './access.js';
import { generalLimit, signInLimit, spendLimit } from './limits.js';
import { sweepDeadSessions } from './repositories/sessions.js';
import { sweepExpiredPlanSessions } from './repositories/planSessions.js';
import * as providerCalls from './repositories/providerCalls.js';

const app = express();

// Railway terminates TLS in front of this process, so `req.ip` is the proxy
// unless we say so — and every rate limit here counts per caller.
app.set('trust proxy', 1);

// JSON API only — no templates, no static assets, no server-rendered HTML.
// The web app is a separate Expo workspace that talks to this over HTTP.
app.use(express.json({ limit: '1mb' })); // member photos travel as data URLs
// `credentials` is on so the sign-in response can set the session cookie, which
// exists only for the two GETs that cannot carry a header (auth.js). Which
// origins may do that is `ROAM_WEB_ORIGIN`; unset, this behaves as it always
// did and the passcode is the only guard.
app.use(cors({ origin: (origin, cb) => cb(null, originAllowed(origin)), credentials: true }));

app.get('/health', async (_req, res) => {
  try {
    await ping();
    // Which build answered: Railway sets the commit on the deployment, so
    // "is my change live yet" is a question the API can answer itself.
    // `auth` is reported because an API that is not asking for a passcode is a
    // fact the owner needs to be able to see without reading the logs.
    res.json({
      ok: true, service: 'roam-api', db: 'up',
      commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      auth: authConfigured() ? 'on' : 'not-configured',
    });
  } catch (err) {
    res.status(503).json({ ok: false, service: 'roam-api', db: 'down', error: err.message });
  }
});

// --- the door ---------------------------------------------------------------
// Everything below `requireSession` needs a session; everything above is the
// short list in auth.js that does not (the door itself, health, and the group
// invite link, which is somebody else's credential).
app.use(generalLimit);
// Only the attempt is held to ten a quarter-hour. Asking "am I signed in" is
// what the app does on every load and is not a guess at anything.
app.post('/api/session', signInLimit);
app.use('/api', sessionRoutes);

// The atlas image library, outside the door on purpose (routes/library.js):
// open-licence photographs we hold and are entitled to redistribute, answered
// with a year of immutable caching so a card's second view never gets here.
app.use('/api/images', libraryImageRoutes);

app.use(requireSession);
// Which devices are signed in is the household's business, so it is mounted on
// this side of the door rather than with the sign-in verbs.
app.use('/api', deviceRoutes);

// Provider money is spent under these, so they are held to a tighter number
// than the rest of the API (limits.js).
for (const path of ['/api/discover', '/api/plan', '/api/atlas', '/api/menu', '/api/photos', '/api/places']) app.use(path, spendLimit);

// The back office, behind the admin door (access.js). `requireDoor` answers 404
// rather than 403, so a household using Roam never learns any of it is there;
// each route inside then names the capability it needs.
//
// Mounted before the household routes so nothing about other people's accounts
// can be reached through a path that resolves to the caller's own household.
app.use('/api/accounts', requireDoor('admin'), accountRoutes);
app.use('/api/admin', requireDoor('admin'), adminRoutes);
app.use('/api/admin/scout', requireDoor('admin'), scoutRoutes);
app.use('/api/admin/library', requireDoor('admin'), libraryAdminRoutes);
app.use('/api/admin/shelves', requireDoor('admin'), shelfRoutes);
app.use('/api/admin/places', requireDoor('admin'), localityRoutes);

// Telemetry is the household's own — which screen, and still here — and is
// always written against the session's own household (routes/activity.js).
app.use('/api', activityRoutes);

app.use('/api/household', householdRoutes);
app.use('/api/discover', discoverRoutes);
app.use('/api/trips', journeyRoutes);
app.use('/api/trips', tripRoutes);
// The family's table (/api/plan/tastes…) is mounted first: the planner's own
// router ends in a catch-all GET /:sessionId that would swallow these paths.
app.use('/api/plan', tasteRoutes);
app.use('/api/plan', planRoutes);
// The home screen's one read. Mounted after the planner because it borrows
// the planner's look-around, not its paths.
app.use('/api/inspire', inspireRoutes);
app.use('/api/concepts', conceptRoutes);
app.use('/api/prototypes', prototypeRoutes);
app.use('/api/places', placeRoutes);
app.use('/api/places', areaRouter);
app.use('/api/visits', visitRoutes);
// The gazetteer reads come first: `atlasRoutes` ends in patterns that would
// otherwise swallow /regions.
app.use('/api/atlas', libraryAtlasRoutes);
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
      // Not a place search: it prices beds on the Stay tab and never runs
      // inside a browse (sources/index.js ASIDE).
      { key: 'liteapi', label: 'LiteAPI hotel rates (Stay tab)', env: 'LITEAPI_KEY' },
    ].map((a) => ({ ...a, on: a.key === 'liteapi' ? bedRatesOn() : live.some((s) => s.key === a.key), hasKey: sourceHasKey(a.key), off: sourceOff(a.key), optIn: Boolean(live.find((s) => s.key === a.key)?.optIn) })),
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
// How long a device may hold a provider's photograph. The owner set ten hours
// (ROAM_PHOTO_CACHE_SECONDS moves it without a deploy).
const PHOTO_CACHE_SECONDS = Number(process.env.ROAM_PHOTO_CACHE_SECONDS || 36_000);

app.get('/api/photos/google', async (req, res) => {
  try {
    const name = String(req.query.name || '');
    if (!/^places\/[^/]+\/photos\/[^/]+$/.test(name)) return res.status(400).end();
    const household = await currentHousehold();
    const photo = await photoFor(name, Math.min(1200, Number(req.query.w) || 480));
    if (!photo) return res.status(404).json({ error: 'no_photo', message: 'The provider has no photo by that name.' });
    if (!photo.cached) {
      await providerCalls.record(household.id, 'google-places', 'photo', { 'google-photos': 1 }).catch(() => null);
    }
    res.setHeader('content-type', photo.contentType);
    // Ten hours, the owner's decision (4 Sep 2026: "you can persist them for 10
    // hours"), so reopening the app shows the pictures it already had rather
    // than fetching every one again. Private: one browser's own copy, never a
    // shared cache, and it falls out of the browser by itself.
    res.setHeader('cache-control', `private, max-age=${PHOTO_CACHE_SECONDS}`);
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

// Say out loud which state the door is in. A deployed API with no passcode set
// serves nothing (auth.js) — that is deliberate, and it must be obvious in the
// logs why, rather than looking like the database is down.
if (authConfigured()) {
  console.log(deployed() ? 'roam-api: passcode set; sessions last 90 days' : "roam-api: local passcode 'roam-dev' (ROAM_PASSCODE overrides)");
} else {
  console.warn('roam-api: ROAM_PASSCODE is not set. Every /api request will answer 503 until the owner adds it in Doppler.');
}
// Two sweeps, once on start and then daily.
//
// Expired and revoked API sessions are a hash and two dates, but they are not
// needed either. Expired *planning* sessions matter more: their state holds the
// provider's venue names and ratings, migration 026 gave them ten hours for
// that reason, and until now nothing ever actually deleted one.
const sweep = async () => {
  await sweepDeadSessions().catch(() => null);
  const plans = await sweepExpiredPlanSessions().catch(() => null);
  if (plans) console.log(`roam-api: swept ${plans} expired planning session(s)`);
};
void sweep();
setInterval(() => { void sweep(); }, 24 * 3600_000).unref?.();

// The owned place layer researches in the background: anything a household has
// claimed but that has not been looked at yet, and the sweep that discards any
// fact whose licence has run out (sources/own.js).
startOwnLoop();
// The sweep: one area at a time, then the menus it claimed (sources/scoutArea.js).
startScoutLoop();
// Roam chases the group, the organiser does not (owner, 4 Sep 2026): any run
// whose morning has passed is written once, whether or not anyone is looking.
startReminderLoop();
// A harvest of the atlas cannot survive a restart, and this process restarting
// is exactly what has just happened. Anything the last one left saying
// "running" is closed out, and — if it had regions still to reach — the work is
// picked back up, because four hours of harvesting inside a web server would
// otherwise never finish on a repository where somebody deploys every hour
// (sources/harvest.js).
//
// Deliberately not at boot. A job that begins the moment the process starts is
// a job that is implicated in every failure to start, and there is no way to
// tell those apart from the outside — so it waits until this process has been
// up and answering for a minute. If the container is going to fall over, it
// falls over first, on its own, with nothing of ours in the frame.
const RESUME_AFTER_MS = Number(process.env.ROAM_HARVEST_RESUME_DELAY_MS || 60_000);
// And then again every few minutes, for as long as this process is up. Deploys
// in this tree land minutes apart, and a resume that gets a single attempt will
// sooner or later spend it inside somebody else's deploy — which is exactly
// what happened, and left ninety-five counties unharvested with nothing due to
// ask again (sources/harvest.js).
const RESUME_EVERY_MS = Number(process.env.ROAM_HARVEST_RESUME_EVERY_MS || 5 * 60_000);
const tryResume = (atBoot) => resumeInterrupted({ atBoot })
  .then((r) => { if (r?.resumed || (atBoot && r)) console.log(`roam-api: harvest ${r.resumed ? `resumed over ${r.regions} region(s)` : `not resumed — ${r.reason}`}`); })
  .catch((err) => console.error('harvest recovery', err.message));
setTimeout(() => { void tryResume(true); }, RESUME_AFTER_MS).unref?.();
setInterval(() => { void tryResume(false); }, RESUME_EVERY_MS).unref?.();
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`roam-api listening on 0.0.0.0:${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}

export default app;
