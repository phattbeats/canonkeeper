// The chunked fallback, for a story too long for the window.
//
// The story is read in parts, in order, each sized from the window. One
// ledger is carried across the parts: every part sees the entities the
// earlier parts found, by name, keys and facts, so a known entity comes back
// under the name it already has and only gains what the part adds. A part
// also sees the end of the previous one, as context, so a name that spans
// the cut can be followed across it.
//
// Scene starts are only judged well in the flow of the story: read cold, the
// first message of a part looks like a beginning, so a part never decides
// whether a scene starts at its own first message. Where the cut falls is
// chosen so that it doesn't have to. When a part's last scene starts past
// its first third, that unfinished scene is handed to the next part, which reads
// it whole, and the cut falls on a scene start the part already found. When
// the cut falls mid-scene, the part also sees the next part's first message,
// and decides whether a scene starts there.
//
// A part can't see what comes after it, so one real entity can still come
// out twice: under an epithet early on and its name later. One last call,
// with a budget of its own, reads the whole entity list (no transcript) and
// names those pairs; code merges them. Then the canon is compiled exactly as
// a one-shot build's is, so the same invariants hold. The ledger records
// that the book was built in parts, and how.

import { estimateTokens, TooLongError } from './budget.js';
import { buildPartPrompt, buildReconcilePrompt, renderRoster, sceneRange } from './prompt.js';
import { readMerges } from './parse.js';
import { compile } from './compile.js';
import { ask, toBook, makeLedger } from './build.js';

const fold = (s) => s.toLowerCase();

/** The previous part's tail, shown as context, may take this share of the prompt budget. */
export const CONTEXT_SHARE = 0.1;

/** Past this share of the prompt budget, the roster drops the facts and keeps names and keys. */
export const ROSTER_SHARE = 1 / 3;

/**
 * A part's last scene is handed to the next part when it starts past this
 * share of the part. Lower re-reads more; higher cuts mid-scene more often,
 * where only the one message of look-ahead decides the cut.
 */
export const HANDOVER_AFTER = 1 / 3;

/** The reconciliation reply is a short list of names; it gets at most this much output. */
export const RECONCILE_OUTPUT = 8000;

const cost = (m) => estimateTokens(`#${m.id} ${m.name}: ${m.text}\n\n`);

/**
 * The context for a part starting at `from`: the messages just before it,
 * back to the last scene start, as far as CONTEXT_SHARE of the budget goes.
 */
function contextFor(messages, from, scenes, input) {
    if (from === 0) return null;
    const lastStart = Math.max(0, ...[...scenes].filter((s) => s < from));
    let room = Math.floor(input * CONTEXT_SHARE);
    let start = from;
    while (start > lastStart && cost(messages[start - 1]) <= room) room -= cost(messages[--start]);
    return start < from ? [start, from - 1] : null;
}

/**
 * The longest part from `from` whose whole prompt fits the window. Throws
 * TooLongError when not even one message fits beside the roster.
 */
function sizePart(messages, from, part, known, scenes, budget) {
    const brief = estimateTokens(renderRoster(known)) > budget.input * ROSTER_SHARE;
    const context = contextFor(messages, from, scenes, budget.input);
    const prompt = (to) => buildPartPrompt(messages, { part, from, to, context, known, brief, outputTokens: budget.output });
    const fixed = prompt(from - 1);
    let left = budget.input - estimateTokens(fixed.system + fixed.user) - 50; // 50: the ids in the header grow
    let to = from - 1;
    while (to + 1 < messages.length && cost(messages[to + 1]) <= left) left -= cost(messages[++to]);
    // The estimate is per message, so check the real prompt and step back if needed.
    for (; to >= from; to--) {
        const p = prompt(to);
        const needed = estimateTokens(p.system + p.user);
        if (needed <= budget.input) return { to, context, brief, prompt: p, needed };
    }
    const one = prompt(from);
    throw new TooLongError(estimateTokens(one.system + one.user), budget.input);
}

/**
 * Folds one part's reply into the canon. A known entity is matched by name,
 * or failing that by a key only it holds, and gains new keys and facts; a
 * fact it already has gains the new sources. A new name that lists exactly
 * one known entity's name among its keys is that entity, now properly named:
 * it takes the new name and keeps the old one as a key. A fact must cite the
 * part itself: the model saw nothing else, so a citation outside it is a
 * guess.
 */
