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
 * A capitalised one-word key needs case-sensitive matching when the story
 * also uses the same word in lower case: that's an ordinary word, not this
 * entity (Wren the runner vs. a wren on the windowsill). Phrases don't count:
 * "the prophecy" mid-sentence is still The Prophecy.
 */
function needsCase(key, messages) {
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

/**
 * Compiles entities into entries.
 *
 * `pinned` are existing entries a human pinned. They are kept verbatim and
 * their keys are claimed first: pins win every contest.
 *
 * Returns { entries, ledger, review, contested } where `ledger` records, per entity,
 * every key decision with its reason.
 */
export function compile(entities, messages, { pinned = [] } = {}) {
    const review = [];
    const maxFires = Math.floor(messages.length * MAX_FIRE_FRACTION);

    // 1. Per-entity key candidates: verbatim in the story, case decided, not overbroad.
    const pinnedNames = new Set(pinned.map((p) => fold(p.comment ?? '')));
    const candidates = mergeByName(entities)
        .filter((e) => {
            if (!pinnedNames.has(fold(e.name))) return true;
            review.push({ name: e.name, reason: 'a human-pinned entry already covers this name; kept the pinned entry' });
            return false;
        })
        .map((e) => {
            const dropped = [];
            const seen = new Map();
            // The model's own spelling wins over the title's capitalisation.
            for (const k of [...e.keys, e.name]) if (!seen.has(fold(k))) seen.set(fold(k), k);
            let keys = [...seen.values()].filter((k) => {
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
    //    one of them is pinned, in which case the pin keeps it.
    const holders = new Map(); // folded key -> Set of holder ids
    const hold = (k, id) => (holders.get(fold(k)) ?? holders.set(fold(k), new Set()).get(fold(k))).add(id);
    pinned.forEach((p, i) => (p.key ?? []).forEach((k) => hold(k, `pin:${i}`)));
    candidates.forEach((c, i) => c.keys.forEach((k) => hold(k, `new:${i}`)));
    const contested = [...holders].filter(([, ids]) => ids.size > 1).map(([k]) => k);
    for (const c of candidates) {
        c.keys = c.keys.filter((k) => {
            if (holders.get(fold(k)).size === 1) return true;
            c.dropped.push({ key: k, reason: 'claimed by another entity' });
            return false;
        });
    }

    // 3. Ship only what can fire and is grounded in its own sources.
    const shipped = [];
    for (const c of candidates) {
        if (!c.keys.length) {
            review.push({ name: c.name, reason: 'no usable key left', dropped: c.dropped });
            continue;
        }
        const sources = toRanges(c.facts.flatMap((f) => f.messages));
        const cited = new Set(c.facts.flatMap((f) => f.messages));
        const grounded = c.keys.some((k) => firesOn(k, c.caseSensitive, messages).some((id) => cited.has(id)));
        if (!grounded) {
            review.push({ name: c.name, reason: 'none of its cited messages mentions any of its keys', keys: c.keys, sources });
            continue;
        }
        shipped.push({ ...c, sources, first: sources[0][0] });
    }

    // 4. Stable order and uids: story order, then name. Pinned uids are never reused.
    shipped.sort((a, b) => a.first - b.first || a.name.localeCompare(b.name));
    const taken = new Set(pinned.map((p) => p.uid));
    let next = 0;
    const entries = pinned.map((p) => structuredClone(p));
    const ledger = [];
    for (const c of shipped) {
        while (taken.has(next)) next++;
        const uid = next++;
        entries.push(toEntry(uid, c));
        ledger.push({ uid, name: c.name, keys: c.keys, dropped: c.dropped, caseSensitive: c.caseSensitive, cascade: c.cascade, throttle: c.throttle, facts: c.facts });
    }
    entries.sort((a, b) => a.uid - b.uid);
    return { entries, ledger, review, contested };
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
        },
    };
}
