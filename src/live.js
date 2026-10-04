// Live mode: the book keeps up with a chat while it is being written.
//
// Two triggers, each of which fires once:
//
//   1. Detection, on a cadence. Once `cadence` messages are waiting to be
//      judged, one call to a cheap model reads them, with the open scene
//      before them as context and the newest message after them, and reports
//      where new scenes start. The newest message is only shown, not judged:
//      read with nothing after it, the end of a scene looks like a cut, and
//      the cut lands one message too early. Every message is judged once. N
//      messages make about N/cadence calls, not N: a message arriving doesn't
//      make a call, enough of them do.
//   2. The update, on an edge. A scene start means the scene before it has
//      ended. When the end of the last finished scene moves forward, the
//      transcript up to it goes to step 2's update(), which re-reads only the
//      scenes that are new or changed. The open scene waits until it ends.
//
// Pure, like the rest of the core. The adapter (and harness/live-sim.js)
// hands in the messages and the models, and stores what comes back.

import { planBudget, estimateTokens, TooLongError } from './budget.js';
import { renderTranscript } from './prompt.js';
import { extractJson, ModelOutputError } from './parse.js';
import { fingerprint, messageHash } from './fingerprint.js';
import { ask } from './build.js';

export const LIVE_VERSION = 1;
export const DEFAULT_CADENCE = 4;
/** Room for the detector's reply: a short list of ids, plus any thinking a host turns on. */
export const DETECT_OUTPUT = 4096;
/** At most this share of the detector's prompt budget goes to context before the new messages. */
const CONTEXT_SHARE = 0.5;
/** The cycle log in the state store keeps this many. */
export const CYCLES_KEPT = 200;

export const DETECT_SYSTEM = `You follow a roleplay story as it is written and say where new scenes start. A new scene starts at a message that does not pick up where the message before it left off: the story skips ahead in time, or moves to another place or situation, and leaves out what happened in between. A bracketed narrator header such as "[Place · Scene · Day]" marks a new scene. Without a header, compare each message with the one just before it. If it carries straight on (a reply, the next action, the characters moving on while the story follows them), it is the same scene, however much happens in it or however far they go. For each scene start, say what the story leaves out between that message and the one before it. Return only the JSON object. No prose, no code fences.`;

/**
 * The detector's prompt: the open scene so far (contextFrom..judgeFrom-1,
 * already judged), the messages to judge (judgeFrom..to) and the message
 * after them (to+1), shown so a cut can be put where it lands.
 */
export function buildDetectPrompt(messages, { contextFrom, judgeFrom, to }) {
    const ctx = contextFrom < judgeFrom
        ? `<scene_so_far from="${contextFrom}" to="${judgeFrom - 1}">\n${renderTranscript(messages.slice(contextFrom, judgeFrom))}\n</scene_so_far>\n\n`
        : '';
    const first = Math.max(1, judgeFrom);
    const said = contextFrom < judgeFrom
        ? `<scene_so_far> is the scene the story is in${contextFrom > 0 ? `; it started at message ${contextFrom}` : ''}. It was already judged.`
        : 'These are the first messages of the story; message 0 starts the first scene.';
    const next = messages[to + 1];
    const after = next ? `\n\n<next>\n${renderTranscript([next])}\n</next>` : '';
    return {
        system: DETECT_SYSTEM,
        user: `${said} <new> holds the messages written since${next ? `, and <next> the one written after them, which you don't judge yet: it shows where the story goes next` : ''}. Report every message from ${first} to ${to} at which a new scene starts, in exactly this shape:\n{ "starts": [ { "id": <message id>, "left_out": "<what happened between the message before it and this one>" } ] }\n\nMost messages continue the scene they are in, so an empty list is often the right answer.\n\n${ctx}<new from="${judgeFrom}" to="${to}">\n${renderTranscript(messages.slice(judgeFrom, to + 1))}\n</new>${after}`,
    };
}

/** Reads the detector's reply. Strict JSON; an id outside the judged range is ignored. */
export function readStarts(text, from, to) {
    const data = extractJson(text);
    if (!data || typeof data !== 'object' || !Array.isArray(data.starts)) throw new ModelOutputError("reply needs a 'starts' array");
    const ids = data.starts.map((s) => (s && typeof s === 'object' ? s.id ?? s.start : s));
    const starts = [...new Set(ids.filter((n) => Number.isInteger(n) && n >= Math.max(1, from) && n <= to))].sort((a, b) => a - b);
    return { starts, ignored: ids.filter((n) => !starts.includes(n)) };
}

/**
 * A fresh live state. When the chat already has a ledger that covers an
 * unchanged start of the chat (a /canon run), that part counts as judged and
 * its scene starts as found: live mode carries on from the book it has.
 */
export function seed(ledger, messages) {
    const now = messages.map(messageHash);
    let covered = 0;
    if (ledger?.hashes) {
        while (covered < ledger.hashes.length && covered < now.length && ledger.hashes[covered] === now[covered]) covered++;
        if (covered < ledger.hashes.length) covered = 0;
    }
    return {
        version: LIVE_VERSION,
        hashes: now.slice(0, covered),
        starts: covered ? (ledger.scenes ?? []).filter((b) => b > 0 && b < covered) : [],
        detectCalls: 0,
        updates: 0,
        retryAt: 0,
        cycles: [],
    };
}

