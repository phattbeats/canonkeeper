// Quotes: lines of dialogue the book carries word for word. The model copies
// them; code checks the copy. A quote that is not in the message it cites is
// removed, so invented dialogue never reaches the book.

/**
 * The text as the check compares it: typographic quotes and dashes folded to
 * plain ones and runs of whitespace to a space. Nothing else is forgiven:
 * words, their order and their case must match. (Punctuation at the very
 * ends of a quote is not part of the words: see `inMessage`.)
 */
export function plain(s) {
    return String(s)
        .replace(/[‘’‛′]/g, "'")
        .replace(/[“”‟″]/g, '"')
        .replace(/[–—]/g, '-')
        .replace(/…/g, '...')
        .replace(/\s+/g, ' ')
        .trim();
}

/** A quote has at least this many words: "Go," is not a line worth keeping. */
export const MIN_WORDS = 2;

/** True when `quote` appears word for word in `text`. A comma or full stop at the quote's ends is not a word: a speech cut by "she said" ends in a comma that a copy often turns into a full stop. */
export function inMessage(quote, text) {
    const q = plain(quote).replace(/^[\s"'.,;:!?-]+|[\s"',;:.!?-]+$/g, '');
    return q !== '' && plain(text).includes(q);
}

/**
 * Splits an entity's quotes into those that appear in the message they cite
 * and those that don't. Returns { kept, removed: [{ quote, why }] }.
 */
export function checkQuotes(quotes, messages) {
    const kept = [];
    const removed = [];
    const seen = new Set();
    for (const q of quotes ?? []) {
        const m = Number.isInteger(q.message) ? messages[q.message] : null;
        if (!m) removed.push({ quote: q.text, why: `cites message ${q.message}, which does not exist` });
        else if (q.text.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length < MIN_WORDS) removed.push({ quote: q.text, why: `under ${MIN_WORDS} words` });
        else if (!inMessage(q.text, m.text)) removed.push({ quote: q.text, why: `not word for word in message ${q.message}` });
        else if (!seen.has(plain(q.text))) {
            seen.add(plain(q.text));
            kept.push({ text: q.text.trim(), message: q.message, ...(q.speaker ? { speaker: q.speaker } : {}) });
        }
    }
    return { kept, removed };
}
