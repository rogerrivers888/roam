import { Router } from 'express';
import * as households from '../repositories/households.js';
import { ALLERGENS, matchConcepts, resolveConcept, conceptByKey, isNegated } from '../domain/concepts.js';

const NEGATION_PREFIX = /^(not|no|never|without|anything but|nothing)\s+/i;
import { geocode } from '../sources/geocode.js';
import { LINES, legacyLines, perSearchCost } from '../sources/pricing.js';
import { usageBetween, allowanceUsage, usageByMonth } from '../sources/usage.js';
import { enabledSources, bedRatesOn } from '../sources/index.js';
import { routingEnabled } from '../sources/routing.js';
import { paceOf, DEFAULT_PACE } from '../domain/pace.js';
import { isValidTimezone } from '../domain/time.js';
import { currentAccount } from '../context.js';
import {
  accountByEmail, accountByMember, accountByMobile, accountsForHousehold, createAccountOnHousehold,
  createSignInLink, deleteAccount, lastLinkFor, markLinkSent, normaliseEmail, ownerAccount,
  revokeAccountSessions, updateAccount,
} from '../repositories/accounts.js';
import { householdInvitationEmail, mailStatus, sendMail, webUrl } from '../sources/mail.js';
import { invitationText, normaliseMobile, prettyMobile, sendSms, smsStatus } from '../sources/sms.js';

const router = Router();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const RELATIONSHIPS = ['parent', 'partner', 'child', 'grandparent', 'sibling', 'friend', 'other'];
const KINDS = ['allergen', 'diet', 'dislike', 'like'];
export const LEARN_THRESHOLD = Number(process.env.ROAM_LEARN_THRESHOLD || 3);
const HALF_LIFE_DAYS = Number(process.env.ROAM_LEARN_HALF_LIFE_DAYS || 180);

/**
 * Whose household this request is about — the one seam every read and write in
 * the API goes through, all 86 of them.
 *
 * It used to be "the first row in the table", which was true while Roam was one
 * family's app and became a way to serve one household's data to another the
 * moment it was not. It now answers from the account the request is being
 * served as (context.js, set by `requireSession` in auth.js), and falls back to
 * the founding household for the two callers that legitimately have no account:
 * the owner's shared passcode, and work that runs outside any request — the
 * seed script, the reminder sweep.
 *
 * The fallback is the part to be careful with. It is safe only because nothing
 * reaches here without having passed the door first. A route added to `PUBLIC`
 * in auth.js must resolve its household explicitly — as the group invite link
 * does through `householdOf` — rather than inheriting the founding one.
 */
export async function currentHousehold() {
  const account = currentAccount();
  if (account) {
    const household = await households.householdById(account.household_id);
    if (household) return household;
    // An account whose household was deleted underneath it. Falling back to
    // the founding household here is the one thing that must never happen.
    const err = new Error('This account has no household.');
    err.status = 404;
    err.code = 'no_household';
    throw err;
  }
  const household = await households.firstHousehold();
  if (!household) {
    const err = new Error('No household exists. Run `npm run seed`.');
    err.status = 404;
    err.code = 'no_household';
    throw err;
  }
  return household;
}

/**
 * One named household, for work that knows which one it is about and must not
 * guess: a group's invite link (public, so no account is in the air) and the
 * reminder sweep (which walks every household there is).
 */
export const householdOf = (householdId) => households.householdById(householdId);

const ageOf = (birthYear) => (birthYear ? new Date().getFullYear() - birthYear : null);
/** Exact age from a birthday, else a rough one from the year. */
function ageFrom(birthDate, birthYear) {
  if (birthDate) {
    const b = new Date(birthDate);
    const now = new Date();
    let age = now.getFullYear() - b.getFullYear();
    if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age -= 1;
    return age;
  }
  return ageOf(birthYear);
}

export async function loadMembers(householdId) {
  const rows = await households.membersWithConstraints(householdId);

  return rows.map((row) => {
    const age = ageFrom(row.birth_date, row.birth_year);
    return {
      id: row.id,
      name: row.name,
      isMinor: age != null ? age < 13 : row.is_minor,
      age,
      birthYear: row.birth_year,
      birthDate: row.birth_date,
      relationship: row.relationship,
      avatarUrl: row.avatar_url,
      // How to reach them, so the Household tab can invite them (migration 056).
      email: row.email ?? null,
      mobile: row.mobile ?? null,
      typicalVisitMinutes: row.typical_visit_minutes,
      maxTravelMinutes: row.max_travel_minutes,
      allergens: row.constraints.filter((c) => c.kind === 'allergen'),
      diets: row.constraints.filter((c) => c.kind === 'diet'),
      dislikes: row.constraints.filter((c) => c.kind === 'dislike'),
      likes: row.constraints.filter((c) => c.kind === 'like'),
    };
  });
}

