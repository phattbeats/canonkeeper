// Proves the harness can fail. Every check is shown green on the reference
// and red on a book broken in exactly the way that check exists to catch.
// The mutations are made in memory from the reference, so each one changes
// only one thing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadTranscript, loadAnswerKey, loadRun, normalizeEntry, FixtureError } from '../harness/load.js';
import {
    validateAnswerKey,
    checkI1KeywordCollisions,
    checkI2ZeroKeyEntries,
    checkI3OverbroadKeys,
    checkI4Provenance,
    checkI5ZeroWritesOnRerun,
    checkI6PinsSurvive,
    scoreC7Coverage,
    scoreC8Boundaries,
    checkA12AuditCatches,
    checkA13AuditQuiet,
} from '../harness/checks.js';
import { runGate } from '../harness/gate.js';

const STORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'story');
const messages = loadTranscript(join(STORY, 'transcript.jsonl'));
const key = loadAnswerKey(join(STORY, 'answer-key.json'));
const reference = loadRun(join(STORY, 'reference'));

/** A deep copy of the reference book with `edit(rawEntries)` applied. */
function mutate(edit, book = reference.book) {
    const raws = book.map((e) => structuredClone(e.raw));
    edit(raws);
    return raws.map(normalizeEntry);
}
const byTitle = (raws, title) => raws.find((r) => r.comment === title);

// ── fixtures are what they claim to be ──────────────────────────────────────

test('the story is about 80 messages with narrator headers', () => {
    assert.ok(messages.length >= 75 && messages.length <= 90, `got ${messages.length}`);
    const headed = messages.filter((m) => /^\[[^\]]+·[^\]]+\]/.test(m.text));
    assert.ok(headed.length >= 6, `only ${headed.length} narrator headers`);
});

test('the answer key passes its own validation', () => {
    assert.deepEqual(validateAnswerKey(key, messages), { ok: true, problems: [] });
});

test('answer-key validation catches an over-merged key', () => {
    const bad = structuredClone(key);
    bad.entities.find((e) => e.name === 'Oren Hale').aliases.push('Quill');
    const v = validateAnswerKey(bad, messages);
    assert.equal(v.ok, false);
    assert.match(v.problems.join('\n'), /over-merged/);
});

test('answer-key validation catches a decoy that is really a mention', () => {
    const bad = structuredClone(key);
    bad.entities.find((e) => e.name === 'Wren').decoys.push(7);
    assert.equal(validateAnswerKey(bad, messages).ok, false);
});

test('the answer key scores 1.0 against its own reference book', () => {
    const c7 = scoreC7Coverage(reference.book, key, messages);
    assert.equal(c7.ok, true, JSON.stringify(c7.detail));
    assert.equal(c7.detail.recall, 1);
    assert.equal(c7.detail.precision, 1);
    const c8 = scoreC8Boundaries(reference.boundaries, key.boundaries);
    assert.equal(c8.detail.precision, 1);
    assert.equal(c8.detail.recall, 1);
});

test('the reference run is green on every check', () => {
    const report = runGate({ storyDir: STORY, runDir: join(STORY, 'reference') });
    for (const c of report.checks) assert.equal(c.ok, true, `${c.id}: ${JSON.stringify(c.detail)}`);
    assert.equal(report.ok, true);
});

test('the committed broken book is red', () => {
    const report = runGate({ storyDir: STORY, runDir: join(STORY, 'broken-collision') });
    assert.equal(report.ok, false);
    assert.deepEqual(report.checks.filter((c) => !c.ok).map((c) => c.id), ['I1', 'C7']);
});

// ── I1–I6 ───────────────────────────────────────────────────────────────────

test('I1 red: planted collision — both captains claim "Captain"', () => {
    const book = mutate((r) => {
        byTitle(r, 'Mora Quill').key.push('Captain');
        byTitle(r, 'Oren Hale').key.push('captain');
    });
    const c = checkI1KeywordCollisions(book);
    assert.equal(c.ok, false);
    assert.equal(c.detail.collisions[0].key, 'Captain');
});

