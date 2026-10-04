// The acceptance checks. Each returns { id, name, ok, detail }.
//
// They test properties and coverage, never wording: a builder that writes a
// better entry than the reference must still pass.
//
// Rule shared by every check: one that inspects nothing fails. An empty book,
// a missing rerun or a book with no pins is reported red, never vacuously
// green.
//
//   I1  no keyword claimed by two enabled entries
//   I2  no enabled entry ships with zero keys
//   I3  no entry fires on nearly every message
//   I4  every entry carries provenance, inside the transcript, that points at
//       a message where one of the entry's keys actually fires
//   I5  re-running on the unchanged transcript writes nothing
//   I6  every human-pinned entry survives the re-run untouched
//   C7  entity coverage against the answer key: found / missed / extra, plus
//       splits, over-merges, reachability, case-trap decoys, contested keys
//   C8  scene-boundary precision and recall at ±tolerance messages
//   E9  editing one scene changes only that scene's entities, and pinned
//       entries survive the edit (opt-in: needs an edit fixture and output)
//   K10 a run built in parts says so: its ledger records two or more parts
//       that read every message exactly once, in order, and a reconciliation
//       pass (opt-in: for a story that doesn't fit the window)
//   L11 live mode runs on a cadence and an edge: N messages took at most
//       N/cadence detection calls, every message was judged, and each update
//       followed a scene start the detector found, once, in order (opt-in:
//       for a live session)
//   A12 the audit catches what was planted in a built book: a key two
//       entries claim, an entry deleted by hand (which a re-run must not
//       bring back), and false facts, each flagged by claim re-verification;
//       and the audit itself wrote nothing (opt-in: for an audit run)
//   A13 the audit raises no false alarm on the clean book: no technical
//       finding, and few claims flagged (opt-in: for an audit run)

import { entryFires, keyFires, DEFAULTS } from './activation.js';

export const THRESHOLDS = {
    maxFireFraction: 0.8, // I3: "nearly every message"
    minRecall: 1.0, // C7: required entities found
    minPrecision: 0.8, // C7: entries that map to a real entity
    boundaryTolerance: 1, // C8: ± messages
    maxCleanClaimFlags: 0.15, // A13: share of a clean book's claims the audit may flag
    minBoundaryPrecision: 0.9, // C8
    minBoundaryRecall: 0.9, // C8
};

const enabled = (book) => book.filter((e) => !e.disabled);
const result = (id, name, ok, detail) => ({ id, name, ok, detail });
const emptyFail = (id, name) => result(id, name, false, { reason: 'empty book: nothing to check' });

// ── I1 ───────────────────────────────────────────────────────────────────────

/** Two claims on one key collide unless both are case-sensitive and differ in case. */
function claimId(key, entry) {
    const cs = entry.caseSensitive ?? DEFAULTS.caseSensitive;
    return cs ? key : key.toLowerCase();
}

export function checkI1KeywordCollisions(book) {
    const name = 'no keyword claimed by two entries';
    const live = enabled(book);
    if (!live.length) return emptyFail('I1', name);
    const claims = []; // { key, folded, cs, uid }
    for (const e of live) {
        const cs = e.caseSensitive ?? DEFAULTS.caseSensitive;
        for (const k of new Set(e.keys)) claims.push({ key: k, folded: k.toLowerCase(), cs, uid: e.uid, id: claimId(k, e) });
    }
    const collisions = [];
    for (let i = 0; i < claims.length; i++) {
        for (let j = i + 1; j < claims.length; j++) {
            const a = claims[i], b = claims[j];
            if (a.uid === b.uid || a.folded !== b.folded) continue;
            if (a.cs && b.cs && a.key !== b.key) continue;
            collisions.push({ key: a.key, uids: [a.uid, b.uid] });
        }
    }
    return result('I1', name, collisions.length === 0, { collisions });
}

// ── I2 ───────────────────────────────────────────────────────────────────────

export function checkI2ZeroKeyEntries(book) {
    const name = 'no entry with zero keys';
    const live = enabled(book);
    if (!live.length) return emptyFail('I2', name);
    const offenders = live.filter((e) => e.keys.length === 0).map((e) => ({ uid: e.uid, title: e.title }));
    return result('I2', name, offenders.length === 0, { offenders });
}

