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

/** The words of a quote, if it is not one stretch of the message: the longest of its sentences that is. Null when none is. */
function salvage(text, message) {
    const pieces = text.split(/(?<=[.!?])\s+/).filter((p) => wordCount(p) >= MIN_WORDS && inMessage(p, message));
    pieces.sort((a, b) => b.length - a.length);
    return pieces[0]?.trim().replace(/^["“]+|["”]+$/g, '') ?? null;
}

const wordCount = (t) => t.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

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
        else if (wordCount(q.text) < MIN_WORDS) removed.push({ quote: q.text, why: `under ${MIN_WORDS} words` });
        else {
            // Two lines joined across a "she said" are not one line; the longer true half is kept.
            const text = inMessage(q.text, m.text) ? q.text.trim() : salvage(q.text, m.text);
            if (!text) removed.push({ quote: q.text, why: `not word for word in message ${q.message}` });
            else if (!seen.has(plain(text))) {
                seen.add(plain(text));
                kept.push({ text, message: q.message, ...(q.speaker ? { speaker: q.speaker } : {}) });
            }
        }
    }
    return { kept, removed };
}
