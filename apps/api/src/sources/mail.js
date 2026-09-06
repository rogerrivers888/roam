/**
 * Sending an e-mail, when there is anything to send it with.
 *
 * Roam has never had a sender. Group reminders already know this and record
 * `no_channel` rather than pretending (routes/groups.js), and this file follows
 * the same rule for invitations: with no key configured it does not throw, does
 * not queue and does not silently drop the message — it says it could not send,
 * and the admin screen shows the owner the link to hand over himself.
 *
 * The key is the owner's to add (CLAUDE.md: anything that holds a secret is the
 * owner's to do). It goes in Doppler as `RESEND_API_KEY`, never in the repo and
 * never as a Railway variable set by hand. Two non-secret companions go beside
 * it: `ROAM_MAIL_FROM` (the address invitations come from, which must be on a
 * domain verified with the sender) and `ROAM_WEB_URL` (where the app is served,
 * so a link in an e-mail points at the app rather than at the API).
 *
 * Resend is the sender because it is one HTTPS call with no SDK — nothing to
 * add to package.json, nothing to keep up to date. Swapping it for Postmark or
 * SES is this one function.
 */

const KEY = () => process.env.RESEND_API_KEY || '';
export const mailConfigured = () => Boolean(KEY() && process.env.ROAM_MAIL_FROM);

/**
 * Why the owner cannot send yet, in two lengths.
 *
 * Three fields, for three readers. `message` is the whole thing and is what the
 * admin screen has always shown. `short` is one clause for beside a box on a
 * phone, saying what will happen instead rather than naming a variable, and
 * `setup` does the naming once, at the foot of the panel, where the person who
 * can act on it will read it.
 */
export function mailStatus() {
  if (KEY() && !process.env.ROAM_MAIL_FROM) {
    return { configured: false, reason: 'no_from', short: "E-mail isn't switched on yet — you'll copy the link instead.", setup: 'To send by e-mail, add ROAM_MAIL_FROM in Doppler — the address invitations come from, on a domain verified with the sender.', message: 'A send key is set but ROAM_MAIL_FROM is not, so there is no address to send from.' };
  }
  if (!KEY()) {
    return { configured: false, reason: 'no_sender', short: "E-mail isn't switched on yet — you'll copy the link instead.", setup: 'To send by e-mail, add RESEND_API_KEY and ROAM_MAIL_FROM in Doppler.', message: 'No mail sender is configured. Add RESEND_API_KEY and ROAM_MAIL_FROM in Doppler to send invitations from Roam; until then, copy the link and send it yourself.' };
  }
  return { configured: true, from: process.env.ROAM_MAIL_FROM };
}

/**
 * Where the app lives, for links that go out in an e-mail.
 *
 * Falls back to the request's own origin so a local developer gets a link that
 * works on their machine without setting anything.
 */
export function webUrl(req) {
  const set = String(process.env.ROAM_WEB_URL || '').trim().replace(/\/$/, '');
  if (set) return set;
  const origin = req?.headers?.origin;
  if (origin) return String(origin).replace(/\/$/, '');
  return 'http://localhost:8081';
}

/**
 * Send one message. Never throws: the caller has already written down that a
 * link exists, and whether it could be delivered is a fact about the send, not
 * a reason to fail the request that made it.
 */
export async function sendMail({ to, subject, text, html }) {
  const status = mailStatus();
  if (!status.configured) return { sent: false, reason: status.reason, message: status.message };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.ROAM_MAIL_FROM, to: [to], subject, text, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // The provider's own words, trimmed: the owner is the only person who
      // sees this and it is what tells him the domain is not verified yet.
      return { sent: false, reason: 'send_failed', message: `The mail sender refused it (${res.status}). ${body.slice(0, 300)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: 'send_failed', message: err.message };
  }
}

/**
 * The invitation itself.
 *
 * Plain words, one link, and no tracking pixel or redirect: the address in the
 * e-mail is the address they land on. It says who it is from and that the link
 * is theirs alone, because a link that arrives with no explanation looks
 * exactly like the thing people are told never to click.
 */
export function invitationEmail({ name, url, from, expiresAt, returning = false }) {
  const hello = name ? `Hi ${name},` : 'Hi,';
  const days = Math.max(1, Math.round((new Date(expiresAt) - Date.now()) / 86400000));
  const opening = returning
    ? 'Here is a fresh link to sign back in to Roam.'
    : `${from || 'Roger'} has set you up with Roam — it remembers every place you love, and plans days out around what everybody in your household will actually eat.`;
  const text = [
    hello,
    '',
    opening,
    '',
    'Open Roam:',
    url,
    '',
    `The link signs you in on the device you open it on and works once, within ${days} day${days === 1 ? '' : 's'}. After that the app stays signed in for ninety days.`,
    '',
    'If you were not expecting this, ignore it — nothing happens until the link is opened.',
  ].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1c2b24">
  <p>${hello}</p>
  <p>${opening}</p>
  <p><a href="${url}" style="display:inline-block;background:#1c2b24;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none">Open Roam</a></p>
  <p style="font-size:14px;color:#5c6b63">The link signs you in on the device you open it on and works once, within ${days} day${days === 1 ? '' : 's'}. After that the app stays signed in for ninety days.</p>
  <p style="font-size:14px;color:#5c6b63">If you were not expecting this, ignore it — nothing happens until the link is opened.</p>
</div>`;
  return { subject: returning ? 'Your link back in to Roam' : 'Your invitation to Roam', text, html };
}

/**
 * The other invitation: somebody already in the household, not a new customer.
 *
 * `invitationEmail` above is for a friend the owner is giving Roam to, and it
 * describes what Roam is because they have never heard of it. Gina has: she is
 * in the household the mail is about, her allergens are already in it, and what
 * she needs to be told is whose it is and that it is the same one — not a
 * second, empty Roam of her own.
 */
export function householdInvitationEmail({ name, url, household, from, expiresAt, returning = false }) {
  const hello = name ? `Hi ${name},` : 'Hi,';
  const days = Math.max(1, Math.round((new Date(expiresAt) - Date.now()) / 86400000));
  const who = from ? `${from} has` : 'You have been';
  const opening = returning
    ? `Here is a fresh link to sign back in to ${household || 'your household'} on Roam.`
    : `${who} added you to ${household ? `<b>${household}</b>` : 'the household'} on Roam. It is the same Roam they use — the same trips, the same saved places, and the tastes and allergies already written down for everybody at home.`;
  const plain = opening.replace(/<\/?b>/g, '');
  const text = [
    hello, '', plain, '', 'Open Roam:', url, '',
    `The link signs you in on the device you open it on and works once, within ${days} day${days === 1 ? '' : 's'}. After that the app stays signed in for ninety days.`,
    '', 'If you were not expecting this, ignore it — nothing happens until the link is opened.',
  ].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1c2b24">
  <p>${hello}</p>
  <p>${opening}</p>
  <p><a href="${url}" style="display:inline-block;background:#1c2b24;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none">Open Roam</a></p>
  <p style="font-size:14px;color:#5c6b63">The link signs you in on the device you open it on and works once, within ${days} day${days === 1 ? '' : 's'}. After that the app stays signed in for ninety days.</p>
  <p style="font-size:14px;color:#5c6b63">If you were not expecting this, ignore it — nothing happens until the link is opened.</p>
</div>`;
  return { subject: returning ? 'Your link back in to Roam' : `You're in ${household || 'the household'} on Roam`, text, html };
}