/** Members flattened for the ranking layer. */
export function toAttendees(members) {
  const pref = (c) => ({ value: c.value, conceptKey: c.conceptKey ?? null, maxMinutes: c.maxMinutes ?? null, favourite: Boolean(c.favourite) });
  return members.map((m) => ({
    id: m.id,
    name: m.name,
    isMinor: m.isMinor,
    allergens: m.allergens.map((c) => c.value),
    diets: m.diets.map(pref),
    dislikes: m.dislikes.map(pref),
    likes: m.likes.map(pref),
  }));
}

/**
 * What the household's ratings say, per member per concept, with recency
 * weighting and a confidence threshold (Requirements §5 "Preference confidence").
 */
export async function loadLearnedPreferences(householdId) {
  const rows = await households.conceptRatings(householdId);
  const now = Date.now();
  const acc = new Map();
  for (const r of rows) {
    const days = (now - new Date(r.visited_on).getTime()) / 86_400_000;
    const weight = Math.pow(0.5, Math.max(0, days) / HALF_LIFE_DAYS);
    const key = `${r.member_id}|${r.concept_key}`;
    const a = acc.get(key) ?? { memberId: r.member_id, name: r.name, conceptKey: r.concept_key, count: 0, net: 0, lastOn: r.visited_on };
    a.count += 1;
    a.net += r.take === 'loved' ? weight : r.take === 'not_for_me' ? -weight : 0;
    if (r.visited_on > a.lastOn) a.lastOn = r.visited_on;
    acc.set(key, a);
  }
  return [...acc.values()]
    .filter((a) => Math.abs(a.net) > 0.05)
    .map((a) => ({
      ...a,
      kind: a.net > 0 ? 'like' : 'dislike',
      confirmed: a.count >= LEARN_THRESHOLD,
      threshold: LEARN_THRESHOLD,
      label: conceptByKey(a.conceptKey)?.label ?? a.conceptKey,
      conceptKind: conceptByKey(a.conceptKey)?.kind ?? null,
      net: Number(a.net.toFixed(2)),
    }))
    .sort((x, y) => y.count - x.count);
}

function kindsFor(constraintKind) {
  if (constraintKind === 'diet') return ['diet'];
  if (constraintKind === 'allergen') return null;
  return ['dish', 'cuisine', 'ingredient', 'style', 'experience'];
}