export const isLive = (live) => live?.version === LIVE_VERSION && Array.isArray(live.hashes) && Array.isArray(live.starts);

/**
 * Lines the live state up with the chat now. A message the detector judged
 * that was edited, swiped or deleted is judged again, and so is everything
 * after it; scene starts found from it are dropped.
 */
export function rewind(live, messages) {
    let same = 0;
    while (same < live.hashes.length && same < messages.length && live.hashes[same] === messageHash(messages[same])) same++;
    if (same === live.hashes.length) return { live, rewound: null };
    return {
        live: { ...live, hashes: live.hashes.slice(0, same), starts: live.starts.filter((s) => s < same), retryAt: 0 },
        rewound: same,
    };
}

/**
 * What the detector reads next: the unjudged messages that fit, but not the
 * newest, which is shown after them; and before them as much of the open
 * scene as fits in its share of the budget. Null when fewer than `cadence`
 * messages are waiting to be judged.
 */
export function detectRange(live, messages, { cadence, input }) {
    const judgeFrom = live.hashes.length;
    const last = messages.length - 2; // the newest message is look-ahead
    if (last - judgeFrom + 1 < Math.max(1, cadence) || messages.length < live.retryAt) return null;
    const cost = (m) => estimateTokens(`#${m.id} ${m.name}: ${m.text}\n\n`);
    const overhead = estimateTokens(DETECT_SYSTEM) + 400;
    let to = judgeFrom - 1;
    let used = overhead;
    while (to < last && used + cost(messages[to + 1]) + cost(messages[to + 2]) <= input) used += cost(messages[++to]);
    if (to < judgeFrom) throw new TooLongError(overhead + cost(messages[judgeFrom]) + cost(messages[judgeFrom + 1]), input);
    used += cost(messages[to + 1]);
    const open = live.starts.filter((s) => s <= judgeFrom).pop() ?? 0;
    let contextFrom = judgeFrom;
    const room = Math.min(input - used, Math.floor(input * CONTEXT_SHARE));
    let ctx = 0;
    while (contextFrom > open && ctx + cost(messages[contextFrom - 1]) <= room) ctx += cost(messages[--contextFrom]);
    return { contextFrom, judgeFrom, to };
}

/**
 * One detection, if one is due. Returns { live, detection }: `detection` is
 * null when no call was due, else what was judged and found (or the error).
 * A failed call is tried again after `cadence` more messages, not on every
 * message.
 */
export async function detect({ live, messages, generate, cadence = DEFAULT_CADENCE, contextTokens }) {
    const budget = planBudget({ contextTokens, maxOutputTokens: DETECT_OUTPUT, outputShare: 0.25 });
    let range;
    try {
        range = detectRange(live, messages, { cadence, input: budget.input });
    } catch (err) {
        return { live: { ...live, retryAt: messages.length + cadence }, detection: { ok: false, error: err.message } };
    }
    if (!range) return { live, detection: null };
    const { contextFrom, judgeFrom, to } = range;
    let calls = 0;
    const counted = (req) => (calls++, generate(req));
    const started = Date.now();
    try {
        const prompt = buildDetectPrompt(messages, range);
        const found = await ask(counted, prompt, budget.output, messages.length, (text) => readStarts(text, judgeFrom, to));
        return {
            live: {
                ...live,
                hashes: [...live.hashes, ...messages.slice(judgeFrom, to + 1).map(messageHash)],
                starts: [...live.starts, ...found.starts],
                detectCalls: live.detectCalls + calls,
                retryAt: 0,
            },
            detection: { ok: true, context: [contextFrom, judgeFrom - 1], judged: [judgeFrom, to], starts: found.starts, calls, ms: Date.now() - started },
        };
    } catch (err) {
        return {
            live: { ...live, detectCalls: live.detectCalls + calls, retryAt: messages.length + cadence },
            detection: { ok: false, judged: [judgeFrom, to], calls, error: err.message, ms: Date.now() - started },
        };
    }
}

/**
 * How many messages the book should cover now: through the end of the last
 * finished scene, or further if the ledger already covers more (a /canon run
 * that read the open scene too). 0 when the ledger already matches exactly.
 */
export function updateTarget(live, ledger, messages) {
    const closed = live.starts.at(-1) ?? 0;
    const covered = Math.min(ledger?.messageCount ?? 0, messages.length);
    const target = Math.max(closed, covered);
    if (!target) return 0;
    if (ledger && ledger.fingerprint === fingerprint(messages.slice(0, target))) return 0;
    // A failed update is tried again when another scene ends or after
    // `cadence` more messages, not on every message.
    if (live.failedTarget === target && messages.length < (live.updateRetryAt ?? 0)) return 0;
    return target;
}

/** Appends a cycle to the log, keeping the last CYCLES_KEPT. */
export function logCycle(live, cycle) {
    return { ...live, cycles: [...(live.cycles ?? []), cycle].slice(-CYCLES_KEPT) };
}
