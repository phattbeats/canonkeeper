// Deep entries (PHA-4527): quotes checked word for word, redundant keys
// dropped, scene entries and the Timeline, profiles laid out whole, and the
// replay gate on the fixture (D17–D19).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { parseTranscript } from '../src/transcript.js';
import { build } from '../src/build.js';
import { update } from '../src/update.js';
import { compile, renderContent } from '../src/compile.js';
import { readReply } from '../src/parse.js';
import { checkQuotes } from '../src/quotes.js';
import { replay } from '../src/models/replay.js';
import { runGate } from '../harness/gate.js';
import { checkD17Scenes, checkD18MainCharacters, checkD19RedundantKeys } from '../harness/checks.js';
import { normalizeEntry } from '../harness/load.js';

const STORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'story');
const messages = parseTranscript(readFileSync(join(STORY, 'transcript.jsonl'), 'utf8'));
const deep = JSON.parse(readFileSync(join(STORY, 'deep', 'replies.json'), 'utf8'));
const key = JSON.parse(readFileSync(join(STORY, 'answer-key.json'), 'utf8'));

const ent = (name, keys, ids, extra = {}) => ({ name, keys, facts: [{ text: `${name} is in the story.`, messages: ids }], caseSensitive: false, cascade: true, throttle: 0, ...extra });
const titled = (entries, name) => entries.find((e) => e.comment === name);
const msg18 = messages[18].text; // "Go," Hale says quietly ... "If I see you again tonight, I'll have to do my job. ..."

// ── the quote check ─────────────────────────────────────────────────────────

test('a quote is kept only if it is word for word in the message it cites', () => {
    const real = "If I see you again tonight, I'll have to do my job.";
    const { kept, removed } = checkQuotes(
        [
            { text: real, message: 18 },
            { text: "If I see you again tonight, I will have to do my job.", message: 18 }, // reworded
            { text: real, message: 17 }, // right words, wrong message
            { text: real, message: 9999 }, // no such message
            { text: 'Go,', message: 18 }, // one word is not a line
        ],
        messages,
    );
    assert.deepEqual(kept.map((q) => q.text), [real]);
    assert.equal(removed.length, 4);
    assert.match(removed[0].why, /not word for word in message 18/);
    assert.match(removed[2].why, /does not exist/);
    assert.match(removed[3].why, /under 2 words/);
});

test('typography and spacing do not matter to the quote check, words do', () => {
    const msgs = [{ id: 0, text: 'She said, “It’s    not   mine, Captain.”' }];
    assert.equal(checkQuotes([{ text: "It's not mine, Captain.", message: 0 }], msgs).kept.length, 1);
    assert.equal(checkQuotes([{ text: "it's not mine, Captain.", message: 0 }], msgs).kept.length, 0, 'case is part of the words');
});

test('compile removes an invented quote from the entry and lists it for review', () => {
    const real = "If I see you again tonight, I'll have to do my job.";
    const fake = 'I always keep my promises, even to thieves.';
    const { entries, review, ledger } = compile([ent('Oren Hale', ['Hale'], [18], { quotes: [{ text: real, message: 18, speaker: 'Hale' }, { text: fake, message: 18, speaker: 'Hale' }] })], messages);
    const hale = titled(entries, 'Oren Hale');
    assert.ok(hale.content.includes(real));
    assert.ok(!hale.content.includes(fake));
    assert.deepEqual(hale.canonkeeper.quotes.map((q) => q.text), [real]);
    assert.deepEqual(ledger[0].quotes.map((q) => q.text), [real], 'the canon keeps only verified quotes');
    const r = review.find((x) => x.quote === fake);
    assert.match(r.reason, /quote removed, not word for word in message 18/);
});

// ── triggers ────────────────────────────────────────────────────────────────

test('a key that only repeats another kept key in a longer form is dropped, with the reason', () => {
    const { entries, ledger } = compile([ent('Ines Vell', ['Ines', 'Ines Vell', 'the cartographer', 'cartographer'], [4, 65])], messages);
    assert.deepEqual([...titled(entries, 'Ines Vell').key].sort(), ['Ines', 'cartographer']);
    const why = Object.fromEntries(ledger[0].compiled.dropped.map((d) => [d.key, d.reason]));
    assert.match(why['Ines Vell'], /repeats 'Ines' in a longer form/);
    assert.match(why['the cartographer'], /repeats 'cartographer' in a longer form/);
});

