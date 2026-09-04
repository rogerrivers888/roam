/**
 * Doors and capabilities: who may enter which application, and what they may do
 * once they are inside.
 *
 * The model is Parcelvision's, which the owner asked Roam to mirror
 * (`backend/app/constants/identity.py`). Three ideas, and the reason each is
 * separate from the others:
 *
 *  - **A door** is which application you may enter: `client` (a household's own
 *    Roam) or `admin` (the back office). Somebody without the admin door is not
 *    shown a refusal — the API answers 404, because a household using Roam has
 *    no business learning that a back office exists.
 *  - **A capability** is what you may do inside. Reading and changing are always
 *    a pair, and the trap PV names in its own docstring is worth repeating: a
 *    capability that "nearly fits" gets borrowed, and then the person who may
 *    invite a friend can also delete a household. A new area declares its own.
 *  - **A role** is a named bundle of both, so an administrator grants "Support"
 *    rather than remembering eleven ticks.
 *
 * Money is its own capability. `view_financials` gates revenue, cost and margin
 * everywhere they appear, and a screen refused by it says so rather than
 * rendering an empty table, which would read as "there is nothing here".
 */

import { roleForAccount } from './repositories/roles.js';

export const DOORS = ['client', 'admin'];

/**
 * Everything anybody can be allowed to do, in the order the roles screen shows
 * them. `area` groups the tick boxes; `manages` marks the ones that change
 * something, which the screen draws differently because granting one is a
 * different kind of decision from granting a read.
 */
export const CAPABILITIES = [
  { key: 'view_accounts', area: 'People', label: 'See accounts', note: 'The list of households, their plan, and when they were last in.' },
  { key: 'manage_accounts', area: 'People', label: 'Manage accounts', note: 'Invite, change a plan or ceiling, suspend, remove.', manages: true },
  { key: 'manage_roles', area: 'People', label: 'Manage roles', note: 'Create roles and grant capabilities — including these.', manages: true },
  { key: 'view_activity', area: 'Behaviour', label: 'See activity', note: 'What a household has done in Roam, and how long they spend in it.' },
  { key: 'view_reporting', area: 'Behaviour', label: 'See reporting', note: 'Engagement, retention and usage across every household.' },
  { key: 'view_financials', area: 'Money', label: 'See financials', note: 'Revenue, what plans earn, and what providers cost.' },
  { key: 'manage_plans', area: 'Money', label: 'Manage plans', note: 'Set what a plan is called, what it costs and what it allows.', manages: true },
  { key: 'view_library', area: 'Atlas', label: 'See the atlas', note: 'The attractions in each county, and the picture library behind them.' },
  { key: 'manage_library', area: 'Atlas', label: 'Manage the atlas', note: 'Run the harvest, publish and hide attractions, approve uploads and delete pictures.', manages: true },
  { key: 'view_audit', area: 'Governance', label: 'See the audit trail', note: 'Who did what to whom, and when.' },
  { key: 'manage_settings', area: 'Governance', label: 'Manage settings', note: 'Providers, sources and estate-wide configuration.', manages: true },
];

export const CAPABILITY_KEYS = new Set(CAPABILITIES.map((c) => c.key));

/** The owner's role holds everything there is, including capabilities added later. */
const ALL = () => CAPABILITIES.map((c) => c.key);

/**
 * What this request may do.
 *
 * Three cases, and the middle one is the reason this function exists rather
 * than a column:
 *
 *  - **the shared passcode** — a session with no account. That is the owner, as
 *    it has been since before accounts existed (auth.js), so it holds every
 *    door and every capability.
 *  - **an account with a role** — its role's doors and capabilities, with the
 *    owner role short-circuiting to everything.
 *  - **an account with no role at all** — a household member. The client door,
 *    and nothing else. This is the default, so an account created by a migration
 *    that has not been given a role cannot see the back office by accident.
 */
export async function accessFor(req) {
  const account = req.account ?? null;
  if (!account) {
    return { doors: DOORS, capabilities: new Set(ALL()), role: { key: 'owner', label: 'Owner', isOwner: true }, isOwner: true };
  }
  const role = account.role_id ? await roleForAccount(account.id) : null;
  // `accounts.role` is the older column and still says 'owner' for the founding
  // account; it is honoured so that claiming the owner account never locks the
  // owner out of the back office he built.
  const isOwner = Boolean(role?.is_owner) || account.role === 'owner';
  if (isOwner) {
    return { doors: DOORS, capabilities: new Set(ALL()), role: role ?? { key: 'owner', label: 'Owner', is_owner: true }, isOwner: true };
  }
  if (!role) return { doors: ['client'], capabilities: new Set(), role: null, isOwner: false };
  return {
    doors: Array.isArray(role.doors) ? role.doors : ['client'],
    capabilities: new Set(role.capabilities ?? []),
    role,
    isOwner: false,
  };
}

/** Attached by `requireSession`, so every route below it can ask without a query. */
export const accessOf = (req) => req.access ?? { doors: ['client'], capabilities: new Set(), isOwner: false, role: null };

export const hasDoor = (req, door) => accessOf(req).doors.includes(door);
export const can = (req, capability) => accessOf(req).capabilities.has(capability);

/**
 * The back office's front door.
 *
 * 404, not 403: somebody who may not enter should not learn there is anything
 * to enter. Every admin route sits behind this before any capability is asked
 * about, so an unauthorised caller cannot map the API by comparing refusals.
 */
export function requireDoor(door) {
  return (req, res, next) => {
    if (hasDoor(req, door)) return next();
    return res.status(404).json({ error: 'not_found', message: 'Not found.' });
  };
}

/**
 * One capability, inside a door already granted.
 *
 * This one *is* a 403 with a name in it, and deliberately: the caller is a
 * colleague who is allowed in the building, and "you do not have permission to
 * see financial figures" is something they can act on — ask for it — where an
 * empty screen would read as "there is no revenue".
 */
export function requires(capability) {
  return (req, res, next) => {
    if (can(req, capability)) return next();
    const known = CAPABILITIES.find((c) => c.key === capability);
    return res.status(403).json({
      error: 'not_permitted',
      capability,
      message: `You do not have permission to ${known ? known.label.toLowerCase() : 'do that'}. Ask an administrator for “${known?.label ?? capability}”.`,
    });
  };
}

/** What the app is told about itself, so it draws only the doors it holds. */
export function accessPayload(req) {
  const access = accessOf(req);
  return {
    doors: access.doors,
    capabilities: [...access.capabilities],
    role: access.role ? { key: access.role.key, label: access.role.label } : null,
    isOwner: access.isOwner,
  };
}
