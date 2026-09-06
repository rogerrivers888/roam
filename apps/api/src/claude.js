// Claude access for the conversational planner.
//
// One wrapper, so every call is attributed to a household and a session and
// written to provider_calls (Requirements §5 "Spend containment"; Technical
// Constraints §14). Structured outputs are used throughout: the planner never
// parses prose, it receives a schema-validated object.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as providerCalls from './repositories/providerCalls.js';
import { callBoundFor } from './repositories/accounts.js';

export const MODEL = 'claude-opus-5';

// Per-session and per-household bounds (Epic 3 C10). Overridable by env so
// they can be tuned without a deploy; the numbers themselves are open (A5).
export const SESSION_CALL_BOUND = Number(process.env.ROAM_SESSION_CALL_BOUND || 40);
export const HOUSEHOLD_MONTHLY_CALL_BOUND = Number(process.env.ROAM_HOUSEHOLD_MONTHLY_CALL_BOUND || 3000);

// Indicative list rates ($ per million tokens) for the cost instrumentation, per
// model: the planner runs on Opus, while a mechanical read like a menu runs on
// a cheaper one (sources/menuRead.js), and Settings should say what was really
// spent rather than the planner's rate for everything. Cache rates are
// approximate; the point is the trend.
const RATES = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};
const rateFor = (model) => {
  const r = RATES[model] ?? RATES['claude-opus-5'];
  return { input: r.input / 1e6, output: r.output / 1e6, cacheRead: r.cacheRead / 1e6, cacheWrite: r.cacheWrite / 1e6 };
};
// Server-side web search is billed per search on top of tokens ($10 per 1,000).
const WEB_SEARCH_RATE = 10 / 1000;

// Identity-linked API keys (the default kind the Console issues now) must name
// the workspace each request acts in; a legacy workspace key needs nothing.
const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
const client = new Anthropic(
  workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {},
);

export class SpendBoundError extends Error {
  constructor(scope, bound) {
    super(`${scope} call bound reached (${bound})`);
    this.code = 'spend_bound_reached';
    this.status = 429;
    this.scope = scope;
    this.bound = bound;
  }
}

/**
 * The ceiling this household is held to.
 *
 * Every household added draws on the same provider allowances the owner's own
 * searching does — Google's free searches are per Google account, not per
 * household — so a guest account carries its own smaller number
 * (accounts.monthly_call_bound, set on the admin screen). Nobody's number set
 * means the estate default, which is what the founding household runs on.
 */
export async function monthlyBoundFor(householdId) {
  const own = await callBoundFor(householdId).catch(() => null);
  return own ?? HOUSEHOLD_MONTHLY_CALL_BOUND;
}

export async function assertWithinBounds({ householdId, sessionId }) {
  const [sessionCalls, monthCalls, bound] = await Promise.all([
    providerCalls.countForSession(sessionId),
    providerCalls.countThisMonth(householdId),
    monthlyBoundFor(householdId),
  ]);
  if (sessionCalls >= SESSION_CALL_BOUND) throw new SpendBoundError('session', SESSION_CALL_BOUND);
  if (monthCalls >= bound) throw new SpendBoundError('household', bound);
}

/**
 * The workspace's own spend limit, reached.
 *
 * Anthropic answers a 400 with "You have reached your specified workspace API
 * usage limits. You will regain access on …". It is a 400 the way a locked door
 * is a 400 — nothing about the request is wrong — and the one thing a screen
 * must not do with it is blame the thing somebody was reading (owner, 6 Sep
 * 2026, told to photograph a menu because of this). It is the owner's ceiling
 * in the Anthropic console, and only the owner can raise it.
 */
export class ModelBudgetError extends Error {
  constructor(until) {
    super(`the workspace's model budget is spent${until ? `, back on ${until}` : ''}`);
    this.code = 'model_budget_reached';
    this.status = 429;
    this.until = until ?? null;
  }
}

/** Anthropic's wording for it, turned into something the rest of Roam can act on. */
export function asBudgetError(err) {
  const text = String(err?.error?.error?.message ?? err?.message ?? '');
  if (!/workspace API usage limits/i.test(text)) return null;
  const on = text.match(/regain access on (\d{4}-\d{2}-\d{2})/i)?.[1] ?? null;
  return new ModelBudgetError(on);
}