// ── I3 ───────────────────────────────────────────────────────────────────────

export function checkI3OverbroadKeys(book, messages, { maxFireFraction = THRESHOLDS.maxFireFraction } = {}) {
    const name = 'no key fires on nearly every message';
    const live = enabled(book);
    if (!live.length) return emptyFail('I3', name);
    const offenders = [];
    for (const e of live) {
        const probes = e.constant ? [{ key: '(constant)', fires: () => true }] : e.keys.map((k) => ({ key: k, fires: (t) => keyFires(k, e, t) }));
        for (const p of probes) {
            const fraction = messages.filter((m) => p.fires(m.text)).length / messages.length;
            if (fraction > maxFireFraction) offenders.push({ uid: e.uid, key: p.key, fraction: +fraction.toFixed(3) });
        }
    }
    return result('I3', name, offenders.length === 0, { maxFireFraction, offenders });
}

// ── I4 ───────────────────────────────────────────────────────────────────────

export function checkI4Provenance(book, messages) {
    const name = 'provenance present, in range, and grounded';
    const live = enabled(book);
    if (!live.length) return emptyFail('I4', name);
    const last = messages.length - 1;
    const offenders = [];
    for (const e of live) {
        if (!e.sources.length) {
            offenders.push({ uid: e.uid, problem: 'no sources' });
            continue;
        }
        const bad = e.sources.filter((r) => !(Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[0] <= r[1] && r[1] <= last));
        if (bad.length) {
            offenders.push({ uid: e.uid, problem: 'source out of range or malformed', ranges: bad });
            continue;
        }
        const grounded = e.sources.some(([a, b]) => messages.slice(a, b + 1).some((m) => entryFires(e, m.text)));
        if (!grounded) offenders.push({ uid: e.uid, problem: 'no cited message mentions any of its keys', ranges: e.sources });
    }
    return result('I4', name, offenders.length === 0, { offenders });
}

// ── I5 / I6 ──────────────────────────────────────────────────────────────────

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
    }
    return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function checkI5ZeroWritesOnRerun(book, rerun) {
    const name = 'zero writes on an unchanged re-run';
    if (!book.length) return emptyFail('I5', name);
    const before = new Map(book.map((e) => [e.uid, e.raw]));
    const after = new Map(rerun.map((e) => [e.uid, e.raw]));
    const added = [...after.keys()].filter((u) => !before.has(u));
    const removed = [...before.keys()].filter((u) => !after.has(u));
    const changed = [...before.keys()].filter((u) => after.has(u) && !same(before.get(u), after.get(u)));
    return result('I5', name, !added.length && !removed.length && !changed.length, { added, removed, changed });
}

export function checkI6PinsSurvive(book, rerun) {
    const name = 'human-pinned entries survive the re-run';
    const pinned = enabled(book).filter((e) => e.pinned);
    if (!pinned.length) return result('I6', name, false, { reason: 'no pinned entry in the book: nothing to check' });
    const after = new Map(rerun.map((e) => [e.uid, e]));
    const offenders = [];
    for (const p of pinned) {
        const q = after.get(p.uid);
        if (!q) offenders.push({ uid: p.uid, problem: 'deleted' });
        else if (!q.pinned) offenders.push({ uid: p.uid, problem: 'unpinned' });
        else if (q.disabled) offenders.push({ uid: p.uid, problem: 'disabled' });
        else if (q.title !== p.title || q.content !== p.content || !same(q.keys, p.keys) || q.caseSensitive !== p.caseSensitive) {
            offenders.push({ uid: p.uid, problem: 'modified' });
        }
    }
    return result('I6', name, offenders.length === 0, { pinned: pinned.map((e) => e.uid), offenders });
}

// ── K10 ──────────────────────────────────────────────────────────────────────

/**
 * `ledger` is the run's ledger.json. A chunked book must never pass for a
 * one-shot one, and its parts must have read the whole story: no message
 * skipped, none read twice as a part (the previous part's tail may be shown
 * as context, which is not a part).
 */
