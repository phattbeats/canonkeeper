// SillyTavern's World Info keyword matching, as the core needs it to decide
// which keys to claim. The harness keeps its own copy on purpose: the gate is
// an independent oracle and must not share code with the thing it judges.
//
//   - a single-word key matches a whole word, a key with spaces matches as a
//     substring (whole-word matching is on by default in ST);
//   - matching is case-insensitive unless the entry is case-sensitive.
//
// The core never emits `/regex/` keys, so this module doesn't parse them.

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function keyRegex(key, caseSensitive) {
    const body = escapeRegex(key);
    const flags = caseSensitive ? 'u' : 'iu';
    if (/\s/.test(key)) return new RegExp(body, flags);
    return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, flags);
}

/** Ids of the messages a key fires on. */
export function firesOn(key, caseSensitive, messages) {
    const re = keyRegex(key, caseSensitive);
    return messages.filter((m) => re.test(m.text)).map((m) => m.id);
}

/** Every case-insensitive hit of a key, as the text actually spells it. */
export function spellings(key, messages) {
    const re = new RegExp(keyRegex(key, false).source, 'giu');
    return messages.flatMap((m) => [...m.text.matchAll(re)].map((hit) => hit[0]));
}
