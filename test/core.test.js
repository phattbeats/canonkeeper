// The one-shot core, with the model replaced by canned replies. Each test
// feeds the model shape one specific mistake and checks the compiled book
// can't carry it: keys stay unique, grounded and case-correct whatever the
// model says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { parseTranscript } from '../src/transcript.js';
import { build, rerun } from '../src/build.js';
import { compile, toRanges } from '../src/compile.js';
import { readReply, ModelOutputError } from '../src/parse.js';
import { TooLongError } from '../src/budget.js';
import { fingerprint } from '../src/fingerprint.js';
import { replay } from '../src/models/replay.js';
import { runGate } from '../harness/gate.js';

const STORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'story');
const messages = parseTranscript(readFileSync(join(STORY, 'transcript.jsonl'), 'utf8'));
const recorded = JSON.parse(readFileSync(join(STORY, 'recorded', 'replies.json'), 'utf8'));

const ent = (name, keys, ids, extra = {}) => ({ name, keys, facts: [{ text: `${name} is in the story.`, messages: ids }], caseSensitive: false, cascade: true, throttle: 0, ...extra });
const titled = (entries, name) => entries.find((e) => e.comment === name);

// ── the model shape is read strictly ────────────────────────────────────────

test('a reply that is not JSON is rejected', () => {
    assert.throws(() => readReply('Here is your lorebook!', 81), ModelOutputError);
    assert.throws(() => readReply('{"entities": []}', 81), ModelOutputError);
});

test('facts lose out-of-range sources, and an entity with no sourced fact goes to review', () => {
    const r = readReply(JSON.stringify({ scenes: [{ start: 0 }, { start: 10 }, { start: 999 }], entities: [
        { name: 'Saltgate', keys: ['Saltgate'], facts: [{ text: 'A port.', messages: [0, 500] }] },
        { name: 'Nowhere', keys: ['Nowhere'], facts: [{ text: 'Invented.', messages: [500] }] },
    ] }), 81);
    assert.deepEqual(r.scenes, [10]);
    assert.deepEqual(r.entities[0].facts[0].messages, [0]);
    assert.deepEqual(r.review.map((x) => x.name), ['Nowhere']);
});

test('bad JSON gets exactly one retry, then the run fails rather than guessing', async () => {
    const good = recorded[0];
    const ok = await build({ messages, generate: replay(['not json', good]), contextTokens: 200000 });
    assert.ok(Object.keys(ok.book.entries).length > 0);
    await assert.rejects(build({ messages, generate: replay(['not json', 'still not json', good]), contextTokens: 200000 }), ModelOutputError);
});

// ── keys are unique, grounded and case-correct by construction ─────────────

test('a key two entities claim is dropped from both', () => {
    const { entries, contested } = compile([ent('Mora Quill', ['Quill', 'Captain'], [2]), ent('Oren Hale', ['Hale', 'Captain'], [8])], messages);
    assert.deepEqual(contested, ['captain']);
    for (const e of entries) assert.ok(!e.key.map((k) => k.toLowerCase()).includes('captain'), e.comment);
});

test('a name that is also a lowercase word becomes case-sensitive', () => {
    const { entries } = compile([ent('Wren', ['Wren'], [6])], messages);
    assert.equal(entries[0].caseSensitive, true);
});

test('a case-sensitive entry also keys the capitalised form of a lowercase epithet', () => {
    const { entries } = compile([ent('Wren', ['Wren', 'street runner'], [6], { caseSensitive: true })], messages);
    assert.equal(entries[0].caseSensitive, true);
    assert.ok(entries[0].key.includes('street runner'));
});

// Padding so a key on two messages isn't "nearly every message".
const pad = (texts) => [...texts, 'Rain.', 'Wind.', 'Fog.'].map((text, id) => ({ id, text }));

test('a phrase used in lower case mid-sentence does not make its entry case-sensitive', () => {
    const msgs = pad(['The Prophecy was old.', 'Nobody trusted the prophecy.']);
    const [entry] = compile([ent('The Prophecy', ['the prophecy'], [0, 1])], msgs).entries;
    assert.equal(entry.caseSensitive, false);
    assert.deepEqual(entry.key, ['the prophecy']);
});

test('a case-sensitive "the X" key also matches "The X" at the start of a sentence', () => {
    const msgs = pad(['The Tailor bowed.', 'She feared the Tailor.']);
    const [entry] = compile([ent('The Tailor', ['the Tailor'], [0, 1], { caseSensitive: true })], msgs).entries;
    assert.equal(entry.caseSensitive, true);
    assert.deepEqual([...entry.key].sort(), ['The Tailor', 'the Tailor']);
});

test('a key the story never uses is dropped', () => {
    const { entries, ledger } = compile([ent('Tamsin Dray', ['Tamsin', 'the Courier Queen'], [2])], messages);
    assert.deepEqual([...entries[0].key].sort(), ['Tamsin', 'Tamsin Dray']);
    assert.match(ledger[0].dropped[0].reason, /not in the transcript/);
});

test('a key that fires on nearly every message is dropped', () => {
    const { entries, review } = compile([ent('Zzyzx', ['the'], [0])], messages);
    assert.equal(entries.length, 0);
    assert.match(review[0].reason, /no usable key/);
});

