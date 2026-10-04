// Re-runs: the book follows the story, and only where the story changed.
//
//   1. Line up the messages the ledger was built from with the messages now
//      (align.js). Untouched messages keep their facts, even if they moved.
//   2. Every scene holding a new, edited or deleted message is re-read, whole,
//      in one model call. Facts that cited an edited or deleted message are
//      handed back to the model to restate or drop. A new fact has to cite a
//      new or edited message; nothing else is open to change.
//   3. The canon (every entity, every fact, its provenance) is compiled again
//      in full, so keys stay unique across the whole book.
//   4. The result is diffed against the book (plan.js). Pinned entries,
//      entries edited by hand and entries Canonkeeper didn't write are held
//      exactly as they are. Only the plan's writes reach the book.
//
// An unchanged transcript makes no model call and compiles to the book it
// already has: zero writes.

import { planBudget, estimateTokens, TooLongError } from './budget.js';
import { buildUpdatePrompt } from './prompt.js';
import { compile } from './compile.js';
import { fingerprint } from './fingerprint.js';
import { align } from './align.js';
import { heldEntries, plan, apply } from './plan.js';
import { ask, build, makeLedger, LEDGER_VERSION } from './build.js';

const fold = (s) => s.toLowerCase();

/** The canon a ledger holds: every entity as the model gave it. */
function canonOf(ledger) {
    return ledger.entities.map((e) => ({
        name: e.name,
        keys: [...e.keys],
        facts: e.facts.map((f) => ({ text: f.text, messages: [...f.messages] })),
        caseSensitive: e.caseSensitive,
        cascade: e.cascade,
        throttle: e.throttle,
    }));
}

/**
 * Old scene starts in new ids. A start whose message changed or went stays
 * at the same place: just after the last unchanged message before it.
 */
function remapScenes(boundaries, toNew, count) {
    const out = boundaries.map((b) => {
        if (toNew[b] != null) return toNew[b];
        const before = toNew.slice(0, b).reverse().find((y) => y != null);
        return before == null ? 0 : before + 1;
    });
    return [...new Set(out.filter((b) => b > 0 && b < count))].sort((a, b) => a - b);
}

/** The whole scenes, as inclusive [from, to] ids, that contain a dirty id. */
export function windowsFor(dirty, boundaries, count) {
    const starts = [0, ...boundaries.filter((b) => b > 0 && b < count)];
    const windows = new Map();
    for (const id of dirty) {
        const i = starts.findLastIndex((s) => s <= id);
        windows.set(starts[i], [starts[i], (starts[i + 1] ?? count) - 1]);
    }
    return [...windows.values()].sort((a, b) => a[0] - b[0]);
}

/**
 * Folds what the model found in the changed passages into the canon. A known
 * entity is matched by name, or failing that by a key only it holds, and
 * keeps its flags: they were set from the whole story, the reply saw one
 * part of it.
 *
 * A restated fact goes back where its entity's reopened facts were, with all
 * the sources it had, so the entry reads as it did. Any other fact is new,
 * and something new can only come from a changed message. A fact citing none
 * can only stand in for one of its entity's reopened facts that wasn't
 * restated (a rewording), one for one; past that it is left out. So an entry
 * never grows from unchanged text, and an edit doesn't turn into a
 * re-description of the context around it.
 */
function merge(canon, found, previous, fresh, review) {
    const restated = new Map(previous.map((p) => [`${fold(p.name)}\u0000${fold(p.text)}`, p.messages]));
    const restatedNow = new Set();
    const byName = new Map(canon.map((e) => [fold(e.name), e]));
    const keyOwners = new Map();
    for (const e of canon) for (const k of e.keys) keyOwners.set(fold(k), [...(keyOwners.get(fold(k)) ?? []), e]);
    for (const f of found) {
        const owners = keyOwners.get(fold(f.name)) ?? [];
        const known = byName.get(fold(f.name)) ?? (owners.length === 1 ? owners[0] : null);
        const name = known?.name ?? f.name;
        const reopened = previous.filter((p) => fold(p.name) === fold(name));
        let stand = reopened.length - f.facts.filter((x) => restated.has(`${fold(name)}\u0000${fold(x.text)}`)).length;
        const facts = [];
        for (const fact of f.facts) {
            const before = restated.get(`${fold(name)}\u0000${fold(fact.text)}`);
            if (before) {
                restatedNow.add(`${fold(name)}\u0000${fold(fact.text)}`);
                facts.push({ text: fact.text, messages: [...new Set([...fact.messages, ...before])].sort((x, y) => x - y) });
            }
            else if (fact.messages.some((id) => fresh.has(id))) facts.push(fact);
            else if (stand-- > 0) facts.push(fact);
            else review.push({ name, reason: `new fact cites no changed message; left out: ${fact.text}` });
        }
        if (!facts.length) continue;
        let e = known;
        if (!e) {
            e = { ...f, keys: [], facts: [] };
            canon.push(e);
            byName.set(fold(e.name), e);
        }
        for (const k of f.keys) if (!e.keys.some((x) => fold(x) === fold(k))) e.keys.push(k);
        for (const fact of facts) {
            const same = e.facts.find((x) => fold(x.text) === fold(fact.text));
            if (same) same.messages = [...new Set([...same.messages, ...fact.messages])].sort((x, y) => x - y);
            else {
                const at = e.slot ?? e.facts.length;
                e.facts.splice(at, 0, fact);
                e.slot = at + 1;
            }
        }
    }
    for (const p of previous) {
        if (!restatedNow.has(`${fold(p.name)}\u0000${fold(p.text)}`)) review.push({ name: p.name, reason: `fact from a changed message not restated word for word; dropped: ${p.text}` });
    }
}