function absorb(canon, found, from, to, review, renamed, read = to) {
    const byName = new Map(canon.map((e) => [fold(e.name), e]));
    const keyOwners = new Map();
    const own = (k, e) => keyOwners.set(fold(k), [...new Set([...(keyOwners.get(fold(k)) ?? []), e])]);
    for (const e of canon) for (const k of e.keys) own(k, e);
    for (const f of found) {
        const facts = f.facts
            .map((x) => ({ text: x.text, messages: x.messages.filter((id) => id >= from && id <= to) }))
            .filter((x) => x.messages.length);
        // A fact from the handed-over scene (to, read] is the next part's to report.
        const outside = f.facts.filter((x) => !x.messages.some((id) => id >= from && id <= read)).length;
        if (outside) review.push({ name: f.name, reason: `${outside} fact(s) cited only messages outside part ${from}-${to}; left out` });
        if (!facts.length) continue;
        const owners = keyOwners.get(fold(f.name)) ?? [];
        let e = byName.get(fold(f.name)) ?? (owners.length === 1 ? owners[0] : null);
        const named = e ? [] : [...new Set(f.keys.map((k) => byName.get(fold(k))).filter(Boolean))];
        if (named.length === 1) {
            e = named[0];
            byName.delete(fold(e.name));
            if (!e.keys.some((x) => fold(x) === fold(e.name))) e.keys.push(e.name);
            own(e.name, e);
            renamed.push({ from: e.name, to: f.name });
            e.name = f.name;
            byName.set(fold(e.name), e);
        }
        if (!e) {
            e = { ...f, keys: [], facts: [] };
            canon.push(e);
            byName.set(fold(e.name), e);
        } else {
            e.caseSensitive ||= f.caseSensitive;
            e.cascade &&= f.cascade;
            e.throttle = Math.max(e.throttle, f.throttle);
        }
        for (const k of f.keys) {
            if (e.keys.some((x) => fold(x) === fold(k))) continue;
            e.keys.push(k);
            own(k, e);
        }
        addFacts(e, facts);
    }
}

function addFacts(e, facts) {
    for (const fact of facts) {
        const same = e.facts.find((x) => fold(x.text) === fold(fact.text));
        if (same) same.messages = [...new Set([...same.messages, ...fact.messages])].sort((a, b) => a - b);
        else e.facts.push({ text: fact.text, messages: [...fact.messages] });
    }
}

/**
 * The reconciliation pass: one call over the whole entity list, with its own
 * budget. If even the brief list doesn't fit, the parts stay unreconciled and
 * the review list says so. Returns the record kept in the ledger.
 */
async function reconcile(canon, generate, budget, messageCount, review) {
    if (canon.length < 2) return { ran: false, reason: 'fewer than two entities' };
    const output = Math.min(budget.output, RECONCILE_OUTPUT);
    const input = budget.contextTokens - output;
    let brief = false;
    let prompt = buildReconcilePrompt(canon);
    if (estimateTokens(prompt.system + prompt.user) > input) prompt = buildReconcilePrompt(canon, { brief: (brief = true) });
    const needed = estimateTokens(prompt.system + prompt.user);
    if (needed > input) {
        review.push({ name: '(reconciliation)', reason: `the entity list needs ~${needed} prompt tokens but only ${input} fit; the parts were not reconciled` });
        return { ran: false, reason: 'entity list does not fit the window', promptEstimate: needed };
    }
    const reply = await ask(generate, prompt, output, messageCount, (text) => readMerges(text, canon));
    review.push(...reply.review);
    const byName = new Map(canon.map((e) => [e.name, e]));
    for (const { keep, same } of reply.merges) {
        const into = byName.get(keep);
        for (const name of same) {
            const e = byName.get(name);
            for (const k of [...e.keys, e.name]) if (!into.keys.some((x) => fold(x) === fold(k))) into.keys.push(k);
            addFacts(into, e.facts);
            into.caseSensitive ||= e.caseSensitive;
            into.cascade &&= e.cascade;
            into.throttle = Math.max(into.throttle, e.throttle);
            canon.splice(canon.indexOf(e), 1);
        }
    }
    return { ran: true, merges: reply.merges, promptEstimate: needed, output, brief };
}

/**
 * Builds the book in parts. Same inputs and outputs as build(), which calls
 * this when the story doesn't fit; `ledger.chunked` records the parts and the
 * reconciliation, so the result is never taken for a one-shot build.
 */
export async function buildChunked({ messages, generate, budget, pinned = [], foreign = [], uids, nextUid }) {
    const canon = [];
    const scenes = new Set();
    const review = [];
    const parts = [];
    const renamed = [];
    let calls = 0;
    const counted = (req) => (calls++, generate(req));

    for (let from = 0, part = 1; from < messages.length; part++) {
        const { to, context, brief, prompt, needed } = sizePart(messages, from, part, canon, scenes, budget);
        const reply = await ask(counted, prompt, budget.output, messages.length);
        // The last scene, unless it started early in the part, goes to the next part.
        const handover = to + 1 < messages.length ? Math.max(-1, ...reply.scenes.filter((s) => s > from + (to - from) * HANDOVER_AFTER && s <= to)) : -1;
        const end = handover > 0 ? handover - 1 : to;
        const [s0, s1] = sceneRange(from, end, messages.length);
        for (const s of reply.scenes) if (s >= s0 && s <= s1) scenes.add(s);
        review.push(...reply.review);
        absorb(canon, reply.entities, from, end, review, renamed, to);
        parts.push({ part, from, to: end, ...(end < to ? { read: to } : {}), context, promptEstimate: needed, ...(brief ? { brief } : {}) });
        from = end + 1;
    }
    const reconciliation = await reconcile(canon, counted, budget, messages.length, review);

    const boundaries = [...scenes].sort((a, b) => a - b);
    const compiled = compile(canon, messages, { pinned, foreign, uids, nextUid });
    return {
        book: toBook(compiled.entries),
        scenes: { boundaries },
        ledger: makeLedger({
            messages,
            budget: { ...budget, promptEstimate: Math.max(...parts.map((p) => p.promptEstimate)) },
            scenes: boundaries,
            compiled,
            review: [...review, ...compiled.review],
            revision: 1,
            held: pinned,
            chunked: { parts, renamed, reconciliation, calls },
        }),
    };
}
