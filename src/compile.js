// From the model's six-field shape to SillyTavern World Info entries.
//
// Keys are the retrieval system, so they are claimed here, once, against one
// registry that sees every entity at the same time. A key leaves this module
// only if it is unique, it appears in the story, and it doesn't fire on
// nearly every message. Nothing downstream has to remove duplicates.

import { firesOn, spellings } from './match.js';

/** A key firing on more than this share of messages retrieves nothing useful. */
export const MAX_FIRE_FRACTION = 0.8;

const fold = (s) => s.toLowerCase();

/**
 * A pronoun points at whoever the sentence is about, never at one entity: a
 * first-person narrator's "I" is every speaker's "I".
 */
export const PRONOUNS = new Set(['i', 'me', 'my', 'mine', 'myself', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them', 'their']);

/**
 * A capitalised one-word key needs case-sensitive matching when the story
 * also uses the same word in lower case: that's an ordinary word, not this
 * entity (Wren the runner vs. a wren on the windowsill). Phrases don't count:
 * "the prophecy" mid-sentence is still The Prophecy.
 */
export function needsCase(key, messages) {
    const lower = key.toLowerCase();
    return !/\s/.test(key) && lower !== key && spellings(key, messages).includes(lower);
}

const ARTICLE = /^(the|a|an)\s/i;

/**
 * Spellings a case-sensitive entry still has to match: a lower-case epithet
 * at the start of a sentence, and "the Tailor" vs "The Tailor".
 */
function caseVariants(key) {
    const up = key.charAt(0).toUpperCase() + key.slice(1);
    const down = key.charAt(0).toLowerCase() + key.slice(1);
    if (key === key.toLowerCase()) return [up];
    return ARTICLE.test(key) ? [up, down] : [];
}

/** Sorted inclusive [from, to] ranges covering a set of message ids. */
export function toRanges(ids) {
    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    const ranges = [];
    for (const id of sorted) {
        const last = ranges[ranges.length - 1];
        if (last && id === last[1] + 1) last[1] = id;
        else ranges.push([id, id]);
    }
    return ranges;
}

/** Two replies about one name are one entity: merge rather than split. */
function mergeByName(entities) {
    const byName = new Map();
    for (const e of entities) {
        const k = fold(e.name);
        const prev = byName.get(k);
        if (!prev) byName.set(k, { ...e, keys: [...e.keys], facts: [...e.facts] });
        else {
            prev.keys.push(...e.keys);
            prev.facts.push(...e.facts);
            prev.caseSensitive ||= e.caseSensitive;
            prev.cascade &&= e.cascade;
            prev.throttle = Math.max(prev.throttle, e.throttle);
        }
    }
    return [...byName.values()];
}

/** A plain key: a `/regex/` key is matched as a pattern, never as a name. */
const plainKeys = (e) => (Array.isArray(e.key) ? e.key : []).map((k) => String(k).trim()).filter((k) => k && !/^\/.+\/[a-z]*$/.test(k));

/**
 * The entry in another book that already covers an entity: one with its
 * title, or one that holds one of its names as a key. Null if none does.
 */
function coveredBy(e, foreign) {
    const names = new Set([e.name, ...e.keys].map(fold).filter((k) => !PRONOUNS.has(k)));
    return foreign.find((f) => fold(f.entry.comment ?? '') === fold(e.name))
        ?? foreign.find((f) => plainKeys(f.entry).some((k) => names.has(fold(k))))
        ?? null;
}

/**
 * Compiles entities into entries.
 *
 * `pinned` are existing entries kept verbatim: human-pinned, edited by hand,
 * or not Canonkeeper's at all. Their keys are claimed first, so they win
 * every contest, and an entity with the same title is held behind them.
 *
 * `foreign` are the enabled entries of the other lorebooks active for the
 * chat (the character's, global, the persona's), as { book, entry }. They
 * are read, never written: none of them is ever in `entries`. Their keys win
 * every contest like a pin's, and an entity one of them covers, by title or
 * by one of its names as a key, gets no entry. An entry Canonkeeper didn't
 * write is the user's, so it is never adopted.
 *
 * `uids` maps a folded entity name to the uid it had last time, so an entity
 * keeps its entry across runs. New entities get uids from `nextUid` up, in
 * story order; a retired uid is never handed out again.
 *
 * `deleted` are uids of entries a human deleted from the book. Their
 * entities stay in the canon but get no entry, and their keys are free: a
 * run never brings back what someone removed (the audit can, if asked).
 *
 * Returns { entries, ledger, review, contested, nextUid, deleted }. `ledger`
 * has one record per entity, shipped or not: the entity as the model gave it
 * (the canon a later run starts from) plus `uid` and `compiled`, every key
 * decision with its reason. `deleted` maps each deleted uid still in the
 * canon to its entity's name.
 */
export function compile(entities, messages, { pinned = [], foreign = [], uids = new Map(), nextUid = 0, deleted = new Set() } = {}) {
    const review = [];
    const maxFires = Math.floor(messages.length * MAX_FIRE_FRACTION);

    // 1. Per-entity key candidates: verbatim in the story, case decided, not overbroad.
    // A kept entry holds the entity with its title, or with its uid (a human
    // may have renamed it).
    const pinnedUid = new Map(pinned.map((p) => [fold(p.comment ?? ''), p.uid]));
    const keptUids = new Set(pinned.map((p) => p.uid));
    for (const [name, uid] of uids) if (keptUids.has(uid) && !pinnedUid.has(name)) pinnedUid.set(name, uid);
    const merged = mergeByName(entities);
    const held = [];
    const gone = [];
    const elsewhere = [];
    const active = foreign.filter((f) => !f.entry.disable);
    const candidates = merged
        .filter((e) => {
            if (deleted.has(uids.get(fold(e.name)))) {
                gone.push(e);
                review.push({ name: e.name, reason: 'its entry was deleted from the book; left out' });
                return false;
            }
            const cover = pinnedUid.has(fold(e.name)) ? null : coveredBy(e, active);
            if (cover) {
                const by = { book: cover.book, title: cover.entry.comment || `entry ${cover.entry.uid}` };
                elsewhere.push({ ...e, heldBy: by });
                review.push({ name: e.name, reason: `'${by.book}' already has '${by.title}'; no Canonkeeper entry`, book: by.book, title: by.title });
                return false;
            }
            if (!pinnedUid.has(fold(e.name))) return true;
            held.push(e);
            review.push({ name: e.name, reason: 'a pinned or hand-edited entry covers this name; kept that entry' });
            return false;
        })
        .map((e) => {
            const dropped = [];
            const seen = new Map();
            // The model's own spelling wins over the title's capitalisation.
            for (const k of [...e.keys, e.name]) if (!seen.has(fold(k))) seen.set(fold(k), k);
            let keys = [...seen.values()].filter((k) => {
                if (PRONOUNS.has(fold(k))) {
                    dropped.push({ key: k, reason: 'a pronoun, not a name' });
                    return false;
                }
                if (firesOn(k, false, messages).length) return true;
                if (k !== e.name) dropped.push({ key: k, reason: 'not in the transcript' });
                return false;
            });
            const caseSensitive = e.caseSensitive || keys.some((k) => needsCase(k, messages));
            if (caseSensitive) {
                for (const k of [...keys]) {
                    for (const v of caseVariants(k)) if (v !== k && !keys.includes(v) && firesOn(v, true, messages).length) keys.push(v);
                }
                keys = keys.filter((k) => {
                    if (firesOn(k, true, messages).length) return true;
                    dropped.push({ key: k, reason: 'never appears in this exact case' });
                    return false;
                });
            }
            keys = keys.filter((k) => {
                if (firesOn(k, caseSensitive, messages).length <= maxFires) return true;
                dropped.push({ key: k, reason: `fires on more than ${MAX_FIRE_FRACTION * 100}% of messages` });
                return false;
            });
            return { ...e, keys, caseSensitive, dropped };
        });

    // 2. One registry. A key held by two entities belongs to neither, unless
    //    one of them is pinned or in another book, which keeps it.
    const holders = new Map(); // folded key -> Set of holder ids
    const hold = (k, id) => (holders.get(fold(k)) ?? holders.set(fold(k), new Set()).get(fold(k))).add(id);
    pinned.forEach((p, i) => (p.key ?? []).forEach((k) => hold(k, `pin:${i}`)));
    active.forEach((f, i) => plainKeys(f.entry).forEach((k) => hold(k, `far:${i}`)));
    candidates.forEach((c, i) => c.keys.forEach((k) => hold(k, `new:${i}`)));
    // A bare title one entity claims ("Captain") is still contested when it is
    // a word in another entity's key ("Captain Hale") and not in its own name.
    const words = (k) => fold(k).split(/\s+/);
    const keyWords = new Map(); // folded word -> holder ids whose multi-word keys contain it
    const addWords = (k, id) => words(k).length > 1 && words(k).forEach((w) => (keyWords.get(w) ?? keyWords.set(w, new Set()).get(w)).add(id));
    pinned.forEach((p, i) => (p.key ?? []).forEach((k) => addWords(k, `pin:${i}`)));
    active.forEach((f, i) => plainKeys(f.entry).forEach((k) => addWords(k, `far:${i}`)));
    candidates.forEach((c, i) => c.keys.forEach((k) => addWords(k, `new:${i}`)));
    candidates.forEach((c, i) => {
        const own = new Set(words(c.name));
        for (const k of c.keys) {
            if (words(k).length > 1 || own.has(fold(k))) continue;
            for (const id of keyWords.get(fold(k)) ?? []) if (id !== `new:${i}`) hold(k, id);
        }
    });
    const contested = [...holders].filter(([, ids]) => ids.size > 1).map(([k]) => k);
    for (const c of candidates) {
        c.keys = c.keys.filter((k) => {
            const ids = holders.get(fold(k));
            if (ids.size === 1) return true;
            const far = [...ids].find((id) => id.startsWith('far:'));
            c.dropped.push({ key: k, reason: far ? `a key of '${active[far.slice(4)].entry.comment}' in '${active[far.slice(4)].book}'` : 'claimed by another entity' });
            return false;
        });
    }

    // 3. Ship only what can fire, with provenance that names the entity.
    const shipped = [];
    const unshipped = [];
    for (const c of candidates) {
        if (!c.keys.length) {
            unshipped.push(c);
            review.push({ name: c.name, reason: 'no usable key left', dropped: c.dropped });
            continue;
        }
        const cited = new Set(c.facts.flatMap((f) => f.messages));
        const mentions = [...new Set(c.keys.flatMap((k) => firesOn(k, c.caseSensitive, messages)))].sort((a, b) => a - b);
        // The model may cite scenes that refer to an entity without naming it
        // ("the King"). Then the first message that does name it is added as
        // an anchor, recorded apart from the facts' own sources.
        const anchor = mentions.some((id) => cited.has(id)) ? null : mentions[0];
        const sources = toRanges(anchor == null ? [...cited] : [...cited, anchor]);
        shipped.push({ ...c, sources, anchor, first: sources[0][0] });
    }

    // 4. Stable uids: an entity keeps the uid it had; new ones follow in story
    //    order, then name. Uids of kept entries are never reused.
    shipped.sort((a, b) => a.first - b.first || a.name.localeCompare(b.name));
    const taken = new Set(pinned.map((p) => p.uid));
    for (const c of shipped) {
        const uid = uids.get(fold(c.name));
        if (uid != null && !taken.has(uid)) taken.add((c.uid = uid));
    }
    let next = nextUid;
    for (const c of shipped) {
        if (c.uid != null) continue;
        while (taken.has(next)) next++;
        taken.add((c.uid = next++));
    }
    const entries = [...pinned.map((p) => structuredClone(p)), ...shipped.map((c) => toEntry(c.uid, c))];
    entries.sort((a, b) => a.uid - b.uid);

    // 5. The ledger: every entity, as the model gave it, with what became of it.
    const canon = new Map(merged.map((e) => [fold(e.name), e]));
    const record = (name, uid, compiled) => {
        const e = canon.get(fold(name));
        return { name: e.name, keys: e.keys, facts: e.facts, caseSensitive: e.caseSensitive, cascade: e.cascade, throttle: e.throttle, uid, compiled };
    };
    const ledger = [
        ...shipped.map((c) => record(c.name, c.uid, { keys: c.keys, caseSensitive: c.caseSensitive, dropped: c.dropped, anchor: c.anchor })),
        ...held.map((e) => record(e.name, pinnedUid.get(fold(e.name)), null)),
        ...gone.map((e) => record(e.name, uids.get(fold(e.name)), null)),
        ...elsewhere.map((e) => ({ ...record(e.name, null, null), heldBy: e.heldBy })),
        ...unshipped.map((c) => record(c.name, null, { keys: [], caseSensitive: c.caseSensitive, dropped: c.dropped, anchor: null })),
    ];
    const maxUid = Math.max(nextUid - 1, ...[...taken].filter(Number.isInteger));
    return { entries, ledger, review, contested, nextUid: maxUid + 1, deleted: Object.fromEntries(gone.map((e) => [String(uids.get(fold(e.name))), e.name])) };
}

/** The full SillyTavern entry. The model never writes any of these fields. */
export function toEntry(uid, c) {
    return {
        uid,
        key: c.keys,
        keysecondary: [],
        comment: c.name,
        content: c.facts.map((f) => f.text).join(' '),
        constant: false,
        selective: false,
        selectiveLogic: 0,
        order: 100,
        position: 0,
        disable: false,
        excludeRecursion: false,
        preventRecursion: !c.cascade,
        probability: 100,
        useProbability: true,
        depth: 4,
        caseSensitive: c.caseSensitive,
        matchWholeWords: true,
        cooldown: c.throttle > 0 ? c.throttle : null,
        displayIndex: uid,
        canonkeeper: {
            sources: c.sources,
            pinned: false,
            facts: c.facts.map((f) => ({ text: f.text, sources: toRanges(f.messages) })),
            ...(c.anchor == null ? {} : { anchor: c.anchor }),
        },
    };
}