/**
 * No usable ledger (none, or an older version): one full build, with every
 * pinned entry and every entry Canonkeeper didn't write held, and entries
 * kept on their uids by title. Then the same diff as any other run.
 */
async function rebuild({ book, messages, generate, contextTokens, maxOutputTokens }) {
    const entries = Object.values(book.entries);
    const held = entries.filter((e) => e.canonkeeper?.pinned || !e.canonkeeper);
    const uids = new Map(entries.map((e) => [fold(e.comment ?? ''), e.uid]));
    const nextUid = Math.max(-1, ...entries.map((e) => e.uid)) + 1;
    const fresh = await build({ messages, generate, contextTokens, maxOutputTokens, pinned: held, uids, nextUid });
    const ops = plan(book, Object.values(fresh.book.entries));
    return {
        book: apply(book, ops),
        scenes: fresh.scenes,
        ledger: fresh.ledger,
        plan: ops,
        held: held.map((e) => ({ uid: e.uid, title: e.comment, reason: e.canonkeeper ? 'pinned' : 'not written by Canonkeeper' })),
        calls: 1,
        wrote: ops.length > 0,
    };
}

/**
 * Brings `book` up to date with `messages`.
 *
 * Returns { book, scenes, ledger, plan, held, calls, wrote }: `plan` is the
 * list of writes made (empty means none), `held` the entries kept as they
 * were and why, `calls` the model calls made. The input book is not mutated.
 */
export async function update({ book, ledger, messages, generate, contextTokens, maxOutputTokens }) {
    if (!messages.length) throw new Error('empty transcript');
    if (ledger?.version !== LEDGER_VERSION) return rebuild({ book, messages, generate, contextTokens, maxOutputTokens });

    const held = heldEntries(book, ledger.written);
    const kept = held.map((h) => h.entry);
    const uids = new Map(ledger.entities.filter((e) => e.uid != null).map((e) => [fold(e.name), e.uid]));
    let canon = canonOf(ledger);
    let scenes = ledger.scenes;
    let budget = ledger.budget;
    const review = [];
    let calls = 0;

    if (fingerprint(messages) !== ledger.fingerprint) {
        const { toNew, fresh, dirty } = align(ledger.hashes, messages);
        scenes = remapScenes(ledger.scenes, toNew, messages.length);
        const windows = windowsFor(dirty, scenes, messages.length);
        const inWindow = (id) => windows.some(([a, b]) => id >= a && id <= b);

        // A fact citing a message that was edited or deleted is reopened: it
        // comes out of the canon and goes to the model to restate or drop.
        // A fact from unchanged messages stands, wherever they now are.
        const previous = [];
        for (const e of canon) {
            const facts = [];
            for (const f of e.facts) {
                const ids = f.messages.map((id) => toNew[id] ?? null);
                if (ids.every((id) => id != null)) facts.push({ text: f.text, messages: ids });
                else {
                    e.slot ??= facts.length;
                    previous.push({ name: e.name, text: f.text, messages: ids.filter((id) => id != null) });
                }
            }
            e.facts = facts;
        }
        scenes = scenes.filter((b) => !windows.some(([a, z]) => b > a && b <= z));

        if (windows.length) {
            budget = planBudget({ contextTokens, maxOutputTokens });
            const prompt = buildUpdatePrompt(messages, windows, canon, previous, new Set(fresh), budget.output);
            const needed = estimateTokens(prompt.system + prompt.user);
            if (needed > budget.input) throw new TooLongError(needed, budget.input);
            budget = { ...budget, promptEstimate: needed, windows };
            let n = 0;
            const counted = (req) => (n++, generate(req));
            const reply = await ask(counted, prompt, budget.output, messages.length);
            calls = n;
            review.push(...reply.review);
            scenes = [...new Set([...scenes, ...reply.scenes.filter(inWindow)])].sort((a, b) => a - b);
            merge(canon, reply.entities, previous, new Set(fresh), review);
        }
        canon = canon.filter((e) => e.facts.length).map(({ slot, ...e }) => e);
    }

    const compiled = compile(canon, messages, { pinned: kept, uids, nextUid: ledger.nextUid });
    const ops = plan(book, compiled.entries);
    return {
        book: apply(book, ops),
        scenes: { boundaries: scenes },
        ledger: makeLedger({
            messages,
            budget,
            scenes,
            compiled,
            review: [...review, ...compiled.review],
            revision: ledger.revision + (ops.length ? 1 : 0),
            held: kept,
            previous: ledger.written,
        }),
        plan: ops,
        held: held.map((h) => ({ uid: h.entry.uid, title: h.entry.comment, reason: h.reason })),
        calls,
        wrote: ops.length > 0,
    };
}
