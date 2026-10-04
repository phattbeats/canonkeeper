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

test('C7 red: too many entries for things not in the story', () => {
    const book = mutate((r) => {
        for (let i = 0; i < 6; i++) r.push({ ...structuredClone(r[0]), uid: 200 + i, comment: `Invented ${i}`, key: [`Invented${i}`] });
    });
    const c = scoreC7Coverage(book, key, messages);
    assert.equal(c.ok, false);
    assert.ok(c.detail.precision < 0.8);
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