test('an entity whose sources never mention it goes to review, not the book', () => {
    const { entries, review } = compile([ent('Saltgate', ['Saltgate'], [1])], messages);
    assert.equal(entries.length, 0);
    assert.match(review[0].reason, /cited messages/);
});

test('every fact keeps its own provenance and the entry gets their union', () => {
    const e = { ...ent('Tamsin Dray', ['Tamsin'], [2]), facts: [{ text: 'A courier.', messages: [2, 3] }, { text: 'Hired by Quill.', messages: [4] }] };
    const [entry] = compile([e], messages).entries;
    assert.deepEqual(entry.canonkeeper.sources, [[2, 4]]);
    assert.deepEqual(entry.canonkeeper.facts.map((f) => f.sources), [[[2, 3]], [[4, 4]]]);
    assert.equal(entry.content, 'A courier. Hired by Quill.');
});

test('two replies about one name are merged, never split', () => {
    const { entries } = compile([ent('Ines Vell', ['Ines'], [65]), ent('ines vell', ['cartographer'], [4])], messages);
    assert.equal(entries.length, 1);
    assert.deepEqual([...entries[0].key].sort(), ['Ines', 'Ines Vell', 'cartographer']);
});

test('the model never writes ST fields: cascade and throttle compile to recursion and cooldown', () => {
    const [entry] = compile([ent('Saltgate', ['Saltgate'], [0], { cascade: false, throttle: 3 })], messages).entries;
    assert.equal(entry.preventRecursion, true);
    assert.equal(entry.cooldown, 3);
    assert.equal(entry.disable, false);
    assert.equal(entry.matchWholeWords, true);
});

test('toRanges merges consecutive ids', () => {
    assert.deepEqual(toRanges([5, 1, 2, 3, 9, 2]), [[1, 3], [5, 5], [9, 9]]);
});

// ── size comes from the context window ──────────────────────────────────────

test('a story that does not fit the window is refused before any model call', async () => {
    let called = false;
    const generate = async () => ((called = true), recorded[0]);
    await assert.rejects(build({ messages, generate, contextTokens: 4000 }), TooLongError);
    assert.equal(called, false);
});

// ── re-running ──────────────────────────────────────────────────────────────

test('an unchanged transcript re-runs with zero writes and no model call', async () => {
    const first = await build({ messages, generate: replay(recorded), contextTokens: 200000 });
    first.book.entries['0'].canonkeeper.pinned = true;
    const again = await rerun({ book: first.book, ledger: first.ledger, messages, generate: replay([]), contextTokens: 200000 });
    assert.equal(again.wrote, false);
    assert.deepEqual(again.book, first.book);
});

test('a changed transcript rebuilds, and a pinned entry keeps its uid, text and keys', async () => {
    const first = await build({ messages, generate: replay(recorded), contextTokens: 200000 });
    const saul = Object.values(first.book.entries).find((e) => e.comment === 'Brother Saul');
    saul.canonkeeper.pinned = true;
    saul.content = 'Edited by a human.';
    const pinnedBefore = structuredClone(saul);
    const edited = messages.map((m) => (m.id === 80 ? { ...m, text: m.text + ' The end.' } : m));
    assert.notEqual(fingerprint(edited), first.ledger.fingerprint);
    const again = await rerun({ book: first.book, ledger: first.ledger, messages: edited, generate: replay(recorded), contextTokens: 200000 });
    assert.equal(again.wrote, true);
    assert.deepEqual(again.book.entries[String(saul.uid)], pinnedBefore);
    const sauls = Object.values(again.book.entries).filter((e) => e.comment === 'Brother Saul');
    assert.equal(sauls.length, 1);
});

test('a pinned entry wins a key contest', () => {
    const pin = { uid: 7, comment: 'Mora Quill', key: ['Quill'], content: 'x', canonkeeper: { pinned: true, sources: [[2, 2]] } };
    const { entries } = compile([ent('Gull Captain', ['Quill', "Gull's Errand"], [2])], messages, { pinned: [pin] });
    assert.deepEqual(titled(entries, 'Mora Quill').key, ['Quill']);
    assert.ok(!titled(entries, 'Gull Captain').key.includes('Quill'));
});

// ── end to end: the recorded reply, through the builder, through the gate ──

test('the builder on the recorded reply passes the whole gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canonkeeper-'));
    const first = await build({ messages, generate: replay(recorded), contextTokens: 200000 });
    Object.values(first.book.entries).find((e) => e.comment === 'Brother Saul').canonkeeper.pinned = true;
    const again = await rerun({ book: first.book, ledger: first.ledger, messages, generate: replay([]), contextTokens: 200000 });
    writeFileSync(join(dir, 'book.json'), JSON.stringify(first.book));
    writeFileSync(join(dir, 'rerun.json'), JSON.stringify(again.book));
    writeFileSync(join(dir, 'scenes.json'), JSON.stringify(first.scenes));
    const report = runGate({ storyDir: STORY, runDir: dir });
    for (const c of report.checks) assert.equal(c.ok, true, `${c.id}: ${JSON.stringify(c.detail)}`);
});