router.get('/', async (_req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    // Who among them can sign in, and what happened to the last link each was
    // sent. One query for everybody rather than one per person: the Household
    // tab draws the whole family at once.
    const access = await accessForMembers(await households.membersWithConstraints(household.id));
    for (const m of members) m.access = access.get(m.id) ?? null;
    res.json({
      household: {
        id: household.id,
        name: household.name,
        defaultVisitMinutes: household.default_visit_minutes,
        maxTravelMinutes: household.max_travel_minutes,
        defaultIntensity: household.default_intensity,
        home: household.home_lat != null ? { label: household.home_label, lat: household.home_lat, lng: household.home_lng } : null,
        homeRadiusMiles: household.home_radius_miles ?? 10,
        homePhotoUrl: household.home_photo_url ?? null,
        pace: paceOf(household),
        timezone: household.timezone,
      },
      members,
      learned: await loadLearnedPreferences(household.id),
      vocabulary: { allergens: ALLERGENS, relationships: RELATIONSHIPS },
      // Whether an invitation can actually be delivered, and if not, why. The
      // answer to "why did that not send" belongs on the screen that tried to
      // send it — the same rule the admin screen keeps for mail.
      senders: { sms: smsStatus(), email: mailStatus() },
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { name, defaultVisitMinutes, maxTravelMinutes, defaultIntensity, home, homeText, pace, timezone, homeRadiusMiles, homePhotoUrl } = req.body;
    // How far "close to home" reaches, in miles (owner, 4 Sep 2026).
    const radius = homeRadiusMiles == null ? null : Math.min(200, Math.max(1, Math.round(Number(homeRadiusMiles))));
    if (homeRadiusMiles != null && !Number.isFinite(radius)) return res.status(400).json({ error: 'invalid_radius' });
    if (timezone && !isValidTimezone(timezone)) return res.status(400).json({ error: 'invalid_timezone' });
    // The picture of home is the household's own photograph, taken on their
    // device and sent as a data URI — the same way a person's face arrives. A
    // link to somewhere else would be a picture we do not hold and cannot show
    // when the signal goes, so only a data URI is stored; '' takes it down.
    const photo = homePhotoUrl == null ? null : String(homePhotoUrl);
    if (photo && photo !== '' && !/^data:image\/(jpeg|png|webp);base64,/.test(photo)) return res.status(400).json({ error: 'invalid_photo', message: 'A picture of home must be an image from this device.' });
    if (photo && photo.length > 4_000_000) return res.status(413).json({ error: 'photo_too_large', message: 'That picture is too big. Try a smaller one.' });
    const mergedPace = pace ? { food: { ...paceOf(household).food, ...(pace.food || {}) }, activity: { ...paceOf(household).activity, ...(pace.activity || {}) } } : null;
    // Home may arrive as a picked place or as typed text to geocode (Epic 3 M3).
    let homePlace = home?.lat != null ? home : null;
    if (!homePlace && homeText?.trim()) [homePlace] = await geocode(homeText, { limit: 1 });
    if (homeText?.trim() && !homePlace) return res.status(404).json({ error: 'home_not_found', message: `Couldn't find "${homeText}". Try a fuller address or a town name.` });
    // Home moving country is what makes a city search change which country it
    // puts first, so the country follows the coordinates rather than merging.
    const h = await households.updateHousehold(household.id, {
      name, defaultVisitMinutes, maxTravelMinutes, defaultIntensity,
      homeLabel: homePlace?.label, homeLat: homePlace?.lat, homeLng: homePlace?.lng,
      homeCountryCode: homePlace?.countryCode, homeCountry: homePlace?.country,
      pace: mergedPace, timezone, homeRadiusMiles: radius, homePhotoUrl: photo,
    });
    res.json({ household: { id: h.id, name: h.name, defaultVisitMinutes: h.default_visit_minutes, maxTravelMinutes: h.max_travel_minutes, defaultIntensity: h.default_intensity,
      home: h.home_lat != null ? { label: h.home_label, lat: h.home_lat, lng: h.home_lng } : null, homeRadiusMiles: h.home_radius_miles ?? 10,
      homePhotoUrl: h.home_photo_url ?? null, pace: paceOf(h), timezone: h.timezone } });
  } catch (err) {
    next(err);
  }
});

router.post('/members', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { name, relationship = null, birthYear = null, birthDate = null, avatarUrl = null, typicalVisitMinutes, maxTravelMinutes, email = null, mobile = null } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name_required' });
    if (email && !EMAIL.test(email)) return res.status(400).json({ error: 'invalid_email', message: 'That does not look like an e-mail address.' });
    const number = mobile ? normaliseMobile(mobile) : null;
    if (mobile && !number) return res.status(400).json({ error: 'invalid_mobile', message: `“${mobile}” does not look like a mobile number. A UK one starts 07, or +44.` });
    if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return res.status(400).json({ error: 'invalid_birth_date', message: 'Use YYYY-MM-DD' });
    if (relationship && !RELATIONSHIPS.includes(relationship)) return res.status(400).json({ error: 'invalid_relationship' });
    const age = ageFrom(birthDate, birthYear);
    const member = await households.insertMember(household.id, {
      name: name.trim(),
      isMinor: age != null ? age < 13 : relationship === 'child',
      relationship,
      birthYear: birthYear ?? (birthDate ? Number(birthDate.slice(0, 4)) : null),
      birthDate, avatarUrl, typicalVisitMinutes, maxTravelMinutes,
      email, mobile: number,
    });
    res.status(201).json({ member });
  } catch (err) {
    next(err);
  }
});

router.patch('/members/:id', async (req, res, next) => {
  try {
    const { name, relationship, birthYear, birthDate, avatarUrl, typicalVisitMinutes, maxTravelMinutes, email, mobile } = req.body;
    if (relationship && !RELATIONSHIPS.includes(relationship)) return res.status(400).json({ error: 'invalid_relationship' });
    // '' takes a contact detail off somebody, as it already does a face. A
    // number is normalised on the way in so that what is stored is what a
    // sender will accept, whichever way they typed it.
    if (email && !EMAIL.test(email)) return res.status(400).json({ error: 'invalid_email', message: 'That does not look like an e-mail address.' });
    const number = mobile ? normaliseMobile(mobile) : mobile;
    if (mobile && !number) return res.status(400).json({ error: 'invalid_mobile', message: `“${mobile}” does not look like a mobile number. A UK one starts 07, or +44.` });
    if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return res.status(400).json({ error: 'invalid_birth_date', message: 'Use YYYY-MM-DD' });
    if (avatarUrl && avatarUrl.length > 600_000) return res.status(413).json({ error: 'avatar_too_large', message: 'Keep photos under ~400KB' });
    const member = await households.updateMember(req.params.id, {
      name, relationship,
      birthYear: birthYear ?? (birthDate ? Number(birthDate.slice(0, 4)) : null),
      avatarUrl, typicalVisitMinutes, maxTravelMinutes, birthDate,
      email, mobile: number,
    });
    if (!member) return res.status(404).json({ error: 'member_not_found' });
    res.json({ member });
  } catch (err) {
    next(err);
  }
});

