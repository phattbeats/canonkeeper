// Clips: a passage the user highlights becomes a lorebook entry, with a short
// blurb and keys, so it comes back when the story returns to it rather than
// just being stored.
//
// One small model call reads the passage, with the scene before it for who
// "she" is, and writes three fields: a title, a blurb and keys. Code writes
// the entry, with the same key rules as the rest of the book:
//
//   - a key the chat never uses is dropped, and so is a pronoun;
//   - a key that fires on more than 80% of the messages is dropped;
//   - a key any enabled entry already holds, in this book or another active
//     one, is dropped: a clip never takes a key from an entry, so it can't
//     change what fires today. So is a bare word of one of their phrases
//     ("Captain" against "Captain Quill").
//
// A clip with no key left is refused, and nothing is written. So is a reply
// that isn't strict JSON after one retry, and a passage that isn't in the
// message it was taken from.
//
// The entry is the user's, like a pinned one: `/canon` never rewrites or
// removes it, and its keys win every contest. Its blurb is its one fact,
// citing the clipped message, so the audit checks it like any claim.

import { ask } from './build.js';
import { toEntry, toRanges, MAX_FIRE_FRACTION, PRONOUNS, needsCase } from './compile.js';
import { extractJson, ModelOutputError } from './parse.js';
import { firesOn, keyRegex } from './match.js';
import { renderTranscript } from './prompt.js';

export class ClipError extends Error {}

/** The longest passage a clip takes, in characters. A clip is a passage, not a scene. */
export const MAX_PASSAGE = 3000;

/** Messages before the clipped one shown as context. */
export const CONTEXT_MESSAGES = 8;

export const MAX_KEYS = 6;

export const CLIP_SYSTEM = `You file a passage of a roleplay story in its lorebook, so the story can recall it later. You read the passage the user clipped and report it as JSON: a short title, a blurb and keys.

Rules:
- Use only what the passage and the messages before it state. Never invent detail.
- The blurb is one or two third-person sentences saying what the passage establishes and who it involves, named, so it reads on its own later.
- Keys are the words that should bring this passage back: the names of what it is about, as the story writes them (a riddle's subject, a promise, a place, an object, an event). Every key must appear verbatim in the story. Never use a pronoun. Prefer phrases that point at this passage over bare character names: a character already has their own entry.
- Return only the JSON object. No prose, no code fences.`;

export const CLIP_SHAPE = `{ "title": "<a few words>", "blurb": "<one or two sentences>", "keys": ["<words the story uses>"] }`;

const fold = (s) => s.toLowerCase();
const isStr = (x) => typeof x === 'string' && x.trim() !== '';

/** Letters and digits only, lower-cased: rendered text and markdown compare equal. */
const bare = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function clipPrompt(messages, at, passage) {
    const before = messages.slice(Math.max(0, at - CONTEXT_MESSAGES), at);
    const ctx = before.length ? `<before>\n${renderTranscript(before)}\n</before>\n\n` : '';
    return {
        system: CLIP_SYSTEM,
        user: `Return JSON in exactly this shape:\n${CLIP_SHAPE}\n\n${ctx}<clipped_from>\n${renderTranscript([messages[at]])}\n</clipped_from>\n\nThe passage the user clipped, from message ${at}:\n<passage>\n${passage}\n</passage>`,
    };
}

export function readClip(text) {
    const data = extractJson(text);
    if (!data || typeof data !== 'object' || !isStr(data.title) || !isStr(data.blurb) || !Array.isArray(data.keys)) {
        throw new ModelOutputError("reply needs 'title' and 'blurb' strings and a 'keys' array");
    }
    return { title: data.title.trim(), blurb: data.blurb.trim(), keys: data.keys.filter(isStr).map((k) => k.trim()) };
}

