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
 *   TWILIO_ACCOUNT_SID   the account, `AC…`
 *   TWILIO_AUTH_TOKEN    its token — the secret
 *   TWILIO_FROM          the number texts come from, or a `MG…` messaging
 *                        service SID, which is what Twilio wants for the UK
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

const SID = () => process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = () => process.env.TWILIO_AUTH_TOKEN || '';
const FROM = () => process.env.TWILIO_FROM || '';

export const smsConfigured = () => Boolean(SID() && TOKEN() && FROM());

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
  if (!SID() || !TOKEN()) {
    return {
      configured: false,
      reason: 'no_sender',
      short: "Texts aren't switched on yet — you'll copy the link instead.",
      setup: 'To send by text, add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM in Doppler.',
      message: 'No text sender is configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM in Doppler to send invitations by text; until then, copy the link and send it yourself.',
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
  return { configured: true, from: FROM() };
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
        authorization: `Basic ${Buffer.from(`${SID()}:${TOKEN()}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const said = await res.json().catch(() => null);
      // Twilio's own words, which are what tell the owner the number is not
      // verified or the trial has run out. Only he ever sees this.
      return { sent: false, reason: 'send_failed', message: `The text sender refused it (${res.status}). ${said?.message ?? ''}`.trim() };
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
