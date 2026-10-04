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
//      exactly as they are. An entry a human deleted stays deleted. Only the
//      plan's writes reach the book.
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

/** Scene starts handed in (live mode), inside the transcript. */
const sceneStarts = (starts, count) => [...new Set(starts.filter((b) => b > 0 && b < count))].sort((a, b) => a - b);

/** A rebuild's result with the scene starts handed in instead of the model's. */
function withScenes(out, starts, count) {
    const scenes = sceneStarts(starts, count);
    return { ...out, scenes: { boundaries: scenes }, ledger: { ...out.ledger, scenes } };
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
 * Read one scene at a time, a story can call someone by an epithet before it
 * names them, so one real entity can be on the books twice. When the reply
 * lists a known entity's name among the keys of another, they are one: a new
 * name that lists exactly one known entity is that entity, now properly
 * named, and takes the new name, keeping the old one as a key and its uid;
 * a known entity listed by another known one is folded into it, keys, facts
 * and all. `renamed` records both, as { from, to }.
 *
 * A restated fact goes back where its entity's reopened facts were, with all
 * the sources it had, so the entry reads as it did. Any other fact is new,
 * and something new can only come from a changed message. A fact citing none
 * can only stand in for one of its entity's reopened facts that wasn't
 * restated (a rewording), one for one; past that it is left out. So an entry
 * never grows from unchanged text, and an edit doesn't turn into a
 * re-description of the context around it.
 */
function merge(canon, found, previous, fresh, review, renamed) {
    const byName = new Map(canon.map((e) => [fold(e.name), e]));
    const keyOwners = new Map();
    const own = (k, e) => keyOwners.set(fold(k), [...new Set([...(keyOwners.get(fold(k)) ?? []), e])]);
    for (const e of canon) for (const k of e.keys) own(k, e);
    // A name an entity no longer goes by still leads to it, so a reopened
    // fact filed under the old name can be restated under the new one.
    const alias = new Map();
    const current = (name) => alias.get(fold(name))?.name ?? name;
    const tag = (name, text) => `${fold(current(name))}\u0000${fold(text)}`;
    const restatedFrom = (name, text) => previous.find((p) => tag(p.name, p.text) === tag(name, text))?.messages;
    const restatedNow = new Set();
    // "Magistrate" lists the entity known as "the Magistrate".
    const listedAs = (k) => byName.get(fold(k)) ?? byName.get(`the ${fold(k)}`) ?? byName.get(fold(k).replace(/^the /, ''));
    for (const f of found) {
        const owners = keyOwners.get(fold(f.name)) ?? [];
        let known = byName.get(fold(f.name)) ?? (owners.length === 1 ? owners[0] : null);
        const listed = [...new Set(f.keys.map(listedAs).filter((x) => x && x !== known))];
        if (!known && listed.length === 1) {
            known = listed.shift();
            byName.delete(fold(known.name));
            alias.set(fold(known.name), known);
            if (!known.keys.some((x) => fold(x) === fold(known.name))) known.keys.push(known.name);
            own(known.name, known);
            renamed.push({ from: known.name, to: f.name });
            review.push({ name: f.name, reason: `the story names "${known.name}"; renamed, same entry` });
            known.name = f.name;
            byName.set(fold(known.name), known);
        }
        for (const other of known ? listed : []) {
            for (const k of [other.name, ...other.keys]) {
                if (!known.keys.some((x) => fold(x) === fold(k))) known.keys.push(k);
                own(k, known);
            }
            for (const fact of other.facts) {
                const same = known.facts.find((x) => fold(x.text) === fold(fact.text));
                if (same) same.messages = [...new Set([...same.messages, ...fact.messages])].sort((x, y) => x - y);
                else known.facts.push(fact);
            }
            known.caseSensitive ||= other.caseSensitive;
            known.cascade &&= other.cascade;
            known.throttle = Math.max(known.throttle, other.throttle);
            byName.delete(fold(other.name));
            alias.set(fold(other.name), known);
            for (const [k, v] of keyOwners) keyOwners.set(k, v.filter((x) => x !== other));
            canon.splice(canon.indexOf(other), 1);
            renamed.push({ from: other.name, to: known.name });
            review.push({ name: known.name, reason: `"${other.name}" is the same entity; merged into this entry` });
        }
        const name = known?.name ?? f.name;
        const reopened = previous.filter((p) => fold(current(p.name)) === fold(name));
        let stand = reopened.length - f.facts.filter((x) => restatedFrom(name, x.text)).length;
        const facts = [];
        for (const fact of f.facts) {
            const before = restatedFrom(name, fact.text);
            if (before) {
                restatedNow.add(tag(name, fact.text));
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
        for (const k of f.keys) {
            if (e.keys.some((x) => fold(x) === fold(k))) continue;
            e.keys.push(k);
            own(k, e);
        }
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
        if (!restatedNow.has(tag(p.name, p.text))) review.push({ name: current(p.name), reason: `fact from a changed message not restated word for word; dropped: ${p.text}` });
    }
}

/**
 * No usable ledger (none, or an older version): one full build, with every
 * pinned entry and every entry Canonkeeper didn't write held, and entries
 * kept on their uids by title. Then the same diff as any other run.
 */
async function rebuild({ book, messages, generate, contextTokens, maxOutputTokens, outputShare }) {
    const entries = Object.values(book.entries);
    const held = entries.filter((e) => e.canonkeeper?.pinned || !e.canonkeeper);
    const uids = new Map(entries.map((e) => [fold(e.comment ?? ''), e.uid]));
    const nextUid = Math.max(-1, ...entries.map((e) => e.uid)) + 1;
    let calls = 0;
    const counted = (req) => (calls++, generate(req));
    const fresh = await build({ messages, generate: counted, contextTokens, maxOutputTokens, outputShare, pinned: held, uids, nextUid });
    const ops = plan(book, Object.values(fresh.book.entries));
    return {
        book: apply(book, ops),
        scenes: fresh.scenes,
        ledger: fresh.ledger,
        plan: ops,
        held: held.map((e) => ({ uid: e.uid, title: e.comment, reason: e.canonkeeper ? 'pinned' : 'not written by Canonkeeper' })),
        calls,
        wrote: ops.length > 0,
    };
}

/**
 * Brings `book` up to date with `messages`. `starts`, in live mode, are the
 * scene starts the detector found: they decide which scenes are re-read and
 * are what the ledger records, and the model's own scene starts are unused.
 *
 * Returns { book, scenes, ledger, plan, held, calls, wrote }: `plan` is the
 * list of writes made (empty means none), `held` the entries kept as they
 * were and why, `calls` the model calls made. The input book is not mutated.
 */
export async function update({ book, ledger, messages, generate, contextTokens, maxOutputTokens, outputShare, starts }) {
    if (!messages.length) throw new Error('empty transcript');
    if (ledger?.version !== LEDGER_VERSION) {
        const out = await rebuild({ book, messages, generate, contextTokens, maxOutputTokens, outputShare });
        return starts ? withScenes(out, starts, messages.length) : out;
    }

    const held = heldEntries(book, ledger.written);
    const kept = held.map((h) => h.entry);
    // An entry Canonkeeper wrote that is gone from the book was deleted by a
    // human, now or before. It stays deleted: bringing it back is the
    // audit's to offer, never a run's to do quietly.
    const deleted = new Set([...Object.keys(ledger.deleted ?? {}), ...Object.keys(ledger.written).filter((u) => !(u in book.entries))].map(Number));
    const uids = new Map(ledger.entities.filter((e) => e.uid != null).map((e) => [fold(e.name), e.uid]));
    let canon = canonOf(ledger);
    let scenes = ledger.scenes;
    let budget = ledger.budget;
    const review = [];
    const renamed = [];
    let calls = 0;

    if (fingerprint(messages) !== ledger.fingerprint) {
        const { toNew, fresh, dirty } = align(ledger.hashes, messages);
        // In live mode the detector found the scene starts (live.js).
        scenes = starts ? sceneStarts(starts, messages.length) : remapScenes(ledger.scenes, toNew, messages.length);
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
        if (!starts) scenes = scenes.filter((b) => !windows.some(([a, z]) => b > a && b <= z));

        if (windows.length) {
            budget = planBudget({ contextTokens, maxOutputTokens, outputShare });
            const prompt = buildUpdatePrompt(messages, windows, canon, previous, new Set(fresh), budget.output);
            const needed = estimateTokens(prompt.system + prompt.user);
            if (needed > budget.input) throw new TooLongError(needed, budget.input);
            budget = { ...budget, promptEstimate: needed, windows };
            let n = 0;
            const counted = (req) => (n++, generate(req));
            const reply = await ask(counted, prompt, budget.output, messages.length);
            calls = n;
            review.push(...reply.review);
            if (!starts) scenes = [...new Set([...scenes, ...reply.scenes.filter(inWindow)])].sort((a, b) => a - b);
            merge(canon, reply.entities, previous, new Set(fresh), review, renamed);
            // A renamed entity keeps its entry; one folded into another
            // gives its entry up.
            for (const r of renamed) {
                if (uids.has(fold(r.to))) continue;
                if (uids.has(fold(r.from))) uids.set(fold(r.to), uids.get(fold(r.from)));
            }
        }
        canon = canon.filter((e) => e.facts.length).map(({ slot, ...e }) => e);
    }

    if (starts) scenes = sceneStarts(starts, messages.length);
    const compiled = compile(canon, messages, { pinned: kept, uids, nextUid: ledger.nextUid, deleted });
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
            chunked: ledger.chunked,
        }),
        plan: ops,
        held: held.map((h) => ({ uid: h.entry.uid, title: h.entry.comment, reason: h.reason })),
        calls,
        wrote: ops.length > 0,
    };
}
