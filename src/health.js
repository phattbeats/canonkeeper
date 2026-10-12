// Health: whether live mode is working, kept per chat in the state store.
//
// A set-it-and-forget-it program has to say when it isn't working. Every
// live failure path reports an event here ({ kind, ok, error? }); this module
// folds events into one small record and says which of them the person must
// be told about (a first failure, or a kind that wasn't failing before: not
// every retry of the same one).
//
// Pure, like the rest of the core. The adapter stores the record, shows the
// badge and raises the toasts.

export const HEALTH_VERSION = 1;
/** The failure history keeps this many. */
export const HISTORY_KEPT = 10;

/** What can fail, in the words the status view uses. */
export const KINDS = Object.freeze({
    profile: 'No connection profile',
    detector: 'Scene detection',
    update: 'Book update',
    audit: 'Audit after an update',
    timeout: 'Model call timed out',
    stale: 'Book or chat changed mid-update',
    tick: 'Live mode error',
    stalled: 'Live mode stalled',
});

export class TimeoutError extends Error {
    constructor(seconds) {
        super(`the model did not answer within ${seconds}s`);
        this.name = 'TimeoutError';
    }
}

export const emptyHealth = () => ({ version: HEALTH_VERSION, lastSuccess: null, lastFailure: null, consecutive: 0, failing: {}, history: [], stalledNotified: false });

const text = (e) => String(e?.message ?? e ?? '');

/**
 * Which kind an error belongs to. `where` is the step that was running
 * ('detector', 'update' or 'audit'); a timeout or a mid-update change is its
 * own kind wherever it happened.
 */
export function classify(where, error) {
    const msg = text(error);
    if (error?.name === 'TimeoutError' || /did not answer within/.test(msg)) return 'timeout';
    if (/changed during the run|was switched during/.test(msg)) return 'stale';
    return where;
}

/**
 * The plain-language cause and the fix for an error message. Matches what
 * SillyTavern's connection manager and the providers actually say; anything
 * else falls back to a generic cause with the raw message kept alongside.
 */