test('the longer form stays when the shorter one was lost to another entity', () => {
    // "Captain" is shared with Oren Hale, so it is dropped; "Captain Quill" is then a real trigger.
    const { entries } = compile([ent('Mora Quill', ['Captain', 'Captain Quill'], [2]), ent('Oren Hale', ['Hale', 'Captain'], [8])], messages);
    assert.ok(titled(entries, 'Mora Quill').key.includes('Captain Quill'));
    assert.ok(!titled(entries, 'Mora Quill').key.includes('Captain'));
});

test('distinct triggers all stay: nicknames and role nouns are not repeats', () => {
    const { entries } = compile([ent('Tamsin Dray', ['Tamsin', 'courier'], [2])], messages);
    assert.deepEqual([...titled(entries, 'Tamsin Dray').key].sort(), ['Tamsin', 'courier']);
});

// ── scene entries and the Timeline ──────────────────────────────────────────

const sceneReply = (extra = {}) =>
    JSON.stringify({
        scenes: [
            {
                start: 0, title: 'The Drowned Lantern', when: 'Day 1, dusk', where: 'The Drowned Lantern', who: ['Tamsin', 'Quill'], line: 'Quill hires Tamsin.',
                keys: ['Drowned Lantern'], facts: [{ text: 'Quill hires Tamsin to carry a sealed tube.', messages: [1] }, { text: 'It starts the mission.', section: 'why', messages: [1] }],
                quotes: [{ text: "If I see you again tonight, I'll have to do my job.", speaker: 'Hale', message: 18 }], ...extra,
            },
            { start: 10, title: 'The Quay', when: 'Day 1, night', where: 'The docks', who: ['Hale'], line: 'Hale lets her go.', keys: ['quay'], facts: [{ text: 'Hale lets Tamsin go.', messages: [18] }] },
        ],
        entities: [{ name: 'Tamsin Dray', keys: ['Tamsin'], facts: [{ text: 'A courier.', messages: [2] }] }],
    });

test('a scene with facts becomes a scene entity; one without stays a boundary', () => {
    const r = readReply(JSON.stringify({ scenes: [{ start: 12, cut: 'later' }], entities: [] }), 81);
    assert.deepEqual(r.scenes, [12]);
    assert.equal(r.entities.length, 0);
    const d = readReply(sceneReply(), 81);
    assert.deepEqual(d.scenes, [10]);
    const scene = d.entities.find((e) => e.kind === 'scene' && e.start === 0);
    assert.equal(scene.name, 'Scene: The Drowned Lantern');
    assert.deepEqual(scene.who, ['Tamsin', 'Quill']);
});

test('scene entries carry what, when, where, who, why and quotes, keyed on the scene', () => {
    const { entries, ledger } = compile(readReply(sceneReply(), 81).entities, messages);
    const scene = titled(entries, 'Scene: The Drowned Lantern');
    assert.deepEqual(scene.key, ['Drowned Lantern']);
    assert.match(scene.content, /^When: Day 1, dusk\. Where: The Drowned Lantern\. Who: Tamsin, Quill\./);
    assert.match(scene.content, /Why it matters: It starts the mission\./);
    assert.equal(scene.canonkeeper.kind, 'scene');
    assert.equal(scene.canonkeeper.start, 0);
    assert.ok(ledger.find((e) => e.name === 'Scene: The Quay').start === 10, 'the ledger keeps where the scene starts');
});

test('a scene yields a key it shares with an entity, which keeps it', () => {
    const entities = readReply(sceneReply({ keys: ['Drowned Lantern', 'Tamsin'] }), 81).entities;
    const { entries, contested } = compile(entities, messages);
    assert.ok(contested.includes('tamsin'));
    assert.deepEqual(titled(entries, 'Tamsin Dray').key, ['Tamsin']);
    assert.deepEqual(titled(entries, 'Scene: The Drowned Lantern').key, ['Drowned Lantern']);
});

