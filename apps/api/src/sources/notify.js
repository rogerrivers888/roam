// How a reminder actually leaves the building.
//
// Roam writes the reminder either way, and the record of it is the same either
// way — what changes is whether it could be delivered. There is no channel in
// the repo and there will not be one: an SMS or email provider is a key, and
// keys come from Doppler and are the owner's to add (CLAUDE.md). Until one is
// set, every reminder is written, kept, shown to the organiser, and marked
// `no_channel` — which the group screen says plainly rather than implying that
// eighteen people have been texted when nobody has.
//
// When the key exists, `NOTIFY_WEBHOOK_URL` is posted the reminder as JSON and
// the row is marked sent. That is deliberately the smallest possible contract:
// whatever sends the message — a provider, a queue, a Zap — sits behind it, and
// Roam does not learn a vendor's API to find out whether groups work.

const url = () => process.env.NOTIFY_WEBHOOK_URL || null;

/** Whether reminders can be delivered at all, for the screen that promises they are. */
export const channelReady = () => Boolean(url());

/**
 * Send one reminder. Never throws: a group's chasing must not stop because a
 * webhook was down, and the row records what happened either way.
 * → { status: 'sent' | 'no_channel' | 'failed', channel, detail }
 */
export async function sendReminder({ to, contactKind, body, group, participant }) {
  const endpoint = url();
  if (!endpoint) return { status: 'no_channel', channel: contactKind ?? null, detail: 'No way to send has been connected yet.' };
  if (!to) return { status: 'no_channel', channel: null, detail: 'No contact was given for this person.' };
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, kind: contactKind ?? null, text: body, group, participant }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { status: 'failed', channel: contactKind ?? null, detail: `The sender answered ${res.status}.` };
    return { status: 'sent', channel: contactKind ?? null, detail: null };
  } catch (err) {
    return { status: 'failed', channel: contactKind ?? null, detail: err.message };
  }
}