test('I1 green: two case-sensitive claims that differ only in case do not collide', () => {
    const book = mutate((r) => {
        byTitle(r, 'Wren').key.push('Rook');
        Object.assign(byTitle(r, 'Oren Hale'), { key: [...byTitle(r, 'Oren Hale').key, 'ROOK'] });
    });
    assert.equal(checkI1KeywordCollisions(book).ok, true);
});

test('I2 red: an entry with no keys', () => {
    const book = mutate((r) => (byTitle(r, 'Saltgate').key = []));
    assert.equal(checkI2ZeroKeyEntries(book).ok, false);
});

test('I3 red: a key that fires on nearly every message', () => {
    const book = mutate((r) => byTitle(r, 'Saltgate').key.push('the'));
    const c = checkI3OverbroadKeys(book, messages);
    assert.equal(c.ok, false);
    assert.equal(c.detail.offenders[0].key, 'the');
});

test('I3 red: a constant entry counts as firing everywhere', () => {
    const book = mutate((r) => (byTitle(r, 'Saltgate').constant = true));
    assert.equal(checkI3OverbroadKeys(book, messages).ok, false);
});

test('I4 red: provenance past the end of the transcript', () => {
    const book = mutate((r) => (byTitle(r, 'The Harbor Fire').canonkeeper.sources = [[30, 120]]));
    assert.equal(checkI4Provenance(book, messages).ok, false);
});

test('I4 red: an entry with no provenance', () => {
    const book = mutate((r) => delete byTitle(r, 'The Harbor Fire').canonkeeper);
    assert.equal(checkI4Provenance(book, messages).ok, false);
});

test('I4 red: provenance that cites messages never mentioning the entry', () => {
    const book = mutate((r) => (byTitle(r, 'The Harbor Fire').canonkeeper.sources = [[0, 9]]));
    const c = checkI4Provenance(book, messages);
    assert.equal(c.ok, false);
    assert.match(c.detail.offenders[0].problem, /mentions/);
});

test('I5 red: the re-run rewords a stable entry', () => {
    const rerun = mutate((r) => (byTitle(r, 'Saltgate').content += ' It is a port.'), reference.rerun);
    const c = checkI5ZeroWritesOnRerun(reference.book, rerun);
    assert.equal(c.ok, false);
    assert.deepEqual(c.detail.changed, [byTitle(reference.book.map((e) => e.raw), 'Saltgate').uid]);
});

test('I5 red: the re-run adds an entry', () => {
    const rerun = mutate((r) => r.push({ ...structuredClone(r[0]), uid: 99, comment: 'Pell' }), reference.rerun);
    assert.equal(checkI5ZeroWritesOnRerun(reference.book, rerun).ok, false);
});

test('I5 green: key order inside an entry is not a write', () => {
    const rerun = mutate((r) => r.forEach((x, i) => (r[i] = Object.fromEntries(Object.entries(x).reverse()))), reference.rerun);
    assert.equal(checkI5ZeroWritesOnRerun(reference.book, rerun).ok, true);
});

test('I6 red: the re-run overwrites the human-pinned entry', () => {
    const rerun = mutate((r) => (byTitle(r, 'Brother Saul').content = 'Brother Saul is a monk.'), reference.rerun);
    const c = checkI6PinsSurvive(reference.book, rerun);
    assert.equal(c.ok, false);
    assert.equal(c.detail.offenders[0].problem, 'modified');
});

test('I6 red: the re-run deletes the pinned entry', () => {
    const rerun = mutate((r) => r.splice(r.indexOf(byTitle(r, 'Brother Saul')), 1), reference.rerun);
    assert.equal(checkI6PinsSurvive(reference.book, rerun).ok, false);
});

test('I6 red: a book with no pins has nothing to prove', () => {
    const book = mutate((r) => r.forEach((x) => (x.canonkeeper.pinned = false)));
    assert.equal(checkI6PinsSurvive(book, book).ok, false);
});

// ── C7 ──────────────────────────────────────────────────────────────────────

test('C7 red: planted miss — Ines Vell has no entry', () => {
    const book = mutate((r) => r.splice(r.indexOf(byTitle(r, 'Ines Vell')), 1));
    const c = scoreC7Coverage(book, key, messages);
    assert.equal(c.ok, false);
    assert.deepEqual(c.detail.missed, ['Ines Vell']);
});