const ask = async (run) => {
  try { return await run(); } catch (err) { throw asBudgetError(err) ?? err; }
};

async function recordCall({ householdId, sessionId, provider, purpose, usage, model = MODEL }) {
  const RATE = rateFor(model);
  const cost = usage
    ? (usage.input_tokens || 0) * RATE.input +
      (usage.output_tokens || 0) * RATE.output +
      (usage.cache_read_input_tokens || 0) * RATE.cacheRead +
      (usage.cache_creation_input_tokens || 0) * RATE.cacheWrite +
      (usage.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_RATE
    : null;
  await providerCalls.recordTokens({
    householdId, sessionId, provider, purpose,
    inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null,
    cacheReadTokens: usage?.cache_read_input_tokens ?? null, cacheWriteTokens: usage?.cache_creation_input_tokens ?? null,
    costUsd: cost,
  });
  return { costUsd: cost, usage, model };
}

/**
 * Ask Claude for a schema-validated object.
 *
 * `system` must be stable across calls (it is cached); anything that varies —
 * the household, the options on screen, the utterance — goes in `messages`.
 */
export async function parseStructured({
  system,
  messages,
  schema,
  householdId,
  sessionId,
  purpose,
  effort = 'medium',
  model = MODEL,
  thinking = 'adaptive',
  // A long answer needs room: a menu of two hundred dishes does not fit in the
  // planner's default (sources/menuRead.js).
  maxTokens = 4096,
  // Filled in with { costUsd, usage, model } when the caller passes one. An
  // out-parameter rather than a second return value because every existing
  // caller expects the parsed object itself, and the back office is the only
  // place that needs to say what a single call cost.
  meta = null,
}) {
  await assertWithinBounds({ householdId, sessionId });

  const response = await ask(() => client.messages.parse({
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    // A quick read of half a sentence (the live rows) needs speed, not reasoning: thinking off.
    thinking: { type: thinking === 'off' ? 'disabled' : 'adaptive' },
    output_config: { effort, format: zodOutputFormat(schema) },
  }));

  const spend = await recordCall({ householdId, sessionId, provider: 'anthropic', purpose, usage: response.usage, model });
  if (meta) Object.assign(meta, spend);

  if (response.stop_reason === 'refusal') {
    const err = new Error('The planner declined this request');
    err.code = 'refusal';
    err.status = 422;
    throw err;
  }
  if (!response.parsed_output) {
    const err = new Error('The planner returned something that did not match the expected shape');
    err.code = 'unparsed_output';
    err.status = 502;
    throw err;
  }
  return response.parsed_output;
}

/**
 * Ask Claude to look something up on the open web and answer in text.
 *
 * Used by the local scout (events source): Claude searches and reads local
 * what's-on pages for a place and date. Searches are capped per call and the
 * call is written to provider_calls with the per-search charge included, so
 * the spend bounds apply to it exactly as to the planner's own calls.
 */
export async function searchWeb({ system, prompt, householdId, sessionId, purpose, maxSearches = 6, maxFetches = 6, effort = 'medium', meta = null }) {
  await assertWithinBounds({ householdId, sessionId });

  const response = await ask(() => client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
    tools: [
      { type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: maxFetches },
    ],
    thinking: { type: 'adaptive' },
    output_config: { effort },
  }));

  const spend = await recordCall({ householdId, sessionId, provider: 'anthropic', purpose, usage: response.usage });
  if (meta) Object.assign(meta, spend);

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { text, searches: response.usage?.server_tool_use?.web_search_requests ?? 0, stopReason: response.stop_reason };
}

/** Cost and call counts, for the session and for the household this month. */
export async function spendSummary({ householdId, sessionId }) {
  const rows = [await providerCalls.summary(householdId, sessionId)];
  return {
    ...rows[0],
    sessionBound: SESSION_CALL_BOUND,
    householdMonthlyBound: await monthlyBoundFor(householdId),
  };
}