export function checkK10Chunked(ledger, messageCount) {
    const name = 'output flagged as chunked, parts cover the story';
    const ck = ledger?.chunked;
    if (!ck || !Array.isArray(ck.parts)) return result('K10', name, false, { reason: "ledger has no 'chunked' record" });
    const problems = [];
    if (ck.parts.length < 2) problems.push(`only ${ck.parts.length} part(s)`);
    let next = 0;
    for (const p of ck.parts) {
        if (p.from !== next) problems.push(`part ${p.part} starts at ${p.from}, expected ${next}`);
        if (!(p.to >= p.from)) problems.push(`part ${p.part} is empty`);
        next = p.to + 1;
    }
    if (next !== messageCount) problems.push(`parts end at ${next - 1}, the story at ${messageCount - 1}`);
    if (!ck.reconciliation || typeof ck.reconciliation.ran !== 'boolean') problems.push('no reconciliation record');
    return result('K10', name, !problems.length, { parts: ck.parts.map((p) => [p.from, p.to]), reconciliation: ck.reconciliation ?? null, problems });
}

// ── L11 ──────────────────────────────────────────────────────────────────────

/**
 * `live` is the session's live.json: the live state store plus the cadence
 * it ran at and the number of messages written. Detection must fire per
 * `cadence` messages, not per message, and judge every message but the few
 * still waiting at the end (the newest is only ever look-ahead). An update fires on an edge: each one brings the
 * book up to a scene start the detector found, further than the one before.
 */
export function checkL11Live(live, messageCount) {
    const name = 'live mode: detection on a cadence, updates on scene ends';
    if (!live || !Array.isArray(live.cycles) || !live.cycles.length) return result('L11', name, false, { reason: 'no live cycles recorded' });
    const cadence = live.cadence;
    if (!(Number.isInteger(cadence) && cadence > 0)) return result('L11', name, false, { reason: 'no cadence recorded' });
    const problems = [];
    const budget = Math.ceil(messageCount / cadence);
    if (!(live.detectCalls > 0)) problems.push('no detection calls');
    if (live.detectCalls > budget) problems.push(`${live.detectCalls} detection calls for ${messageCount} messages; at most ${budget} at cadence ${cadence}`);
    const judged = live.hashes?.length ?? 0;
    // The newest message is look-ahead, so up to `cadence` can be waiting.
    if (judged > messageCount || judged < messageCount - cadence) problems.push(`${judged} of ${messageCount} messages judged`);
    const updates = live.cycles.filter((c) => c.update?.ok).map((c) => c.update.through);
    if (!updates.length) problems.push('no update ran');
    updates.forEach((t, i) => {
        if (!live.starts.includes(t + 1)) problems.push(`an update through ${t} does not end at a scene start`);
        if (i && t <= updates[i - 1]) problems.push(`an update through ${t} after one through ${updates[i - 1]}`);
    });
    return result('L11', name, !problems.length, { detectCalls: live.detectCalls, budget, judged, updates, problems });
}

// ── A12 / A13 ────────────────────────────────────────────────────────────────

/** The audit's findings that come from the deterministic pass, not from a model. */
export const TECHNICAL = ['collision', 'overlap', 'no-keys', 'overbroad', 'probability', 'recursion', 'provenance', 'deleted', 'missing'];

const foldKey = (k) => String(k).trim().toLowerCase();

/**
 * `planted` is the run's audit directory after harness/plant.js: the plant
 * (planted.json), the book before the audit (planted-book.json), the book,
 * the audit's record (audit.json) and the book after a re-run (rerun.json).
 */
