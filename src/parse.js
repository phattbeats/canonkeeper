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

/**
 * Validates a reconciliation reply against `entities`, the { name, keys }
 * it was shown. A merge naming an entity that wasn't listed, or one already
 * used by another merge, is set aside for review: never applied by guessing.
 * Naming one of the kept entity's own keys merges nothing and is ignored.
 * Returns { merges: [{ keep, same: [...] }], review }, names as listed.
 */
export function readMerges(text, entities) {
    const data = extractJson(text);
    if (!data || typeof data !== 'object' || !Array.isArray(data.merges)) throw new ModelOutputError("reply needs a 'merges' array");
    const listed = new Map(entities.map((e) => [e.name.toLowerCase(), e.name]));
    const keysOf = new Map(entities.map((e) => [e.name, new Set((e.keys ?? []).map((k) => k.toLowerCase()))]));
    const used = new Set();
    const merges = [];
    const review = [];
    for (const m of data.merges) {
        const keep = isStr(m?.keep) ? listed.get(m.keep.trim().toLowerCase()) : null;
        const own = (s) => keep && !listed.has(s.trim().toLowerCase()) && keysOf.get(keep).has(s.trim().toLowerCase());
        const said = Array.isArray(m?.same) ? m.same.filter(isStr) : [];
        if (keep && said.length && said.every(own)) continue;
        const same = said.filter((s) => !own(s)).map((s) => listed.get(s.trim().toLowerCase()));
        const all = [keep, ...same];
        const label = isStr(m?.keep) ? m.keep.trim() : 'merge';
        if (!keep || !same.length || all.some((n) => !n)) review.push({ name: label, reason: 'reconciliation named an entity that was not listed; not merged' });
        else if (new Set(all).size !== all.length || all.some((n) => used.has(n))) review.push({ name: label, reason: 'reconciliation used an entity in two merges; not merged' });
        else {
            all.forEach((n) => used.add(n));
            merges.push({ keep, same });
        }
    }
    return { merges, review };
}
