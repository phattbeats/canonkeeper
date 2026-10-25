// Folding what the model reports about a stretch of the story into the canon:
// the list of entities every run starts from and compile() ends from.

const fold = (s) => s.toLowerCase();

/**
 * Folds one part's reply into the canon. A known entity is matched by name,
 * or failing that by a key only it holds, and gains new keys and facts; a
 * fact it already has gains the new sources. A new name that lists exactly
 * one known entity's name among its keys is that entity, now properly named:
 * it takes the new name and keeps the old one as a key. A fact must cite the
 * part itself: the model saw nothing else, so a citation outside it is a
 * guess.
 */
export function absorb(canon, found, from, to, review, renamed, read = to) {
    const byName = new Map(canon.map((e) => [fold(e.name), e]));
    const keyOwners = new Map();
    const own = (k, e) => keyOwners.set(fold(k), [...new Set([...(keyOwners.get(fold(k)) ?? []), e])]);
    for (const e of canon) for (const k of e.keys) own(k, e);
    for (const f of found) {
        const facts = f.facts
            .map((x) => ({ ...x, messages: x.messages.filter((id) => id >= from && id <= to) }))
            .filter((x) => x.messages.length);
        // A fact from the handed-over scene (to, read] is the next part's to report.
        const outside = f.facts.filter((x) => !x.messages.some((id) => id >= from && id <= read)).length;
        if (outside) review.push({ name: f.name, reason: `${outside} fact(s) cited only messages outside part ${from}-${to}; left out` });
        if (!facts.length) continue;
        const owners = keyOwners.get(fold(f.name)) ?? [];
        let e = byName.get(fold(f.name)) ?? (f.kind === 'scene' ? canon.find((x) => x.kind === 'scene' && x.start === f.start) : null) ?? (owners.length === 1 ? owners[0] : null);
        const named = e || f.kind === 'scene' ? [] : [...new Set(f.keys.map((k) => byName.get(fold(k))).filter(Boolean))];
        if (named.length === 1) {
            e = named[0];
            byName.delete(fold(e.name));
            if (!e.keys.some((x) => fold(x) === fold(e.name))) e.keys.push(e.name);
            own(e.name, e);
            renamed.push({ from: e.name, to: f.name });
            e.name = f.name;
            byName.set(fold(e.name), e);
        }
        if (!e) {
            e = { ...f, keys: [], facts: [], quotes: [] };
            canon.push(e);
            byName.set(fold(e.name), e);
        } else {
            for (const field of ['main', 'where', 'when', 'who', 'line']) if (f[field] != null) e[field] = f[field];
            e.caseSensitive ||= f.caseSensitive;
            e.cascade &&= f.cascade;
            e.throttle = Math.max(e.throttle, f.throttle);
        }
        for (const k of f.keys) {
            if (e.keys.some((x) => fold(x) === fold(k))) continue;
            e.keys.push(k);
            own(k, e);
        }
        addFacts(e, facts);
        // A quote must come from the part, like a fact; the verbatim check is compile's.
        for (const q of f.quotes ?? []) if (q.message >= from && q.message <= to && !(e.quotes ??= []).some((x) => x.text === q.text)) e.quotes.push(q);
    }
}

export function addFacts(e, facts) {
    for (const fact of facts) {
        const same = e.facts.find((x) => fold(x.text) === fold(fact.text));
        if (same) same.messages = [...new Set([...same.messages, ...fact.messages])].sort((a, b) => a - b);
        else e.facts.push({ text: fact.text, messages: [...fact.messages], ...(fact.section ? { section: fact.section } : {}) });
    }
}