export function checkA12AuditCatches({ planted, before, book, audit, rerun }) {
    const name = 'audit catches a planted collision, a deleted entry and false facts';
    if (!audit || !Array.isArray(audit.findings)) return result('A12', name, false, { reason: 'no audit record' });
    const problems = [];
    const findings = audit.findings;
    const coll = planted.collision;
    if (!findings.some((f) => f.check === 'collision' && foldKey(f.key) === foldKey(coll.key) && coll.uids.every((u) => f.uids.includes(u)))) {
        problems.push(`no collision finding for '${coll.key}' on uids ${coll.uids.join(', ')}`);
    }
    const gone = planted.deleted;
    if (!findings.some((f) => f.check === 'deleted' && f.uids.includes(gone.uid))) problems.push(`no finding for the deleted entry '${gone.title}' (uid ${gone.uid})`);
    if (!rerun) problems.push('no re-run output');
    else if (rerun.some((e) => e.uid === gone.uid || e.title === gone.title)) problems.push(`a re-run brought back the deleted entry '${gone.title}'`);
    for (const f of planted.falseFacts) {
        const hit = findings.find((x) => x.check === 'claim' && x.uids.includes(f.uid) && x.claim === f.text);
        if (!hit) problems.push(`false fact not flagged: '${f.entity}': ${f.text}`);
        else if (hit.verdict === 'supported') problems.push(`false fact judged supported: ${f.text}`);
    }
    if (!(audit.claims?.checked > 0)) problems.push('no claim was verified');
    if (!same(before.map((e) => e.raw), book.map((e) => e.raw))) problems.push('the audit changed the book');
    return result('A12', name, !problems.length, { findings: findings.length, claims: audit.claims ?? null, problems });
}

export function checkA13AuditQuiet({ audit }, { maxCleanClaimFlags = THRESHOLDS.maxCleanClaimFlags } = {}) {
    const name = 'audit raises no false alarm on a clean book';
    if (!audit || !Array.isArray(audit.findings)) return result('A13', name, false, { reason: 'no audit record' });
    const technical = audit.findings.filter((f) => TECHNICAL.includes(f.check));
    const checked = audit.claims?.checked ?? 0;
    const flagged = audit.findings.filter((f) => f.check === 'claim');
    const problems = [];
    if (technical.length) problems.push(`${technical.length} technical finding(s) on a clean book`);
    if (!checked) problems.push('no claim was verified');
    else if (flagged.length / checked > maxCleanClaimFlags) problems.push(`${flagged.length} of ${checked} claims flagged, more than ${maxCleanClaimFlags * 100}%`);
    return result('A13', name, !problems.length, { technical: technical.map((f) => f.id), flagged: flagged.map((f) => f.message), checked, maxCleanClaimFlags, problems });
}

// ── E9 ───────────────────────────────────────────────────────────────────────

/**
 * `before` is the book built from `original`; `after` is that book updated
 * for `edited`, a copy of the transcript with messages changed inside one
 * scene (scenes from the answer key's `boundaries`). An entry belongs to the
 * scene if it cites a message there or one of its keys fires on one, before
 * or after the edit. Only those may change. A pinned entry may not change
 * at all. And the edit must change something: a builder that ignores edits
 * proves nothing.
 */
export function checkE9EditLocality(before, after, original, edited, boundaries) {
    const name = 'editing one scene changes only its entities';
    if (!before.length) return emptyFail('E9', name);
    if (original.length !== edited.length) return result('E9', name, false, { reason: 'the edit fixture must edit messages in place, not add or remove them' });
    const changedIds = original.filter((m, i) => m.text !== edited[i].text || m.name !== edited[i].name).map((m) => m.id);
    if (!changedIds.length) return result('E9', name, false, { reason: 'the edited transcript is identical to the original' });
    const starts = [0, ...boundaries];
    const sceneOf = (id) => starts.filter((s) => s <= id).pop();
    const scenes = [...new Set(changedIds.map(sceneOf))];
    if (scenes.length !== 1) return result('E9', name, false, { reason: 'the edit spans more than one scene', changedIds });
    const from = scenes[0];
    const to = (starts.find((s) => s > from) ?? original.length) - 1;
    const inScene = (e) =>
        e.sources.some(([a, b]) => a <= to && b >= from) ||
        [original, edited].some((msgs) => msgs.slice(from, to + 1).some((m) => entryFires(e, m.text)));

    const byUid = (book) => new Map(book.map((e) => [e.uid, e]));
    const b = byUid(before);
    const a = byUid(after);
    const changed = [...new Set([...b.keys(), ...a.keys()])].filter((u) => !b.has(u) || !a.has(u) || !same(b.get(u).raw, a.get(u).raw));
    const offenders = [];
    for (const u of changed) {
        const prev = b.get(u);
        const next = a.get(u);
        if (prev?.pinned) offenders.push({ uid: u, title: prev.title, problem: 'pinned entry changed' });
        else if (!((prev && inScene(prev)) || (next && inScene(next)))) offenders.push({ uid: u, title: (prev ?? next).title, problem: 'changed, but not part of the edited scene' });
    }
    if (!changed.length) return result('E9', name, false, { reason: 'the edit changed nothing', scene: [from, to] });
    return result('E9', name, offenders.length === 0, { scene: [from, to], changed, offenders });
}