// Epic 1 M3 — deleting a member deletes their profile and rating history.
router.delete('/members/:id', async (req, res, next) => {
  try {
    if (!await households.deleteMember(req.params.id)) return res.status(404).json({ error: 'member_not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});


// ---------------------------------------------------------------------------
// inviting the people you live with
// ---------------------------------------------------------------------------
//
// The owner, 6 Sep 2026: "in the Household tab, how can I invite Gina and
// anyone else that's in my household to the app?"
//
// This is not the admin module's invitation, and the difference matters. There
// (routes/accounts.js) the owner is giving Roam to a friend, and the friend
// gets a household of their own — an empty one, on purpose. Here somebody
// already in *this* household is being given a way in to it: the same trips,
// the same saved places, and the allergens and dislikes already written down
// under their name. `accounts.member_id` is what joins the two (migration 056),
// and `currentHousehold()` above then resolves their session to this household
// without a single other route knowing anything happened.
//
// A household member is a full peer (owner, asked and answered, 6 Sep 2026:
// "Everything, no exceptions"). There is nothing to gate, so nothing here
// gates: `accessFor` already gives an account with no role the client door and
// nothing else, and every route behind that door is scoped to the household
// they are both in.
//
// Two channels, and the link is the same link either way. A text is the simplest
// thing to receive and needs Twilio (sources/sms.js); an address needs Resend
// (sources/mail.js). Both are keys, so both are the owner's to add in Doppler —
// and with neither of them set nothing here fails: it mints the link, says it
// could not send it, and shows it for him to hand over himself, which is the
// rule notify.js and mail.js already keep.

/** Somebody's own words about how a link went out, for the row that sent it. */
const deliveryWord = { email: 'e-mail', sms: 'text' };

/**
 * Who a person in this household is to the API: their profile, and whether
 * they can sign in.
 *
 * Never a token and never a link — those exist for as long as it takes to send
 * one and are returned only in the answer to the request that asked for it.
 */
function accessView(member, account, lastLink) {
  const reachable = { email: member.email ?? null, mobile: member.mobile ?? null };
  if (!account) {
    return {
      ...reachable,
      canSignIn: false,
      status: 'none',
      // Why the button is off, in the words the screen shows. A child is not
      // refused an account because of a rule about children — it is refused
      // because a profile Roam knows is under thirteen is managed by an adult
      // (Epic 1 C8), and a sign-in of their own would be around that.
      blocked: member.is_minor ? 'A profile under thirteen is looked after by an adult, so it has no sign-in of its own.' : null,
    };
  }
  return {
    ...reachable,
    canSignIn: account.status !== 'suspended',
    accountId: account.id,
    status: account.status,
    // Where their link would actually go: the account's own copy, which is what
    // was used, not what the profile says today.
    email: account.email ?? member.email ?? null,
    mobile: account.mobile ?? member.mobile ?? null,
    invitedAt: account.invited_at,
    activatedAt: account.activated_at,
    lastSeenAt: account.last_seen_at,
    signInCount: account.sign_in_count,
    isLead: account.role === 'owner',
    lastInvite: lastLink ? {
      at: lastLink.created_at, expiresAt: lastLink.expires_at, usedAt: lastLink.used_at,
      channel: lastLink.channel, delivery: lastLink.delivery, error: lastLink.delivery_error,
    } : null,
    blocked: null,
  };
}

/** Everyone's access in one go, so `GET /api/household` stays one round trip. */
async function accessForMembers(members) {
  const accounts = await accountsForHousehold(members[0]?.household_id ?? null).catch(() => []);
  const byMember = new Map(accounts.filter((a) => a.member_id).map((a) => [a.member_id, a]));
  const links = await Promise.all([...byMember.values()].map((a) => lastLinkFor(a.id)));
  const linkByAccount = new Map([...byMember.values()].map((a, i) => [a.id, links[i]]));
  return new Map(members.map((m) => {
    const account = byMember.get(m.id) ?? null;
    return [m.id, accessView(m, account, account ? linkByAccount.get(account.id) : null)];
  }));
}

/**
 * Mint a link for somebody in this household and try to send it, by whichever
 * channels were asked for.
 *
 * One link, however many ways it goes out. Texting *and* e-mailing the same
 * person two different links would mean one of them is dead before it arrives,
 * because a link is spent the first time it is opened — so both messages carry
 * the same one and whichever she taps first is the one that works.
 */
async function sendHouseholdInvite(req, { account, member, household, channels, returning }) {
  const { token, link } = await createSignInLink(account.id, { requestedBy: 'household' });
  const url = `${webUrl(req)}/?signin=${token}`;
  const from = req.account?.name ?? (await ownerAccount())?.name ?? null;
  const attempts = [];

  if (channels.includes('sms')) {
    const status = smsStatus();
    if (!status.configured) attempts.push({ channel: 'sms', sent: false, message: status.message });
    else {
      const out = await sendSms({ to: account.mobile, text: invitationText({ name: member.name, url, from, returning }) });
      attempts.push({ channel: 'sms', sent: out.sent, message: out.sent ? `Texted to ${prettyMobile(account.mobile)}.` : out.message });
    }
  }
  if (channels.includes('email')) {
    const status = mailStatus();
    if (!status.configured) attempts.push({ channel: 'email', sent: false, message: status.message });
    else {
      const body = householdInvitationEmail({ name: member.name, url, household: household.name, from, expiresAt: link.expires_at, returning });
      const out = await sendMail({ to: account.email, ...body });
      attempts.push({ channel: 'email', sent: out.sent, message: out.sent ? `Sent to ${account.email}.` : out.message });
    }
  }

  const went = attempts.filter((a) => a.sent).map((a) => a.channel);
  const delivery = went.length ? went.join('+') : (attempts[0] ? 'no_sender' : 'not_sent');
  await markLinkSent(link.id, {
    delivery,
    channel: channels.join('+'),
    error: went.length ? null : attempts.map((a) => a.message).filter(Boolean).join(' '),
  });

  const expires = new Date(link.expires_at).toDateString();
  return {
    // Shown once, and only here. There is not always a sender configured, and
    // when there is not, this is the only way the invitation reaches anybody:
    // the owner copies it out of the screen and sends it himself.
    url,
    expiresAt: link.expires_at,
    channels: attempts,
    sent: went.length > 0,
    message: went.length
      ? `${member.name} has been sent a link by ${went.map((c) => deliveryWord[c] ?? c).join(' and ')}. It works once, and expires ${expires}.`
      : `Nothing could be sent yet, so copy the link below and send it to ${member.name} yourself. It works once, and expires ${expires}.`,
  };
}

/**
 * POST /api/household/members/:id/invite — give somebody in this household a
 * way in, and send it to them.
 *
 * Body: `{ email?, mobile?, channels?: ['sms'|'email'] }`. The contacts are
 * saved onto the profile as well as the account, because "how do I reach Gina"
 * is a fact about Gina that the household owns, not a side effect of having
 * invited her once.
 */
router.post('/members/:id/invite', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const member = await households.memberById(req.params.id);
    if (!member || member.household_id !== household.id) return res.status(404).json({ error: 'member_not_found', message: 'No such person in this household.' });
    if (member.is_minor) {
      return res.status(400).json({
        error: 'member_is_minor',
        message: `${member.name}'s profile is looked after by an adult in the household (they are under thirteen), so it has no sign-in of its own.`,
      });
    }

    const b = req.body || {};
    // What was typed now, else what is already on the profile. Somebody
    // re-inviting a person does not have to retype their number.
    const email = b.email === undefined ? (member.email ?? null) : (normaliseEmail(b.email) ?? null);
    const mobileInput = b.mobile === undefined ? (member.mobile ?? null) : (String(b.mobile).trim() || null);
    const mobile = mobileInput ? normaliseMobile(mobileInput, { countryCode: household.home_country_code ?? 'GB' }) : null;
    if (email && !EMAIL.test(email)) return res.status(400).json({ error: 'invalid_email', message: 'That does not look like an e-mail address.' });
    if (mobileInput && !mobile) return res.status(400).json({ error: 'invalid_mobile', message: `“${mobileInput}” does not look like a mobile number. A UK one starts 07, or +44.` });
    if (!email && !mobile) return res.status(400).json({ error: 'no_contact', message: `Add a mobile number or an e-mail address for ${member.name} first — a link has to go somewhere.` });

    // What was asked for, narrowed to what there is a contact for. Asking to
    // text somebody with no number is not an error worth refusing the whole
    // request over; it is simply not one of the ways this can go.
    const asked = Array.isArray(b.channels) && b.channels.length ? b.channels : ['sms', 'email'];
    const channels = asked.filter((c) => (c === 'sms' && mobile) || (c === 'email' && email));
    if (!channels.length) return res.status(400).json({ error: 'no_channel', message: `There is no ${asked.map((c) => deliveryWord[c] ?? c).join(' or ')} for ${member.name}.` });

    // Whoever else is already using this contact. An address or a number is one
    // person's way in to one Roam, so lending it to a second account would mean
    // a link opening the wrong household.
    for (const [value, finder, what] of [[email, accountByEmail, 'e-mail address'], [mobile, accountByMobile, 'mobile number']]) {
      if (!value) continue;
      const taken = await finder(value);
      if (taken && taken.member_id !== member.id) {
        return res.status(409).json({
          error: 'contact_taken',
          message: `That ${what} already signs somebody in to Roam${taken.household_id === household.id ? ' in this household' : ''}. Use a different one.`,
        });
      }
    }

    await households.updateMember(member.id, { email: email ?? '', mobile: mobile ?? '' });

    let account = await accountByMember(member.id);
    if (!account) {
      account = await createAccountOnHousehold(household.id, {
        memberId: member.id, email, mobile, name: member.name,
        // Not 'owner' — that is the estate's single owner row and there is an
        // index making a second one impossible. A person in a household is a
        // customer of Roam like the household is, on the household's own plan
        // and with no ceiling of their own: the family shares one (claude.js,
        // and `callBoundFor` orders by the lead so a member cannot raise it).
        role: 'customer', plan: 'household', monthlyCallBound: null,
      });
    } else {
      // Re-inviting after a number changed, or after access was taken away.
      account = await updateAccount(account.id, {
        email: email ?? '', mobile: mobile ?? '', name: member.name,
        status: account.status === 'suspended' ? 'invited' : undefined,
      });
    }

    const invitation = await sendHouseholdInvite(req, {
      account, member, household, channels, returning: account.sign_in_count > 0,
    });
    const link = await lastLinkFor(account.id);
    res.status(201).json({ member: { id: member.id, name: member.name }, access: accessView({ ...member, email, mobile }, account, link), invitation });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/household/members/:id/invite — take the sign-in away, and leave
 * the person alone.
 *
 * Their profile, their allergens, their dislikes and every rating they have
 * given stay exactly where they are; what goes is the account and the devices
 * it is signed in on. Deleting the *person* is `DELETE /members/:id` and is a
 * different act with a different consequence (owner: a thing questioned is a
 * thing to make clear, not to delete).
 */
router.delete('/members/:id/invite', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const member = await households.memberById(req.params.id);
    if (!member || member.household_id !== household.id) return res.status(404).json({ error: 'member_not_found', message: 'No such person in this household.' });
    const account = await accountByMember(member.id);
    if (!account) return res.status(404).json({ error: 'no_account', message: `${member.name} has no sign-in to remove.` });
    if (account.role === 'owner') {
      return res.status(400).json({ error: 'is_lead', message: 'That is the account this household was set up on. It cannot remove its own way in.' });
    }
    await revokeAccountSessions(account.id);
    await deleteAccount(account.id, { withHousehold: false });
    res.json({
      removed: true,
      access: accessView(member, null, null),
      message: `${member.name} can no longer sign in. Their profile, tastes and ratings are all still here.`,
    });
  } catch (err) { next(err); }
});

/**
 * Add an allergen, diet, dislike or like. Free text is resolved to a taste
 * concept when confident; otherwise it is kept as written and the closest
 * concepts are returned as suggestions (Epic 2 C6/C7).
 */
router.post('/members/:id/constraints', async (req, res, next) => {
  try {
    const { kind, value, conceptKey: explicitKey, maxMinutes = null, favourite = false } = req.body;
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'invalid_kind', message: `kind must be one of ${KINDS.join(', ')}` });
    if (!value?.trim()) return res.status(400).json({ error: 'value_required' });

    let concept = explicitKey ? conceptByKey(explicitKey) : null;
    if (!concept && kind !== 'allergen') concept = resolveConcept(value, { kinds: kindsFor(kind) });
    const stored = concept ? concept.label : value.trim();

    // A like and a dislike of the same thing cancel out, so we never store
    // both. "Long walks" on the dislike side of a liked walk is a limit, not
    // a dislike: keep short walks, cap them.
    if (kind === 'like' || kind === 'dislike') {
      const other = kind === 'like' ? 'dislike' : 'like';
      const scale = value.trim().match(/^(long|lengthy|big|all[- ]day)\s+(.+)$/i);
      const scaleConcept = scale ? resolveConcept(scale[2], { kinds: kindsFor(kind) }) : null;
      const wantKey = (scaleConcept ?? concept)?.key ?? null;
      const wantValue = (scaleConcept ? scale[2] : stored).toLowerCase();
      const others = await households.constraintsOfKind(req.params.id, other);
      // Older rows may hold free text with no concept; resolve them the same way ranking does.
      const keyOf = (row) => row.concept_key ?? resolveConcept(row.value, { kinds: kindsFor(other) })?.key ?? null;
      const clash = others.find((row) => row.value === wantValue || (wantKey && keyOf(row) === wantKey));
      if (clash && kind === 'dislike' && scaleConcept) {
        const minutes = clash.max_minutes ?? 30;
        const capped = await households.capConstraint(clash.id, minutes);
        return res.status(200).json({
          constraint: capped, resolved: null, suggestions: [], limited: true,
          hint: `Short ones are fine, long ones aren't — so "${clash.value}" in Loves doing is now capped at ${minutes} min rather than adding a dislike. Tap it to change the limit.`,
        });
      }
      if (clash) {
        return res.status(409).json({
          error: 'conflicts_with_' + other, constraint: clash,
          message: `"${clash.value}" is already in ${other === 'like' ? (clash.concept_kind === 'experience' ? 'Loves doing' : 'Likes') : (clash.concept_kind === 'experience' ? 'Would rather not' : 'Dislikes')}. Remove it there first${other === 'like' ? ', or tap it to set a limit' : ''}.`,
        });
      }
    }

    const constraint = await households.upsertConstraint(req.params.id, {
      kind,
      value: stored.toLowerCase(),
      conceptKey: concept?.key ?? null,
      conceptKind: concept?.kind ?? null,
      maxMinutes: maxMinutes ? Number(maxMinutes) : null,
      favourite: kind === 'like' && Boolean(favourite),
    });
    const negated = isNegated(value) && kind !== 'allergen';
    res.status(201).json({
      constraint,
      resolved: concept ? { key: concept.key, label: concept.label, kind: concept.kind } : null,
      suggestions: concept || negated ? [] : matchConcepts(value, { kinds: kindsFor(kind), limit: 5 }).map((c) => ({ key: c.key, label: c.label, kind: c.kind })),
      hint: negated
        ? `Kept "${value.trim()}" as typed, but Roam doesn't read "not". Put "${value.trim().replace(NEGATION_PREFIX, '')}" in ${kind === 'like' ? 'Dislikes' : 'Likes'} instead — the two lists do the negating.`
        : kind === 'allergen' && !ALLERGENS.includes(value.trim().toLowerCase())
          ? `Added. Place listings rarely state "${value.trim()}", so it will flag menu items once a menu is captured rather than excluding venues today.`
          : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * "Walks — up to 40 minutes": a limit on one preference (null clears it), and
 * "favourite": the one this person will generally pick over the others.
 * Only the fields sent are changed.
 */
router.patch('/constraints/:id', async (req, res, next) => {
  try {
    const { nothingToDo, constraint } = await households.patchConstraint(req.params.id, req.body || {});
    if (nothingToDo) return res.status(400).json({ error: 'nothing_to_update', message: 'send maxMinutes and/or favourite' });
    if (!constraint) return res.status(404).json({ error: 'constraint_not_found' });
    res.json({ constraint });
  } catch (err) {
    next(err);
  }
});

router.delete('/constraints/:id', async (req, res, next) => {
  try {
    if (!await households.deleteConstraint(req.params.id)) return res.status(404).json({ error: 'constraint_not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/learned', async (_req, res, next) => {
  try {
    const household = await currentHousehold();
    res.json({ learned: await loadLearnedPreferences(household.id), threshold: LEARN_THRESHOLD });
  } catch (err) {
    next(err);
  }
});

/**
 * Cost per household per period — the instrumentation §14 asks for, as
 * Settings › Usage shows it: a period (this month, last month, all time, or
 * from/to dates), a total, one line per provider with calls, billable units,
 * estimated cost and how much of its free allowance or Roam cap has gone, and
 * the activity in that period. Figures are Roam's own counts at list prices;
 * each line links to the provider console where the real bill is.
 */
router.get('/spend', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { allowances, windows: w } = await allowanceUsage(household.id);
    const key = ['month', 'last-month', 'all', 'custom'].includes(String(req.query.period)) ? String(req.query.period) : 'month';
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? new Date(`${v}T00:00:00Z`) : null);
    let from; let to;
    if (key === 'last-month') { from = w.last_month_start; to = w.month_start; }
    else if (key === 'all') { from = new Date(0); to = w.next_month_start; }
    else if (key === 'custom' && day(req.query.from)) { from = day(req.query.from); to = new Date((day(req.query.to) ?? from).getTime() + 86_400_000); }
    else { from = w.month_start; to = w.next_month_start; }

    const { lines: stats, total } = await usageBetween(household.id, from, to);
    // Every period per line, so the Providers table switches period without a refetch.
    const [pm, pl, pa] = await Promise.all([usageBetween(household.id, w.month_start, w.next_month_start), usageBetween(household.id, w.last_month_start, w.month_start), usageBetween(household.id)]);
    const periodsFor = (key) => Object.fromEntries([['month', pm], ['last-month', pl], ['all', pa]].map(([k, u]) => { const x = u.lines[key] ?? { calls: 0, units: 0, costUsd: 0, estimated: false }; return [k, { calls: x.calls, units: Math.round(x.units), costUsd: x.costUsd, estimated: x.estimated }]; }));
    const totalsByPeriod = { month: pm.total, 'last-month': pl.total, all: pa.total };
    const live = new Set(enabledSources({ includeOptIn: true }).map((s) => s.key));
    const perSearch = perSearchCost({ scoutAvgUsd: pm.lines.scout?.calls ? pm.lines.scout.costUsd / pm.lines.scout.calls : null });
    const isOn = (line) => (line.key === 'claude' ? Boolean(process.env.ANTHROPIC_API_KEY) : line.key === 'google-routes' ? routingEnabled() : line.source === 'liteapi' ? bedRatesOn() : live.has(line.source));
    let paidTotal = 0;
    const lines = LINES.map((line) => {
      const s = stats[line.key] ?? { calls: 0, units: 0, costUsd: 0, estimated: false };
      const a = allowances[line.key] ?? null;
      // What this period cost beyond the free allowance: Claude by tokens; a
      // metered provider only once its allowance window is past the limit.
      let paidUsd = 0;
      if (line.key === 'claude' || line.key === 'scout') paidUsd = s.costUsd;
      else if (line.allowance?.beyondUsd && a) paidUsd = Math.min(s.units, Math.max(0, a.used - a.limit)) * line.allowance.beyondUsd;
      paidTotal += paidUsd;
      return {
        key: line.key, label: line.label, source: line.source, on: isOn(line),
        unit: line.unit, unitPlural: line.unitPlural, what: line.what, hardStop: line.hardStop ?? null, console: line.console ?? null,
        calls: s.calls, units: Math.round(s.units), costUsd: s.costUsd, paidUsd, estimated: s.estimated,
        allowance: line.allowance ? { ...line.allowance, ...a } : null,
        cap: line.cap ? { ...line.cap, ...a } : null,
        periods: periodsFor(line.key),
        perSearchUsd: line.key === 'claude' ? null : (perSearch[line.source]?.perSearchUsd ?? 0),
      };
    }).filter((l) => l.on || l.calls > 0 || (l.allowance?.used ?? 0) > 0);

    const recent = await households.recentProviderCalls(household.id);
    // Which table rows each call belongs to, so a provider's drawer can list its own activity.
    for (const r of recent) r.lines = r.units ? Object.keys(r.units) : legacyLines(r.provider, r.purpose).map((l) => l.key);
    res.json({
      period: { key, from, to, label: key === 'month' ? 'This month' : key === 'last-month' ? 'Last month' : key === 'all' ? 'All time' : 'Custom' },
      totals: { calls: total.calls, costUsd: total.costUsd, paidUsd: paidTotal },
      totalsByPeriod,
      lines,
      recent,
      generatedAt: w.now,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Spend by month for the charts in Settings › Providers: the last 12 months
 * (or ?months=), per line and in total, with an estimate of what each month
 * cost beyond the free allowances (monthly allowances per month; a lifetime
 * one cumulatively).
 */
router.get('/spend/series', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const months = Math.min(36, Math.max(3, Number(req.query.months) || 12));
    const series = await usageByMonth(household.id, months);
    const lines = {};
    for (const line of LINES) {
      const pts = series.lines[line.key] ?? [];
      let cumulative = 0;
      lines[line.key] = pts.map((p) => {
        let paidUsd = 0;
        if (line.key === 'claude' || line.key === 'scout') paidUsd = p.costUsd;
        else if (line.allowance?.beyondUsd) {
          if (line.allowance.kind === 'lifetime') { const before = cumulative; cumulative += p.units; paidUsd = Math.max(0, cumulative - line.allowance.limit) - Math.max(0, before - line.allowance.limit); paidUsd *= line.allowance.beyondUsd; }
          else if (line.allowance.kind === 'monthly') paidUsd = Math.max(0, p.units - line.allowance.limit) * line.allowance.beyondUsd;
        }
        return { ...p, paidUsd };
      });
    }
    const total = series.months.map((m, i) => ({ ...series.total[i], paidUsd: Object.values(lines).reduce((n, pts) => n + (pts[i]?.paidUsd ?? 0), 0) }));
    res.json({ months: series.months, lines, total });
  } catch (err) {
    next(err);
  }
});

/** Everything the household has generated, in readable JSON (Epic 1 C9). */
router.get('/export', async (_req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    const { trips, stops, visits, ratings, ledger } = await households.everythingFor(household.id);
    res.setHeader('content-disposition', `attachment; filename="roam-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      note: 'Place content from licensed sources is not included — only identifiers and what the household wrote.',
      household: { name: household.name, defaultVisitMinutes: household.default_visit_minutes, maxTravelMinutes: household.max_travel_minutes, defaultIntensity: household.default_intensity },
      members, trips, stops, visits, ratings, placeLedger: ledger,
    });
  } catch (err) {
    next(err);
  }
});

/** Delete means delete (Epic 1 C10). The household name must be typed to confirm. */
router.delete('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { confirmName } = req.body || {};
    if (confirmName !== household.name) return res.status(400).json({ error: 'confirm_name_mismatch', message: 'Type the household name exactly to confirm deletion.' });
    await households.deleteHouseholdAndCalls(household.id);
    res.json({ deleted: true, household: household.name });
  } catch (err) {
    next(err);
  }
});

export default router;
