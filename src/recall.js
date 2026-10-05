// Recall: a few more relevant entries each turn, on top of keyword activation.
//
// SillyTavern activates an entry when one of its keys is in the last few
// messages (the scan depth). In a long scene that drops what the story is
// still in the middle of: the lighthouse keeper named eight messages ago is
// still in the room, but nothing in the last two messages names him. Recall
// adds the entries the open scene is about and the scan window missed, a few
// at a time, within a fixed token budget.
//
// No model call, nothing random: the pick is plain code over what Canonkeeper
// already knows, so it costs nothing and can't hang a generation.
//
//   - The open scene runs from the last scene start (the ledger's, or live
//     mode's) to the newest message, at most WINDOW messages. With no scene
//     starts known, it's the last WINDOW messages.
//   - An entry is about the scene when one of its keys fires there, or when a
//     fact it carries cites a message there.
//   - An entry whose keys fire in the scan window is skipped: SillyTavern
//     activates it anyway. So is a disabled or constant entry, and one with
//     no keys.
//   - The most recently mentioned go first, then the most mentioned. An entry
//     too big for what's left of the budget is passed over for a smaller one.
//
// Recall only nominates entries. SillyTavern still applies its own rules to
// them (cooldown, delay, its World Info budget), so it adds entries to the
// prompt and never removes one.

import { estimateTokens } from './budget.js';
import { entryKeyRegex } from './match.js';

export const DEFAULT_RECALL = Object.freeze({ maxEntries: 3, budgetTokens: 600, scanDepth: 2 });

/** The longest the open scene is taken to be, in messages. */
export const WINDOW = 40;

/** The open scene: inclusive [from, to] message ids. */
export function openScene(starts, count) {
    const last = count - 1;
    const start = Math.max(0, ...starts.filter((s) => Number.isInteger(s) && s > 0 && s <= last));
    return [Math.max(start, count - WINDOW, 0), last];
}

function keysFireOn(entry, messages) {
    const res = (entry.key ?? []).filter((k) => typeof k === 'string' && k.trim()).map((k) => entryKeyRegex(k, entry));
    return messages.filter((m) => res.some((re) => re.test(m.text))).map((m) => m.id);
}

function cited(entry, [from, to]) {
    const ids = [];
    for (const [a, b] of entry.canonkeeper?.sources ?? []) {
        for (let id = Math.max(a, from); id <= Math.min(b, to); id++) ids.push(id);
    }
    return ids;
}

/**
 * The entries to add this turn. `entries` are the chat book's, `messages`
 * the chat (core messages: { id, text }), `starts` the scene starts known.
 * Returns { scene, picks, considered }: `picks` are { uid, title, tokens,
 * last, mentions }, in the order chosen, and their tokens add up to at most
 * `budgetTokens`.
 */
export function recall({ entries, messages, starts = [], maxEntries = DEFAULT_RECALL.maxEntries, budgetTokens = DEFAULT_RECALL.budgetTokens, scanDepth = DEFAULT_RECALL.scanDepth }) {
    if (!messages.length) return { scene: null, picks: [], considered: 0 };
    const scene = openScene(starts, messages.length);
    const inScene = messages.slice(scene[0], scene[1] + 1);
    const scanned = messages.slice(Math.max(0, messages.length - Math.max(1, scanDepth)));

    const candidates = [];
    for (const e of entries) {
        if (!e || e.disable || e.constant || !e.key?.length || !String(e.content ?? '').trim()) continue;
        if (keysFireOn(e, scanned).length) continue;
        const mentions = [...new Set([...keysFireOn(e, inScene), ...cited(e, scene)])];
        if (!mentions.length) continue;
        candidates.push({ uid: e.uid, title: e.comment ?? '', tokens: estimateTokens(String(e.content)), last: Math.max(...mentions), mentions: mentions.length });
    }
    candidates.sort((a, b) => b.last - a.last || b.mentions - a.mentions || a.uid - b.uid);

    const picks = [];
    let left = budgetTokens;
    for (const c of candidates) {
        if (picks.length >= maxEntries) break;
        if (c.tokens > left) continue;
        picks.push(c);
        left -= c.tokens;
    }
    return { scene, picks, considered: candidates.length };
}
