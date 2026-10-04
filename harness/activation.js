// When does an entry's key fire on a piece of text? Modelled on SillyTavern's
// documented World Info matching:
//   - `/pattern/flags` keys are regular expressions;
//   - with whole-word matching on, a single-word key must match a whole word,
//     and a key containing spaces matches as a plain substring;
//   - matching is case-insensitive unless the entry is case-sensitive.
// A null per-entry setting falls back to DEFAULTS, the values the harness
// assumes for SillyTavern's global World Info settings.

export const DEFAULTS = { caseSensitive: false, matchWholeWords: true };

const REGEX_KEY = /^\/(.+)\/([a-z]*)$/;

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function keyToRegex(key, { caseSensitive, matchWholeWords } = {}) {
    const cs = caseSensitive ?? DEFAULTS.caseSensitive;
    const whole = matchWholeWords ?? DEFAULTS.matchWholeWords;
    const re = REGEX_KEY.exec(key);
    if (re) {
        try {
            return new RegExp(re[1], re[2]);
        } catch {
            // Not a valid regex: SillyTavern treats it as a plain key.
        }
    }
    const body = escapeRegex(key);
    const flags = cs ? '' : 'i';
    if (whole && !/\s/.test(key)) return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, flags + 'u');
    return new RegExp(body, flags);
}

export function keyFires(key, entry, text) {
    return keyToRegex(key, entry).test(text);
}

/** Constant entries are always injected, so they count as firing on everything. */
export function entryFires(entry, text) {
    if (entry.constant) return true;
    return entry.keys.some((k) => keyFires(k, entry, text));
}
