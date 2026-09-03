// Claude access for the conversational planner.
//
// One wrapper, so every call is attributed to a household and a session and
// written to provider_calls (Requirements §5 "Spend containment"; Technical
// Constraints §14). Structured outputs are used throughout: the planner never
// parses prose, it receives a schema-validated object.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { query } from './db.js';

export const MODEL = 'claude-opus-5';

// Per-session and per-household bounds (Epic 3 C10). Overridable by env so
// they can be tuned without a deploy; the numbers themselves are open (A5).
export const SESSION_CALL_BOUND = Number(process.env.ROAM_SESSION_CALL_BOUND || 40);
export const HOUSEHOLD_MONTHLY_CALL_BOUND = Number(process.env.ROAM_HOUSEHOLD_MONTHLY_CALL_BOUND || 3000);

// Indicative list rates for Claude Opus 5 ($ per token), for the cost-per-session
// instrumentation. Cache rates are approximate; the point is the trend.
const RATE = { input: 5 / 1e6, output: 25 / 1e6, cacheRead: 0.5 / 1e6, cacheWrite: 6.25 / 1e6 };
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

export async function assertWithinBounds({ householdId, sessionId }) {
  const [{ rows: s }, { rows: h }] = await Promise.all([
    query('select count(*)::int as n from provider_calls where session_id = $1', [sessionId]),
    query(
      `select count(*)::int as n from provider_calls
        where household_id = $1 and created_at >= date_trunc('month', now())`,
      [householdId],
    ),
  ]);
  if (s[0].n >= SESSION_CALL_BOUND) throw new SpendBoundError('session', SESSION_CALL_BOUND);
  if (h[0].n >= HOUSEHOLD_MONTHLY_CALL_BOUND) throw new SpendBoundError('household', HOUSEHOLD_MONTHLY_CALL_BOUND);
}

async function recordCall({ householdId, sessionId, provider, purpose, usage }) {
  const cost = usage
    ? (usage.input_tokens || 0) * RATE.input +
      (usage.output_tokens || 0) * RATE.output +
      (usage.cache_read_input_tokens || 0) * RATE.cacheRead +
      (usage.cache_creation_input_tokens || 0) * RATE.cacheWrite +
      (usage.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_RATE
    : null;
  await query(
    `insert into provider_calls
       (household_id, session_id, provider, purpose, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, estimated_cost_usd)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      householdId, sessionId, provider, purpose,
      usage?.input_tokens ?? null, usage?.output_tokens ?? null,
      usage?.cache_read_input_tokens ?? null, usage?.cache_creation_input_tokens ?? null,
      cost,
    ],
  );
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
}) {
  await assertWithinBounds({ householdId, sessionId });

  const response = await client.messages.parse({
    model,
    max_tokens: 4096,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    thinking: { type: 'adaptive' },
    output_config: { effort, format: zodOutputFormat(schema) },
  });

  await recordCall({ householdId, sessionId, provider: 'anthropic', purpose, usage: response.usage });

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
export async function searchWeb({ system, prompt, householdId, sessionId, purpose, maxSearches = 6, maxFetches = 6, effort = 'medium' }) {
  await assertWithinBounds({ householdId, sessionId });

  const response = await client.messages.create({
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
  });

  await recordCall({ householdId, sessionId, provider: 'anthropic', purpose, usage: response.usage });

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { text, searches: response.usage?.server_tool_use?.web_search_requests ?? 0, stopReason: response.stop_reason };
}

/** Cost and call counts, for the session and for the household this month. */
export async function spendSummary({ householdId, sessionId }) {
  const { rows } = await query(
    `select
       count(*) filter (where session_id = $2)::int                                   as session_calls,
       coalesce(sum(estimated_cost_usd) filter (where session_id = $2), 0)::float      as session_cost_usd,
       count(*) filter (where created_at >= date_trunc('month', now()))::int          as month_calls,
       coalesce(sum(estimated_cost_usd) filter (where created_at >= date_trunc('month', now())), 0)::float as month_cost_usd
     from provider_calls where household_id = $1`,
    [householdId, sessionId],
  );
  return {
    ...rows[0],
    sessionBound: SESSION_CALL_BOUND,
    householdMonthlyBound: HOUSEHOLD_MONTHLY_CALL_BOUND,
  };
}