test('C7 red: planted miss split — "the cartographer" and "Ines Vell" as two entries', () => {
    const book = mutate((r) => {
        const ines = byTitle(r, 'Ines Vell');
        ines.key = ['Ines Vell', 'Ines'];
        r.push({ ...structuredClone(ines), uid: 98, comment: 'The Cartographer', key: ['cartographer'], canonkeeper: { sources: [[4, 5]], pinned: false } });
    });
    const c = scoreC7Coverage(book, key, messages);
    assert.equal(c.ok, false);
    assert.equal(c.detail.split[0].entity, 'Ines Vell');
});

test('C7 red: one entry over-merges two entities', () => {
    const book = mutate((r) => byTitle(r, 'Mora Quill').key.push('Hale'));
    assert.equal(scoreC7Coverage(book, key, messages).detail.overMerged.length, 1);
});

test('C7 red: the case trap — Wren keyed case-insensitively fires on the bird', () => {
    const book = mutate((r) => (byTitle(r, 'Wren').caseSensitive = false));
    const c = scoreC7Coverage(book, key, messages);
    assert.equal(c.ok, false);
    assert.deepEqual(c.detail.decoyFires[0].messages, [10, 30, 79]);
});

test('C7 red: a single entry claiming the contested key', () => {
    const book = mutate((r) => byTitle(r, 'Oren Hale').key.push('Captain'));
    assert.equal(checkI1KeywordCollisions(book).ok, true, 'one claim is not a collision');
    assert.equal(scoreC7Coverage(book, key, messages).ok, false);
});

test('C7 red: an entry whose keys never fire on its own mentions', () => {
    const book = mutate((r) => (byTitle(r, 'The Harbor Fire').key = ['Harbour Blaze']));
    const c = scoreC7Coverage(book, key, messages);
    assert.equal(c.ok, false);
    assert.ok(c.detail.missed.includes('Harbor Fire') || c.detail.unreachable.length);
});

test('C7 red: an entry for something the story never mentions', () => {
    const book = mutate((r) => r.push({ ...structuredClone(r[0]), uid: 200, comment: 'Invented', key: ['Invented'] }));
    const c = scoreC7Coverage(book, key, messages);
    assert.equal(c.ok, false);
    assert.deepEqual(c.detail.ungrounded.map((x) => x.title), ['Invented']);
});

test('C7 green: real entries the key does not list are reported, not gated', () => {
    const book = mutate((r) => {
        for (const [i, k] of ['rain', 'shutters', 'warehouses', 'fish market', 'lamp room', 'spiral stair'].entries()) r.push({ ...structuredClone(r[0]), uid: 200 + i, comment: k, key: [k] });
    });
    const c = scoreC7Coverage(book, key, messages);
    assert.equal(c.ok, true);
    assert.equal(c.detail.extra.length, 6);
    assert.ok(c.detail.precision < 0.8);
});

test('C7 red: two entries for one thing the key does not list', () => {
    const book = mutate((r) => {
        r.push({ ...structuredClone(r[0]), uid: 200, comment: 'The Lamp Room', key: ['lamp room'] });
        r.push({ ...structuredClone(r[0]), uid: 201, comment: 'Kestrel lamp', key: ['Lamp Room', 'great lens'] });
    });
    const c = scoreC7Coverage(book, key, messages);
    assert.equal(c.ok, false);
    assert.deepEqual(c.detail.duplicates.map((d) => d.uids), [[200, 201]]);
});

// ── C8 ──────────────────────────────────────────────────────────────────────

test('C8 green within ±1, red beyond it', () => {
    assert.equal(scoreC8Boundaries(key.boundaries.map((b) => b + 1), key.boundaries).ok, true);
    assert.equal(scoreC8Boundaries(key.boundaries.map((b) => b + 2), key.boundaries).ok, false);
});

test('C8 red: missing the header-less break at 52 drops recall below 0.9', () => {
    const c = scoreC8Boundaries(key.boundaries.filter((b) => b !== 52), key.boundaries);
    assert.equal(c.ok, false);
    assert.deepEqual(c.detail.unmatchedExpected, [52]);
});

test('C8 red: a boundary on every message', () => {
    assert.equal(scoreC8Boundaries(messages.map((m) => m.id).slice(1), key.boundaries).ok, false);
});

