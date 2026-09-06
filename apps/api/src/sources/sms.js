/**
 * Sending a text message, when there is anything to send it with.
 *
 * The same shape as `mail.js`, and for the same reason: one HTTPS call, no SDK,
 * nothing added to package.json and nothing to keep up to date. Swapping Twilio
 * for MessageBird or SNS is this one function.
 *
 * The keys are the owner's to add (CLAUDE.md: anything that holds a secret is
 * the owner's to do). They go in Doppler, never in the repo and never as
 * Railway variables set by hand:
 *
 *   TWILIO_ACCOUNT_SID   the account, and it really must be the one beginning
 *                        `AC…` — it is the path of every request, not merely a
 *                        username
 *   TWILIO_AUTH_TOKEN    the secret to sign with
 *   TWILIO_FROM          the number texts come from, or a `MG…` messaging
 *                        service SID, which is what Twilio wants for the UK
 *   TWILIO_API_KEY_SID   optional, `SK…`
 *
 * Twilio hands out two kinds of credential and they are easy to confuse, so
 * both work here. The account's own **auth token** is signed with the account
 * SID, and that is all three variables. An **API key** is a separate `SK…` and
 * secret which can be revoked without changing the account's password — better
 * practice, and what a console nudges you toward — but it is only the
 * *username*: the URL still addresses the account, so an `SK…` pasted into
 * `TWILIO_ACCOUNT_SID` produces a 404 from a path that does not exist rather
 * than a 401 that would say what was wrong. `smsStatus` therefore checks the
 * shape of the SID and says so in as many words, because that mistake costs an
 * hour otherwise.
 *
 * With none of them set this does not throw, does not queue and does not
 * silently drop the message. It says it could not send, and the Household tab
 * shows the link for the owner to hand over himself — the rule `notify.js`
 * already keeps for group reminders and `mail.js` for invitations.
 *
 * A text is not an e-mail and must not be written like one. It is one sentence,
 * one link, and no HTML: 160 characters is a message, 400 is three messages the
 * owner pays for and nobody reads to the end of.
 */

const SID = () => (process.env.TWILIO_ACCOUNT_SID || '').trim();
const TOKEN = () => (process.env.TWILIO_AUTH_TOKEN || '').trim();
const FROM = () => (process.env.TWILIO_FROM || '').trim();
/** An API key signs in the account's place; the account is still the address. */
const KEY_SID = () => (process.env.TWILIO_API_KEY_SID || '').trim();

/** Who the request is signed as: the API key if there is one, else the account. */
const signingAs = () => KEY_SID() || SID();

export const smsConfigured = () => Boolean(SID().startsWith('AC') && TOKEN() && FROM());

/**
 * Why the owner cannot text yet, in two lengths.
 *
 * Three fields, for three readers. `short` sits beside the box on a phone: one
 * clause, no variable names, saying what will happen instead rather than what
 * is broken. `setup` is the one line naming what to add, shown once at the foot
 * of the panel, because the person reading it is the only person who can fix
 * it. `message` is the whole thing, for the back office. A phone is never shown
 * a provider's own words (owner, on seeing a raw 429: "I should never see that
 * on the phone app").
 */