export function explain(kind, error, profileName = '') {
    const msg = text(error);
    const who = profileName ? `profile ${profileName}` : 'the profile';
    if (kind === 'profile') return { cause: 'Live mode is on but no connection profile is picked, so nothing can be written.', fix: 'Pick a connection profile in Extensions → Canonkeeper.' };
    if (kind === 'timeout') return { cause: `${msg[0]?.toUpperCase() ?? ''}${msg.slice(1)}.`, fix: `Check that ${who}'s server is up and not overloaded, or pick a faster model for this step.` };
    if (kind === 'stale') return { cause: 'The lorebook or the chat was edited while the update was running, so nothing was written.', fix: 'Nothing to do: it tries again after the next scene or a few more messages. Avoid editing the book while live mode is writing.' };
    const status = /\b(401|403)\b|unauthori[sz]ed|invalid.*(api )?key|api key/i.test(msg) ? 'auth'
        : /\b429\b|rate.?limit|quota|insufficient|credit|billing/i.test(msg) ? 'limit'
        : /\b(404)\b|not found|no such model|model.*(does not exist|unknown)/i.test(msg) ? 'model'
        : /\b(500|502|503|504|529)\b|overloaded|bad gateway|unavailable/i.test(msg) ? 'server'
        : /API request failed|request failed|ECONNREFUSED|ENOTFOUND|fetch failed|network|failed to fetch|socket/i.test(msg) ? 'network'
        : /reply|JSON|parse|empty|cut off|needs a/i.test(msg) && kind === 'detector' ? 'reply'
        : null;
    if (status === 'auth') return { cause: `${cap(who)} was refused (${msg}).`, fix: `Check ${who}'s API key in Connection Profiles.` };
    if (status === 'limit') return { cause: `${cap(who)} hit a rate or spending limit (${msg}).`, fix: 'Wait, or add credit / raise the limit with the provider, or pick another profile.' };
    if (status === 'model') return { cause: `${cap(who)} names a model the provider does not have (${msg}).`, fix: `Edit ${who} and pick a model that exists.` };
    if (status === 'server') return { cause: `The provider for ${who} is failing on its side (${msg}).`, fix: 'Usually passes by itself; Canonkeeper tries again. If it keeps happening, pick another profile.' };
    if (status === 'network') return { cause: `${cap(who)} could not be reached or refused the request (${msg}).`, fix: 'Check the profile\'s URL and API key, and that the server or proxy is running.' };
    if (status === 'reply') return { cause: `The model answered, but not in a form Canonkeeper can read (${msg}).`, fix: 'Pick a more capable model for scene detection.' };
    return { cause: `${KINDS[kind] ?? kind} failed: ${msg || 'no reason given'}.`, fix: 'Run /canon, or open the Run log in the status view for the details.' };
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

/**
 * Folds events into the record. Each event is { kind, ok, error?, profile? };
 * a success of a kind clears that kind. Returns { health, notify }: `notify`
 * is the failures to toast, each with its cause and fix: those whose kind
 * wasn't already failing.
 */
export function record(health, events, { at = new Date().toISOString() } = {}) {
    const h = { ...(health?.version === HEALTH_VERSION ? health : emptyHealth()) };
    h.failing = { ...h.failing };
    h.history = [...h.history];
    const notify = [];
    for (const e of events) {
        // One failure at a time per step; its kind says what went wrong.
        const step = e.where ?? e.kind;
        if (e.ok) {
            delete h.failing[step];
            // Being well-configured is not work done: only real steps count as a success.
            if (step !== 'profile' && step !== 'tick') h.lastSuccess = { kind: step, at };
            continue;
        }
        const what = { ...explain(e.kind, e.error, e.profile), error: text(e.error) };
        const entry = { kind: e.kind, step, at, ...what };
        const prior = h.failing[step];
        const fresh = !prior || prior.kind !== e.kind;
        h.failing[step] = { kind: e.kind, at: fresh ? at : prior.at, last: at, count: fresh ? 1 : prior.count + 1, ...what };
        h.lastFailure = entry;
        h.consecutive += 1;
        h.history = [...h.history, entry].slice(-HISTORY_KEPT);
        if (fresh) notify.push(entry);
    }
    // Successes end the run of failures only once nothing is failing.
    if (!Object.keys(h.failing).length) h.consecutive = 0;
    return { health: h, notify };
}

/** Failing right now: the badge shows while this is true. */
export const unhealthy = (health) => Object.keys(health?.failing ?? {}).length > 0;

/** The badge's level: red for anything that stops the book being kept up, amber otherwise. */
export function severity(health) {
    const kinds = Object.values(health?.failing ?? {}).map((f) => f.kind);
    if (!kinds.length) return null;
    return kinds.some((k) => k === 'profile' || k === 'detector' || k === 'update' || k === 'stalled') ? 'red' : 'amber';
}

/** Default: this many messages waiting with no successful detection is a stall. */
export const stallAfter = (cadence) => Math.max(8, 3 * Math.max(1, cadence) + 1);

/**
 * Live mode has stalled when `stallAfter` messages are waiting to be judged:
 * detection is due every `cadence` messages, so a backlog this deep means it
 * hasn't been succeeding (or running). Needs the live state; with none, the
 * missing-profile failure is the signal.
 */
export function stalled(live, messageCount, cadence) {
    if (!live?.hashes) return false;
    return messageCount - live.hashes.length >= stallAfter(cadence);
}

/**
 * Sets the stalled flag from the chat now. Returns { health, notify }:
 * `notify` is a stall entry the first time it begins, and none while it goes on.
 */
export function noteStall(health, isStalled, { waiting = 0, at = new Date().toISOString() } = {}) {
    const h = health?.version === HEALTH_VERSION ? health : emptyHealth();
    if (!isStalled) return { health: h.stalledNotified ? { ...h, stalledNotified: false, failing: omit(h.failing, 'stalled') } : h, notify: [] };
    if (h.stalledNotified) return { health: h, notify: [] };
    const what = { cause: `Live mode has stalled: ${waiting} messages are waiting and none has been judged successfully.`, fix: 'Look at the failures listed in the status view; the first one is usually the reason.', error: '' };
    const entry = { kind: 'stalled', step: 'stalled', at, ...what };
    return {
        health: { ...h, stalledNotified: true, failing: { ...h.failing, stalled: { at, last: at, count: 1, ...what } }, lastFailure: entry, history: [...h.history, entry].slice(-HISTORY_KEPT) },
        notify: [entry],
    };
}

const omit = (o, k) => Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));
