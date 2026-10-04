// Reading the model's reply. The reply as a whole is strict: not JSON, or not
// the right top-level shape, and it is rejected (the caller retries once,
// then gives up). Inside a good reply, one malformed entity is set aside for
// review rather than failing the run, and nothing is ever filled in.

export class ModelOutputError extends Error {}

/**
 * Accepts one JSON object, tolerating a code fence or a sentence of prose
 * around it. The object itself must parse as it stands: nothing is repaired.
 */
export function extractJson(text) {
    const t = String(text);
    const from = t.indexOf('{');
    const to = t.lastIndexOf('}');
    if (from < 0 || to < from) throw new ModelOutputError('no JSON object in the reply');
    try {
        return JSON.parse(t.slice(from, to + 1));
    } catch (err) {
        throw new ModelOutputError(`not valid JSON: ${err.message}`);
    }
}

const isStr = (x) => typeof x === 'string' && x.trim() !== '';

/**
 * Validates the reply against the shape in prompt.js.
 * Returns { scenes, entities, review }: `review` holds whatever was set aside
 * and why.
 */
export function readReply(text, messageCount) {
    const data = extractJson(text);
    if (!data || typeof data !== 'object' || !Array.isArray(data.entities) || !Array.isArray(data.scenes)) {
        throw new ModelOutputError("reply needs 'scenes' and 'entities' arrays");
    }
    const validId = (n) => Number.isInteger(n) && n >= 0 && n < messageCount;
    const review = [];

    const starts = data.scenes.map((s) => s?.start).filter((n) => validId(n) && n > 0);
    const scenes = [...new Set(starts)].sort((a, b) => a - b);

    const entities = [];
    data.entities.forEach((e, i) => {
        const label = isStr(e?.name) ? e.name.trim() : `entity #${i}`;
        if (!isStr(e?.name) || !Array.isArray(e.keys) || !Array.isArray(e.facts)) {
            review.push({ name: label, reason: 'malformed entity (needs name, keys and facts)' });
            return;
        }
        const facts = e.facts
            .filter((f) => isStr(f?.text) && Array.isArray(f.messages))
            .map((f) => ({ text: f.text.trim(), messages: [...new Set(f.messages.filter(validId))].sort((a, b) => a - b) }))
            .filter((f) => f.messages.length); // a fact with no valid source is not a fact
        if (!facts.length) {
            review.push({ name: label, reason: 'no fact with a valid source message' });
            return;
        }
        entities.push({
            name: label,
            keys: e.keys.filter(isStr).map((k) => k.trim()),
            facts,
            caseSensitive: e.caseSensitive === true,
            cascade: e.cascade !== false,
            throttle: Number.isInteger(e.throttle) && e.throttle > 0 ? e.throttle : 0,
        });
    });
    return { scenes, entities, review };
}