export function smsStatus() {
  // Which of the three are actually missing, named one by one.
  //
  // This used to say "add all three" whenever any of them was absent, which is
  // the same sentence whether nothing has been set up or two thirds of it has.
  // The owner set two keys, saw that sentence unchanged, and had no way to tell
  // from it whether the third was missing or the first two had never reached
  // the process — which is the more likely fault and the one worth naming.
  // An API key with no account beside it. The likeliest way to get here, and
  // the one a Twilio console actively encourages: the key page hands you an
  // `SK…` and a secret and calls them "SID" and "Secret", so it reads as the
  // complete set. It is not — a key signs a request, it does not address one,
  // and the account SID is the path. Named on its own because "TWILIO_ACCOUNT_SID
  // is not set" invites the reply "yes it is, it's the SID I was given".
  if (KEY_SID() && !SID()) {
    return {
      configured: false,
      reason: 'key_without_account',
      short: "Texts aren't switched on yet — you'll copy the link instead.",
      setup: 'TWILIO_API_KEY_SID is set but TWILIO_ACCOUNT_SID is not. Add the Account SID (AC…) from the Twilio dashboard — the key signs the request, the account is its address.',
      message: 'Twilio has an API key (TWILIO_API_KEY_SID) and a secret, but not the account they belong to. An API key signs a request; the URL still addresses the account, so both are needed. TWILIO_ACCOUNT_SID is the AC… string under Account Info on the Twilio dashboard.',
      missing: ['TWILIO_ACCOUNT_SID', ...(FROM() ? [] : ['TWILIO_FROM'])],
    };
  }

  const absent = [
    !SID() && 'TWILIO_ACCOUNT_SID',
    !TOKEN() && 'TWILIO_AUTH_TOKEN',
    !FROM() && 'TWILIO_FROM',
  ].filter(Boolean);
  if (absent.length) {
    const list = absent.length === 1 ? absent[0] : `${absent.slice(0, -1).join(', ')} and ${absent.at(-1)}`;
    // All three absent is "nothing has been set up". Some of them absent is a
    // different fact — the ones that are there did reach this process, so the
    // sync is working and only the named ones are outstanding.
    const partial = absent.length < 3;
    return {
      configured: false,
      reason: absent.length === 3 ? 'no_sender' : 'incomplete',
      short: "Texts aren't switched on yet — you'll copy the link instead.",
      setup: `To send by text, add ${list} in Doppler.`,
      message: partial
        ? `Twilio is half configured: ${list} ${absent.length === 1 ? 'is' : 'are'} not set. The rest did reach the API, so the Doppler sync is working — this is the one still to add.`
        : 'No text sender is configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM in Doppler to send invitations by text; until then, copy the link and send it yourself.',
      missing: absent,
    };
  }
  // The wrong SID in the right box. An `SK…` is an API key, which signs the
  // request but does not address it — Twilio would answer 404 from a URL built
  // around an account that does not exist, and a 404 reads as "this feature is
  // broken" rather than "that is the wrong one of the two strings on the page".
  if (!SID().startsWith('AC')) {
    const looksLikeKey = SID().startsWith('SK');
    return {
      configured: false,
      reason: 'wrong_sid',
      short: "Texts aren't switched on yet — you'll copy the link instead.",
      setup: looksLikeKey
        ? 'TWILIO_ACCOUNT_SID holds an API key (SK…). Move it to TWILIO_API_KEY_SID and put the Account SID (AC…) from the Twilio dashboard in TWILIO_ACCOUNT_SID.'
        : 'TWILIO_ACCOUNT_SID does not look like an Account SID. It is the string beginning AC on the Twilio dashboard.',
      message: looksLikeKey
        ? 'TWILIO_ACCOUNT_SID holds an API key SID (SK…) rather than the Account SID. An API key signs a request but the URL still addresses the account, so Twilio would answer 404. Put the AC… value from the Twilio dashboard in TWILIO_ACCOUNT_SID, and the SK… in TWILIO_API_KEY_SID beside it.'
        : 'TWILIO_ACCOUNT_SID does not begin with AC, so it is not an Account SID. It is the first string on the Twilio dashboard, under Account Info.',
    };
  }
  if (!FROM()) {
    return {
      configured: false,
      reason: 'no_from',
      short: "Texts aren't switched on yet — you'll copy the link instead.",
      setup: 'To send by text, add TWILIO_FROM in Doppler — a number you own, or a messaging service SID beginning MG.',
      message: 'Twilio keys are set but TWILIO_FROM is not, so there is no number to send from. It is either a number you own or a messaging service SID beginning MG.',
    };
  }
  return {
    configured: true,
    from: FROM(),
    signingWith: KEY_SID() ? 'api_key' : 'auth_token',
    // Told, not enforced. Twilio's two secrets are the same length and go in
    // the same box, and only their alphabet tells them apart: an Auth Token is
    // 32 lowercase hex, an API key's secret is 32 mixed-case alphanumerics. So
    // a secret that is not hex, with no API key SID beside it, is a key's
    // secret signing as the account — which Twilio refuses with a 20003 that
    // names neither of them.
    //
    // A caution rather than a refusal, deliberately. This is a guess about a
    // format Twilio has never promised to keep, and a wrong guess must not
    // stop a working sender from sending. It is worth saying and not worth
    // enforcing.
    caution: !KEY_SID() && !/^[0-9a-f]{32}$/.test(TOKEN())
      ? "TWILIO_AUTH_TOKEN does not look like an account Auth Token, which is 32 lowercase hexadecimal characters. It looks like an API key's secret — if it is, add its SK… as TWILIO_API_KEY_SID, or replace it with the Auth Token from the Twilio dashboard under Account Info."
      : null,
  };
}

/**
 * A mobile number in the form a sender will accept, or null.
 *
 * Two dialects arrive from a phone keyboard and both are the same number:
 * `07700 900123` and `+44 7700 900123`. A leading zero is a national number and
 * needs a country, which is the household's own — so the default is the United
 * Kingdom and anything already in `+…` form is left exactly as it is.
 *
 * Deliberately not a full E.164 parser. It normalises what British families
 * actually type and refuses the rest, rather than half-converting a number from
 * somewhere else and texting a stranger.
 */