test('the Timeline is one constant entry, a line per scene in order, and keeps its uid', () => {
    const entities = readReply(sceneReply(), 81).entities;
    const first = compile(entities, messages);
    const tl = titled(first.entries, 'Timeline');
    assert.equal(tl.constant, true);
    assert.deepEqual(tl.key, []);
    assert.equal(tl.canonkeeper.kind, 'timeline');
    assert.deepEqual(tl.content.split('\n'), ['1. The Drowned Lantern (Day 1, dusk): Quill hires Tamsin.', '2. The Quay (Day 1, night): Hale lets her go.']);
    assert.equal(first.timeline, tl.uid);
    // Scenes read in the other order still list in story order; the uid stays.
    const again = compile([...entities].reverse(), messages, { timeline: first.timeline, nextUid: first.nextUid });
    assert.equal(titled(again.entries, 'Timeline').uid, first.timeline);
    assert.equal(titled(again.entries, 'Timeline').content, tl.content);
    // No scene entries, no Timeline.
    assert.equal(titled(compile([ent('Saltgate', ['Saltgate'], [0])], messages).entries, 'Timeline'), undefined);
});

test('a hand-edited or deleted Timeline is left alone', () => {
    const entities = readReply(sceneReply(), 81).entities;
    const first = compile(entities, messages);
    const tl = titled(first.entries, 'Timeline');
    const held = compile(entities, messages, { pinned: [{ ...tl, content: 'mine' }], timeline: tl.uid, nextUid: first.nextUid });
    assert.equal(held.entries.filter((e) => e.comment === 'Timeline').length, 1);
    assert.equal(titled(held.entries, 'Timeline').content, 'mine');
    const gone = compile(entities, messages, { deleted: new Set([tl.uid]), timeline: tl.uid, nextUid: first.nextUid });
    assert.equal(titled(gone.entries, 'Timeline'), undefined);
});

// ── profiles ────────────────────────────────────────────────────────────────

test('a profile is laid out whole by section, history in story order, quotes with the voice', () => {
    const e = {
        facts: [
            { text: 'Later she leaves.', section: 'history', messages: [40] },
            { text: 'Wears a long coat.', section: 'appearance', messages: [2] },
            { text: 'Dry and wary.', section: 'personality', messages: [3] },
            { text: 'First she arrives.', section: 'history', messages: [5] },
            { text: 'Trusts Wren.', section: 'relationships', messages: [7] },
        ],
        quotes: [{ text: 'Lovely night for it.', speaker: 'Tamsin' }],
    };
    assert.equal(renderContent(e), 'Appearance: Wears a long coat.\nPersonality and voice: Dry and wary. Said: "Lovely night for it." (Tamsin)\nRelationships: Trusts Wren.\nHistory: First she arrives. Later she leaves.');
    assert.equal(renderContent({ facts: [{ text: 'A.', messages: [1] }, { text: 'B.', messages: [2] }] }), 'A. B.', 'plain facts read as before');
});

test('a main character under 1,000 characters is flagged for review', () => {
    const { review } = compile([ent('Tamsin Dray', ['Tamsin'], [2], { main: true })], messages);
    assert.ok(review.some((r) => r.name === 'Tamsin Dray' && /main character, but its profile is \d+ characters/.test(r.reason)));
});

// ── the whole path ──────────────────────────────────────────────────────────

const built = () => build({ messages, generate: replay(deep), contextTokens: 200000 });
const flat = (book) => Object.values(book.entries).map(normalizeEntry);

test('the recorded deep build passes D17–D19 and the invariants', async () => {
    const first = await built();
    titled(Object.values(first.book.entries), 'Brother Saul').canonkeeper.pinned = true;
    const again = await update({ book: first.book, ledger: first.ledger, messages, generate: async () => assert.fail('no model call'), contextTokens: 200000 });
    const dir = mkdtempSync(join(tmpdir(), 'ck-deep-'));
    writeFileSync(join(dir, 'book.json'), JSON.stringify(first.book));
    writeFileSync(join(dir, 'rerun.json'), JSON.stringify(again.book));
    writeFileSync(join(dir, 'scenes.json'), JSON.stringify(first.scenes));
    const report = runGate({ storyDir: STORY, runDir: dir, deep: true });
    for (const c of report.checks) assert.equal(c.ok, true, `${c.id}: ${JSON.stringify(c.detail)}`);
    assert.equal(report.ok, true);
    assert.equal(again.plan.length, 0);
});