// ── vacancy ─────────────────────────────────────────────────────────────────

test('an empty book is red on every check, never vacuously green', () => {
    for (const c of [
        checkI1KeywordCollisions([]),
        checkI2ZeroKeyEntries([]),
        checkI3OverbroadKeys([], messages),
        checkI4Provenance([], messages),
        checkI5ZeroWritesOnRerun([], []),
        checkI6PinsSurvive([], []),
        scoreC7Coverage([], key, messages),
        scoreC8Boundaries([], key.boundaries),
    ]) {
        assert.equal(c.ok, false, `${c.id} passed on an empty book`);
    }
});

test('a run directory with a missing file is a fixture error, not a pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-run-'));
    copyFileSync(join(STORY, 'reference', 'book.json'), join(dir, 'book.json'));
    writeFileSync(join(dir, 'scenes.json'), JSON.stringify({ boundaries: [10] }));
    assert.throws(() => runGate({ storyDir: STORY, runDir: dir }), FixtureError);
});

test('a missing story directory is a fixture error, not a pass', () => {
    assert.throws(() => runGate({ storyDir: join(STORY, 'nope'), runDir: join(STORY, 'reference') }), FixtureError);
});

// ── A12 / A13: the audit gate can fail ──────────────────────────────────────

/** A minimal audit run: the broken fixture as the planted book, and an audit that saw everything. */
function auditRun() {
    const book = loadRun(join(STORY, 'broken-collision')).book;
    const uids = book.filter((e) => e.keys.includes('Captain')).map((e) => e.uid);
    const planted = {
        collision: { key: 'Captain', uids },
        deleted: { uid: 999, title: 'Gone' },
        falseFacts: [{ entity: 'Pell', uid: 0, text: 'Pell is a sea serpent.' }],
    };
    const audit = {
        claims: { total: 10, checked: 10, stale: 0, unchecked: 0 },
        findings: [
            { id: 'collision:captain', check: 'collision', key: 'Captain', uids },
            { id: 'deleted:999', check: 'deleted', uids: [999] },
            { id: 'claim:0:x', check: 'claim', uids: [0], claim: 'Pell is a sea serpent.', verdict: 'contradicted' },
        ],
    };
    return { planted, before: book, book: structuredClone(book), audit, rerun: book };
}

test('A12 green when the audit caught every plant', () => {
    assert.equal(checkA12AuditCatches(auditRun()).ok, true);
});

test('A12 red when the audit missed the collision, the deletion or a false fact', () => {
    for (const check of ['collision', 'deleted', 'claim']) {
        const run = auditRun();
        run.audit.findings = run.audit.findings.filter((f) => f.check !== check);
        assert.equal(checkA12AuditCatches(run).ok, false, check);
    }
    const run = auditRun();
    run.audit.findings[2].verdict = 'supported';
    assert.equal(checkA12AuditCatches(run).ok, false);
});

test('A12 red when a re-run brought the deleted entry back, or the audit wrote to the book', () => {
    const back = auditRun();
    back.rerun = [...back.rerun, { uid: 999, title: 'Gone', keys: ['Gone'], raw: {} }];
    assert.equal(checkA12AuditCatches(back).ok, false);
    const wrote = auditRun();
    wrote.book[0] = { ...wrote.book[0], raw: { ...wrote.book[0].raw, key: [] } };
    assert.equal(checkA12AuditCatches(wrote).ok, false);
    const none = auditRun();
    none.audit.claims.checked = 0;
    assert.equal(checkA12AuditCatches(none).ok, false);
});

test('A13 red on any technical finding, too many flagged claims, or nothing verified', () => {
    const quiet = { audit: { claims: { checked: 20 }, findings: [{ check: 'claim' }] } };
    assert.equal(checkA13AuditQuiet(quiet).ok, true);
    assert.equal(checkA13AuditQuiet({ audit: { claims: { checked: 20 }, findings: [{ id: 'collision:x', check: 'collision' }] } }).ok, false);
    assert.equal(checkA13AuditQuiet({ audit: { claims: { checked: 20 }, findings: Array(4).fill({ check: 'claim' }) } }).ok, false);
    assert.equal(checkA13AuditQuiet({ audit: { claims: { checked: 0 }, findings: [] } }).ok, false);
});