export function normaliseMobile(input, { countryCode = 'GB' } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[\s()\-.]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(cleaned)) return cleaned;
  if (/^00[1-9]\d{7,14}$/.test(cleaned)) return `+${cleaned.slice(2)}`;
  // A national number, which only means something alongside a country.
  const dialling = { GB: '44', IE: '353', US: '1', CA: '1', FR: '33', ES: '34', IT: '39', DE: '49', NL: '31', PT: '351', AU: '61', NZ: '64' }[String(countryCode).toUpperCase()];
  if (!dialling) return null;
  if (/^0\d{7,13}$/.test(cleaned)) return `+${dialling}${cleaned.slice(1)}`;
  return null;
}

/** How a number is shown back to the household: theirs, as they gave it. */
export const prettyMobile = (e164) => {
  const s = String(e164 ?? '');
  if (s.startsWith('+44') && s.length === 13) return `${s.slice(0, 3)} ${s.slice(3, 7)} ${s.slice(7)}`;
  return s;
};

/**
 * What a refusal from Twilio actually means to the person who has to fix it.
 *
 * Only the codes worth a different action are named. Everything else falls
 * through to Twilio's own sentence, which is usually clear and is always more
 * accurate than a guess — the point of this table is not to hide the provider
 * but to add the step it cannot know about, like "this account is still on the
 * trial, so the number has to be verified first".
 */
export function explain(code, said, status) {
  const theirs = said ? ` ${said}` : '';
  switch (Number(code)) {
    case 21608:
      return 'That number has not been verified on your Twilio trial, so Twilio will not text it. Add it under Verified Caller IDs in the Twilio console (a trial allows five), or upgrade the account to text anybody.';
    case 21606:
    case 21659:
      return `TWILIO_FROM is not a number this account can send from.${theirs} Use the number on the Twilio console's Phone Numbers page, or a messaging service SID beginning MG.`;
    case 21612:
      return `Twilio cannot get a message to that number from the number you are sending from.${theirs} A UK recipient generally needs a UK sender, or a messaging service.`;
    case 21610:
      return 'That number replied STOP to an earlier message, so Twilio will not text it again until they text START.';
    case 21211:
      return `Twilio does not recognise that as a phone number.${theirs}`;
    case 20003:
      // The message this used to give sent the owner looking at his account
      // SID, which was correct by then. With an API key in play the likelier
      // fault is the other half of the pair: an API key's *secret* and the
      // account's Auth Token are two different strings, and the console calls
      // both of them things you would type into a variable named AUTH_TOKEN.
      return KEY_SID()
        ? 'Twilio refused the credentials. TWILIO_API_KEY_SID is set, so TWILIO_AUTH_TOKEN has to hold that API key\u2019s secret — the account\u2019s Auth Token is a different string and will not sign for a key. If what you have is the account\u2019s Auth Token, delete TWILIO_API_KEY_SID and Roam will sign as the account instead.'
        : 'Twilio refused the credentials. Check TWILIO_AUTH_TOKEN, and that TWILIO_ACCOUNT_SID is the AC… account rather than an SK… API key.';
    default:
      return `The text sender refused it (${status}).${theirs}`;
  }
}

/**
 * Send one message. Never throws: the caller has already written down that a
 * link exists, and whether it could be delivered is a fact about the send, not
 * a reason to fail the request that made it.
 */
export async function sendSms({ to, text }) {
  const status = smsStatus();
  if (!status.configured) return { sent: false, reason: status.reason, message: status.message };
  const number = normaliseMobile(to);
  if (!number) return { sent: false, reason: 'bad_number', message: `“${to}” does not look like a mobile number.` };

  const from = FROM();
  const body = new URLSearchParams({ To: number, Body: text });
  // A messaging service is how Twilio wants UK traffic sent — it picks the
  // number and handles the alphanumeric sender. A plain number is the other
  // way, and they are different parameters rather than different values.
  if (/^MG[0-9a-f]{32}$/i.test(from)) body.set('MessagingServiceSid', from);
  else body.set('From', from);

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(SID())}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${signingAs()}:${TOKEN()}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const said = await res.json().catch(() => null);
      // Twilio's own words, plus ours where we know better what to do about it.
      // Only the owner ever sees this — a phone is never shown a provider's
      // error (feedback, on a raw 429: "I should never see that on the phone
      // app"), and the Household panel shows this line to whoever is inviting.
      return {
        sent: false,
        reason: 'send_failed',
        message: explain(said?.code, said?.message, res.status),
        providerCode: said?.code ?? null,
      };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: 'send_failed', message: err.message };
  }
}

/**
 * The invitation, as one text.
 *
 * Says who it is from before it says anything else, because a link that arrives
 * with no name on it looks exactly like the thing people are told never to tap.
 */
export function invitationText({ name, url, from, returning = false }) {
  const who = from ? `${from} has` : 'You have been';
  const opening = returning
    ? 'Here is a fresh link to sign back in to Roam:'
    : `${who} added you to their household on Roam — where the family's places, tastes and trips live. Open it here:`;
  return `${name ? `Hi ${name}. ` : ''}${opening}\n${url}\nThe link works once, on the phone you open it on.`;
}