// ── answer key helpers ───────────────────────────────────────────────────────

/** Fold a name for identity comparison: case, a leading "the", punctuation and spacing. */
export function fold(s) {
    return String(s).toLowerCase().replace(/^the\s+/, '').replace(/[^\p{L}\p{N}']+/gu, ' ').trim();
}

const entityNames = (ent) => [ent.name, ...(ent.aliases ?? [])];

/** Message ids where the entity is mentioned by any of its names. */
export function entityMentions(ent, messages) {
    const probe = { caseSensitive: !!ent.caseSensitive, matchWholeWords: true };
    return messages.filter((m) => entityNames(ent).some((n) => keyFires(n, probe, m.text))).map((m) => m.id);
}

/**
 * "Check the answer key itself": a wrong key makes every score wrong (an
 * over-merged key once turned 0.97 precision into a fake 0.29).
 */
export function validateAnswerKey(key, messages) {
    const problems = [];
    const owner = new Map();
    for (const ent of key.entities) {
        if (!ent.name || !ent.type) problems.push(`entity missing name/type: ${JSON.stringify(ent)}`);
        for (const n of entityNames(ent)) {
            const f = fold(n);
            if (owner.has(f) && owner.get(f) !== ent.name) problems.push(`name '${n}' belongs to both '${owner.get(f)}' and '${ent.name}' (over-merged key)`);
            owner.set(f, ent.name);
        }
        if (!entityMentions(ent, messages).length) problems.push(`'${ent.name}' is never mentioned in the transcript`);
        for (const d of ent.decoys ?? []) {
            const m = messages[d];
            if (!m) problems.push(`'${ent.name}' decoy ${d} is out of range`);
            else if (!keyFires(ent.name, { caseSensitive: false }, m.text)) problems.push(`'${ent.name}' decoy ${d} does not contain the word at all`);
            else if (entityMentions(ent, [m]).length) problems.push(`'${ent.name}' decoy ${d} actually mentions the entity`);
        }
    }
    for (const k of key.contestedKeys ?? []) {
        if (owner.has(fold(k))) problems.push(`contested key '${k}' is also an entity name`);
        if (!messages.some((m) => keyFires(k, { caseSensitive: false }, m.text))) problems.push(`contested key '${k}' never appears in the transcript`);
    }
    const missName = key.planted?.miss?.entity;
    if (!missName || !key.entities.some((e) => e.name === missName && e.required)) problems.push('no required planted-miss entity');
    const coll = key.planted?.collision;
    if (!coll || !(key.contestedKeys ?? []).includes(coll.key)) problems.push('planted collision key is not listed in contestedKeys');
    for (const n of coll?.entities ?? []) {
        const ent = key.entities.find((e) => e.name === n);
        if (!ent) problems.push(`planted collision names unknown entity '${n}'`);
        else if (!messages.some((m) => entityMentions(ent, [m]).length && keyFires(coll.key, {}, m.text))) {
            problems.push(`planted collision key '${coll.key}' never appears alongside '${n}'`);
        }
    }
    const b = key.boundaries;
    if (!b.length) problems.push('answer key has no scene boundaries');
    if (b.some((x, i) => !Number.isInteger(x) || x <= 0 || x >= messages.length || (i && x <= b[i - 1]))) problems.push('boundaries must be increasing ids in 1..n-1');
    if (key.messageCount !== undefined && key.messageCount !== messages.length) problems.push(`answer key expects ${key.messageCount} messages, transcript has ${messages.length}`);
    return { ok: problems.length === 0, problems };
}

// ── C7 ───────────────────────────────────────────────────────────────────────

export function scoreC7Coverage(book, key, messages, { minRecall = THRESHOLDS.minRecall, minPrecision = THRESHOLDS.minPrecision } = {}) {
    const name = 'entity coverage vs answer key';
    const live = enabled(book);
    if (!live.length) return emptyFail('C7', name);

    const nameToEntity = new Map();
    for (const ent of key.entities) for (const n of entityNames(ent)) nameToEntity.set(fold(n), ent);

    const byEntity = new Map(key.entities.map((ent) => [ent.name, []]));
    const overMerged = [];
    const extra = [];
    for (const e of live) {
        const hits = new Set([e.title, ...e.keys].map((n) => nameToEntity.get(fold(n))).filter(Boolean));
        if (hits.size === 0) extra.push({ uid: e.uid, title: e.title });
        if (hits.size > 1) overMerged.push({ uid: e.uid, entities: [...hits].map((x) => x.name) });
        for (const ent of hits) byEntity.get(ent.name).push(e);
    }

    const required = key.entities.filter((ent) => ent.required);
    const missed = required.filter((ent) => !byEntity.get(ent.name).length).map((ent) => ent.name);
    const split = key.entities.filter((ent) => byEntity.get(ent.name).length > 1).map((ent) => ({ entity: ent.name, uids: byEntity.get(ent.name).map((e) => e.uid) }));

    const unreachable = [];
    const decoyFires = [];
    for (const ent of key.entities) {
        const entries = byEntity.get(ent.name);
        if (!entries.length) continue;
        const mentions = entityMentions(ent, messages);
        for (const e of entries) {
            if (!mentions.some((id) => entryFires(e, messages[id].text))) unreachable.push({ entity: ent.name, uid: e.uid });
            const fired = (ent.decoys ?? []).filter((id) => entryFires(e, messages[id].text));
            if (fired.length) decoyFires.push({ entity: ent.name, uid: e.uid, messages: fired });
        }
    }

    const contested = new Set((key.contestedKeys ?? []).map((k) => k.toLowerCase()));
    const contestedClaims = live.flatMap((e) => e.keys.filter((k) => contested.has(k.toLowerCase())).map((k) => ({ uid: e.uid, key: k })));

    const recall = (required.length - missed.length) / required.length;
    const precision = (live.length - extra.length) / live.length;
    const ok = recall >= minRecall && precision >= minPrecision && !split.length && !overMerged.length && !unreachable.length && !decoyFires.length && !contestedClaims.length;
    return result('C7', name, ok, { recall, precision, minRecall, minPrecision, missed, extra, split, overMerged, unreachable, decoyFires, contestedClaims });
}

// ── C8 ───────────────────────────────────────────────────────────────────────

export function scoreC8Boundaries(predicted, expected, {
    tolerance = THRESHOLDS.boundaryTolerance,
    minPrecision = THRESHOLDS.minBoundaryPrecision,
    minRecall = THRESHOLDS.minBoundaryRecall,
} = {}) {
    const name = `scene boundaries at ±${tolerance}`;
    if (!predicted.length) return result('C8', name, false, { reason: 'no boundaries predicted: nothing to check' });
    if (!expected.length) return result('C8', name, false, { reason: 'answer key has no boundaries' });
    // One-to-one: each expected boundary can be claimed by at most one prediction.
    const free = [...expected];
    let hits = 0;
    for (const p of [...predicted].sort((a, b) => a - b)) {
        let best = -1;
        for (let i = 0; i < free.length; i++) {
            if (Math.abs(free[i] - p) <= tolerance && (best < 0 || Math.abs(free[i] - p) < Math.abs(free[best] - p))) best = i;
        }
        if (best >= 0) {
            free.splice(best, 1);
            hits++;
        }
    }
    const precision = hits / predicted.length;
    const recall = hits / expected.length;
    return result('C8', name, precision >= minPrecision && recall >= minRecall, { precision, recall, minPrecision, minRecall, unmatchedExpected: free });
}