test('D17–D19 each go red on what they guard', async () => {
    const { book } = await built();
    const base = flat(book);
    assert.equal(checkD17Scenes(base, messages, key).ok, true);
    // a scene entry without its verified quotes
    const noQuotes = base.map((e) => (e.kind === 'scene' && e.start === 20 ? { ...e, quotes: [] } : e));
    assert.equal(checkD17Scenes(noQuotes, messages, key).ok, false);
    // a quote that is not in its message
    const invented = base.map((e) => (e.kind === 'scene' ? { ...e, quotes: e.quotes.map((q) => ({ ...q, text: `${q.text} and then some words more` })) } : e));
    assert.equal(checkD17Scenes(invented, messages, key).ok, false);
    // a missing scene entry, and a missing Timeline
    assert.equal(checkD17Scenes(base.filter((e) => !(e.kind === 'scene' && e.start === 30)), messages, key).ok, false);
    assert.equal(checkD17Scenes(base.filter((e) => e.kind !== 'timeline'), messages, key).ok, false);
    // a thin profile, and a profile without quotes
    const thin = base.map((e) => (e.title === 'Tamsin Dray' ? { ...e, content: e.content.slice(0, 600) } : e));
    assert.equal(checkD18MainCharacters(thin, messages, key).ok, false);
    const mute = base.map((e) => (e.title === 'Tamsin Dray' ? { ...e, quotes: e.quotes.slice(0, 1) } : e));
    assert.equal(checkD18MainCharacters(mute, messages, key).ok, false);
    // a redundant key
    assert.equal(checkD19RedundantKeys(base).ok, true);
    const redundant = base.map((e) => (e.title === 'Tamsin Dray' ? { ...e, keys: [...e.keys, 'Tamsin Dray'] } : e));
    assert.equal(checkD19RedundantKeys(redundant).ok, false);
    // nothing to check is never green
    assert.equal(checkD17Scenes(base.filter((e) => e.kind !== 'scene'), messages, key).ok, false);
});

test('an update keeps scene entries, quotes and the Timeline; an edit to a quoted message drops the quote', async () => {
    const first = await built();
    const uid = (b, t) => titled(Object.values(b.entries), t).uid;
    // A message nothing is cited from is edited: the scene is re-read, nothing else changes.
    const quoted = Object.values(first.book.entries).flatMap((e) => (e.canonkeeper.quotes ?? []).map((q) => ({ e, q })));
    assert.ok(quoted.length >= 8, 'the recording carries quotes');
    const target = quoted.find(({ e }) => e.canonkeeper.kind === 'scene');
    const edited = messages.map((m) => (m.id === target.q.message ? { ...m, text: m.text.replace(target.q.text, 'Something else entirely, said plainly.') } : m));
    const calls = [];
    const out = await update({
        book: first.book,
        ledger: first.ledger,
        messages: edited,
        generate: async (req) => (calls.push(req), JSON.stringify({ scenes: [], entities: [] })),
        contextTokens: 200000,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].user, /\[scene starting at message \d+\]/, 'the model is shown the scenes it already has');
    assert.equal(uid(out.book, 'Timeline'), uid(first.book, 'Timeline'));
    const after = titled(Object.values(out.book.entries), target.e.comment);
    assert.ok(!after.content.includes(target.q.text));
    assert.ok((after.canonkeeper.quotes ?? []).every((q) => q.text !== target.q.text));
    // Everything else, scene entries included, is as it was.
    const sceneCount = (b) => Object.values(b.entries).filter((e) => e.canonkeeper.kind === 'scene').length;
    assert.equal(sceneCount(out.book), sceneCount(first.book));
});