/** Every key an enabled entry holds, folded, with the entry that holds it. */
function heldKeys(book, foreign) {
    const held = new Map();
    for (const e of Object.values(book.entries ?? {})) {
        if (!e || e.disable) continue;
        for (const k of e.key ?? []) if (isStr(k)) held.set(fold(k.trim()), `'${e.comment ?? e.uid}'`);
    }
    for (const { book: name, entry } of foreign) {
        for (const k of entry.key ?? []) if (isStr(k)) held.set(fold(k.trim()), `'${entry.comment ?? entry.uid}' in '${name}'`);
    }
    return held;
}

/** The keys a clip may have, and why each other one was dropped. */
export function clipKeys(proposed, messages, held) {
    const keys = [];
    const dropped = [];
    for (const k of proposed) {
        if (keys.some((x) => fold(x) === fold(k)) || keys.length >= MAX_KEYS) continue;
        const fires = firesOn(k, false, messages).length;
        let reason = null;
        if (PRONOUNS.has(fold(k))) reason = 'a pronoun';
        else if (!fires) reason = 'not in the chat';
        else if (fires > MAX_FIRE_FRACTION * messages.length) reason = `fires on ${fires} of ${messages.length} messages`;
        else if (held.has(fold(k))) reason = `already a key of ${held.get(fold(k))}`;
        else {
            const re = keyRegex(k, false);
            const inside = [...held.keys()].find((h) => re.test(h));
            if (inside) reason = `a bare word of '${inside}', a key of ${held.get(inside)}`;
        }
        if (reason) dropped.push({ key: k, reason });
        else keys.push(k);
    }
    return { keys, dropped };
}

/** A uid no entry has, and none the ledger ever gave out. */
function freeUid(book, ledger) {
    const used = [
        ...Object.values(book.entries ?? {}).map((e) => e.uid),
        ...Object.keys(ledger?.written ?? {}).map(Number),
        ...Object.keys(ledger?.deleted ?? {}).map(Number),
        ...(ledger?.entities ?? []).map((e) => e.uid),
        (ledger?.nextUid ?? 0) - 1,
    ].filter(Number.isInteger);
    return Math.max(-1, ...used) + 1;
}

/**
 * Turns the passage `text` of message `at` into a new entry for `book`.
 * Empty `text` clips the whole message. `foreign` are the other active
 * books' entries, as { book, entry }. Returns { entry, dropped }; the book is
 * not touched. Throws a ClipError, having written nothing, when there is
 * nothing to clip or no key survives, and the parse error after one retry.
 */
export async function clip({ book, ledger = null, foreign = [], messages, at, text, generate, maxTokens = 2000 }) {
    if (!Number.isInteger(at) || at < 0 || at >= messages.length) throw new ClipError(`there is no message ${at}`);
    const message = messages[at];
    const passage = String(text ?? '').trim() || message.text.trim();
    if (!bare(passage)) throw new ClipError('nothing to clip: the passage is empty');
    if (passage.length > MAX_PASSAGE) throw new ClipError(`the passage is ${passage.length} characters; a clip takes at most ${MAX_PASSAGE}`);
    if (!bare(message.text).includes(bare(passage))) throw new ClipError(`the passage isn't in message ${at}`);

    const reply = await ask(generate, clipPrompt(messages, at, passage), maxTokens, messages.length, readClip);
    const { keys, dropped } = clipKeys(reply.keys, messages, heldKeys(book, foreign));
    if (!keys.length) {
        const why = dropped.length ? dropped.map((d) => `"${d.key}" (${d.reason})`).join(', ') : 'none proposed';
        throw new ClipError(`no usable key for the clip, so it would never fire: ${why}`);
    }
    const entry = toEntry(freeUid(book, ledger), {
        name: `Clip: ${reply.title}`,
        keys,
        facts: [{ text: reply.blurb, messages: [at] }],
        caseSensitive: keys.some((k) => needsCase(k, messages)),
        cascade: false,
        throttle: 0,
        sources: toRanges([at]),
        anchor: null,
    });
    entry.content = `${reply.blurb}\n"${passage}"`;
    entry.canonkeeper.clip = { at, passage };
    return { entry, dropped };
}
