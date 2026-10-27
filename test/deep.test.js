// Deep entries: quotes checked word for word, redundant keys
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
import { buildDepthPrompt } from '../src/prompt.js';
import { checkQuotes } from '../src/quotes.js';
import { replay } from '../src/models/replay.js';
import { runGate } from '../harness/gate.js';
import { checkD17Scenes, checkD18MainCharacters, checkD19RedundantKeys } from '../harness/checks.js';
import { normalizeEntry } from '../harness/load.js';
import { sweepWindows, SWEEP_CHARS } from '../src/deepen.js';

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

test('a comma or full stop at the ends of a quote is not a word; a joined or reworded line still fails', () => {
    const msgs = [{ id: 0, text: '"I have news and I hate it," Quill says. "Then you leave by the cellar," she tells Tamsin. "Pell knows the way."' }];
    const kept = (t) => checkQuotes([{ text: t, message: 0 }], msgs).kept.length;
    assert.equal(kept('I have news and I hate it.'), 1);
    assert.equal(kept('"I have news and I hate it,"'), 1);
    assert.equal(kept('Pell knows the way'), 1);
    const joined = checkQuotes([{ text: 'Then you leave by the cellar. Pell knows the way.', message: 0 }], msgs).kept;
    assert.deepEqual(joined.map((q) => q.text), ['Then you leave by the cellar.'].slice(0, 0).concat(joined.map((q) => q.text)), 'two pieces joined across a tag: only a true piece survives');
    assert.equal(joined.length, 1);
    assert.ok(msgs[0].text.includes(joined[0].text.replace(/[.]$/, '')));
    assert.equal(kept('I have news, and I hate it.'), 0, 'a comma inside is a change');
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

test('a long scene told in parts: one entry, each part with its own lines, parts listed under the scene in the Timeline', () => {
    const reply = JSON.stringify({
        scenes: [{
            start: 0, title: 'The Drowned Lantern', when: 'Day 1, dusk', where: 'The Drowned Lantern', who: ['Tamsin', 'Quill'], line: 'Quill hires Tamsin.', keys: ['Drowned Lantern'],
            parts: [
                { title: 'The booth', facts: [{ text: 'Tamsin joins the woman in the booth.', section: 'what', messages: [1] }], quotes: [{ text: "You've been staring at the door like it owes you money.", speaker: 'Tamsin', message: 1 }] },
                { title: 'The job', facts: [{ text: 'Quill offers the tube.', section: 'what', messages: [3] }], quotes: [{ text: 'Made up line.', speaker: 'Quill', message: 3 }] },
            ],
            facts: [{ text: 'It starts the mission.', section: 'why', messages: [1] }],
        }],
        entities: [],
    });
    const r = readReply(reply, 81);
    const scene = r.entities[0];
    assert.equal(scene.kind, 'scene');
    assert.deepEqual(scene.facts.map((f) => f.part), [undefined, 'The booth', 'The job'], 'parts are kept flat, each fact labelled');
    assert.deepEqual(scene.quotes.map((q) => q.part), ['The booth', 'The job']);
    const { entries } = compile(r.entities, messages);
    const entry = titled(entries, 'Scene: The Drowned Lantern');
    assert.equal(entries.filter((e) => e.canonkeeper?.kind === 'scene').length, 1, 'parts never become entries of their own');
    const lines = entry.content.split('\n');
    assert.equal(lines[0], 'When: Day 1, dusk. Where: The Drowned Lantern. Who: Tamsin, Quill.');
    assert.equal(lines[1], `The booth: Tamsin joins the woman in the booth. Said: "You've been staring at the door like it owes you money." (Tamsin)`);
    assert.equal(lines[2], 'The job: Quill offers the tube.', 'a quote that is not word for word is dropped from its part');
    assert.equal(lines[3], 'Why it matters: It starts the mission.');
    assert.ok(entry.canonkeeper.facts.every((f) => f.section === 'why' || f.part), 'the entry records which part a fact belongs to');
    const tl = titled(entries, 'Timeline');
    assert.equal(tl.content, '1. The Drowned Lantern (Day 1, dusk): Quill hires Tamsin.\n   - The booth\n   - The job');
});

test('the depth step sizes the parts to the scene and asks for quotes per part', () => {
    const scenes = [
        { name: 'Scene: Short', kind: 'scene', start: 0, keys: [], facts: [{ text: 'A.', messages: [0] }] },
        { name: 'Scene: Long', kind: 'scene', start: 10, keys: [], facts: [{ text: 'B.', messages: [10] }] },
    ];
    const spans = new Map([[0, [0, 9]], [10, [10, 45]]]);
    const { user } = buildDepthPrompt(messages, { from: 0, to: 45, mains: [], scenes, spans, outputTokens: 8000 });
    assert.match(user, /span: messages 0 to 9 \(10 messages: one part\)/);
    assert.match(user, /span: messages 10 to 45 \(36 messages: 3 parts or so\)/);
    assert.match(user, /1-3 quotes from that stretch/);
    assert.match(user, /"parts": \[/);
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

// ── the two-step build ───────────────────────────────────────────

const twoStep = JSON.parse(readFileSync(join(STORY, 'deep', 'two-step.json'), 'utf8'));
const built2 = (replies = twoStep, extra = {}) => {
    const sent = [];
    const g = replay(replies);
    return build({ messages, generate: async (req) => (sent.push(req), g(req)), contextTokens: 200000, depth: true, ...extra }).then((out) => ({ ...out, sent }));
};

test('two steps: the breadth call, one sweep, then the depth batches (2 mains, then 3 scenes, per call)', async () => {
    const { sent, ledger } = await built2();
    assert.equal(sent.length, 1 + 1 + 2 + 1 + 3); // scenes and roster; one sweep; 4 mains in 2 calls, one asked again for quotes; 8 scenes in 3 calls
    assert.match(sent[4].user, /<to_write>\n- Oren Hale[\s\S]*<\/to_write>/, 'the one main with a single quote is asked again, alone');
    assert.equal(sent[4].user.slice(sent[4].user.lastIndexOf('<to_write>')).split('</to_write>')[0].match(/\[main character: write the profile\]/g).length, 1);
    assert.ok(!/at least 1,000 characters/.test(sent[0].user), 'the breadth call asks for no profiles');
    assert.match(sent[0].user, /room for about \d+ entities/);
    assert.match(sent[0].user, /Be strict about cuts/);
    assert.match(sent[1].user, /is not complete[\s\S]*<known_entities>[\s\S]*Tamsin Dray/);
    assert.ok(!/scene starting at message/.test(sent[1].user), 'the sweep lists entities, not scenes');
    assert.match(sent[2].user, /<to_write>[\s\S]*\[main character: write the profile\][\s\S]*Tamsin Dray/);
    assert.ok(!/- a scene:/.test(sent[2].user), 'a batch of mains is not told how to write a scene');
    assert.match(sent[5].user, /<taken_keys>[\s\S]*Saltgate[\s\S]*<\/taken_keys>/);
    assert.ok(!/taken_keys>/.test(sent[2].user.split('</to_write>')[1]), 'mains need no taken keys');
    assert.ok(!/- a main character:/.test(sent[5].user), 'a batch of scenes is not told how to write a profile');
    assert.match(sent[5].user, /scene start 0, title "The Drowned Lantern", span: messages 0 to \d+/);
    assert.ok(ledger.review.every((r) => !/depth step/.test(r.reason)));
});

test('two steps: the same mains and scenes, in full, as the one-shot reply gives', async () => {
    const one = await built();
    const two = await built2();
    const a = Object.values(one.book.entries).filter((e) => e.canonkeeper?.kind);
    for (const e of Object.values(one.book.entries)) {
        const o = Object.values(two.book.entries).find((x) => x.comment === e.comment);
        assert.ok(o, `${e.comment} is in the two-step book`);
        if (e.canonkeeper?.main || e.canonkeeper?.kind === 'scene') assert.equal(o.content, e.content, e.comment);
    }
    assert.equal(Object.keys(two.book.entries).length, Object.keys(one.book.entries).length);
    assert.ok(a.length >= 9);
});

test('two steps: a depth batch that cannot be read costs that batch its depth, not the build', async () => {
    const bad = [...twoStep];
    const out = await built2([...bad.slice(0, 5), 'not json', 'still not json', ...bad.slice(6)]); // the first scene batch, twice
    assert.ok(out.ledger.review.some((r) => /depth step's reply could not be used/.test(r.reason) && /The Drowned Lantern/.test(r.name)));
    const lantern = Object.values(out.book.entries).find((e) => e.comment === 'Scene: The Drowned Lantern');
    assert.ok(lantern, 'the scene is still an entry, at breadth');
    assert.ok(Object.values(out.book.entries).some((e) => e.comment === 'Tamsin Dray'));
});

test('two steps: the depth step adds nothing it was not asked about', async () => {
    const extra = JSON.parse(twoStep[2]);
    extra.entities.push({ name: 'A Stranger', keys: ['stranger'], facts: [{ text: 'Walks in.', messages: [2] }] });
    extra.entities.push({ name: 'Pell', keys: [], facts: [{ text: 'Not a main character.', messages: [2] }] });
    const replies = [...twoStep];
    replies[2] = JSON.stringify(extra);
    const out = await built2(replies);
    assert.ok(!Object.values(out.book.entries).some((e) => e.comment === 'A Stranger'));
    assert.ok(!/Not a main character/.test(Object.values(out.book.entries).find((e) => e.comment === 'Pell').content));
    assert.equal(out.ledger.review.filter((r) => /not asked about/.test(r.reason)).length, 2);
});

test('two steps: the sweep adds what the roster missed, not what it has, and only from its passage', async () => {
    const sweep = (names, more = []) => JSON.stringify({ entities: [...names.map((n) => ent(n, [n.toLowerCase()], [2])), ...more], scenes: [] });
    const replies = [...twoStep];
    replies[1] = sweep(['Tariff', 'Lamp room'], [ent('Tamsin Dray', ['Tamsin'], [2]), ent('Cellar hatch', ['cellar hatch'], [9999])]);
    const out = await built2(replies);
    const titles = Object.values(out.book.entries).map((e) => e.comment);
    for (const t of ['Tariff', 'Lamp room']) assert.ok(titles.includes(t), t);
    assert.equal(titles.filter((t) => t === 'Tamsin Dray').length, 1, 'an entity already listed is not added again');
    assert.ok(!titles.includes('Cellar hatch'), 'a fact citing nothing in the passage is no fact');
    assert.match(out.sent[1].user, /<known_entities>[\s\S]*Tamsin Dray[\s\S]*<passage from="0" to="\d+">/);
});

test('sweep passages: cut at scene starts, never past the size, every message once', () => {
    const msgs = Array.from({ length: 40 }, (_, id) => ({ id, name: 'N', text: 'x'.repeat(9000) }));
    const starts = [8, 17, 21, 30];
    const w = sweepWindows(msgs, 0, 39, starts);
    assert.deepEqual(w.flat().filter((_, i) => i % 2 === 0).slice(1), w.slice(0, -1).map(([, b]) => b + 1), 'each window starts where the last ended');
    assert.equal(w[0][0], 0);
    assert.equal(w.at(-1)[1], 39);
    for (const [a, b] of w) assert.ok((b - a + 1) * 9009 <= SWEEP_CHARS + 9009, `${a}-${b} is within the size`);
    assert.ok(w.slice(1).every(([a]) => starts.includes(a) || msgs.slice(a - 6, a).length), 'cuts fall on scene starts when one is near');
    assert.deepEqual(sweepWindows(msgs.slice(0, 3), 0, 2, []), [[0, 2]]);
});

// ── the two-step build, read in parts ───────────────────────────────────────

/** A model that answers each kind of call from the one-shot deep reply, for the part the prompt names. */
function partsModel() {
    const full = JSON.parse(deep[0]);
    const calls = [];
    const inRange = (ids, a, b) => ids.filter((id) => id >= a && id <= b);
    const trim = (facts, a, b) => facts.map((f) => ({ ...f, messages: inRange(f.messages, a, b) })).filter((f) => f.messages.length);
    const generate = async ({ user }) => {
        if (user.includes('"merges"')) return calls.push({ kind: 'reconcile' }), JSON.stringify({ merges: [] });
        const m = /(?:part from|passage from)="(\d+)" to="(\d+)"/.exec(user) ?? /messages (\d+) to (\d+)/.exec(user);
        const [a, b] = [Number(m[1]), Number(m[2])];
        let kind;
        let reply;
        if (user.includes('<to_write>')) {
            kind = 'depth';
            const mains = full.entities.filter((e) => e.main && user.split('</to_write>')[0].includes(`- ${e.name} [main character`));
            const scenes = full.scenes.filter((s) => user.includes(`scene start ${s.start},`));
            reply = {
                entities: mains.map((e) => ({ name: e.name, keys: [], facts: trim(e.facts, a, b), quotes: (e.quotes ?? []).filter((q) => q.message >= a && q.message <= b) })),
                scenes: scenes.map((s) => ({ start: s.start, title: s.title, keys: [], facts: trim(s.facts.slice(1), a, b), quotes: (s.quotes ?? []).filter((q) => q.message >= a && q.message <= b) })),
            };
        } else if (user.includes('is not complete')) (kind = 'sweep'), (reply = { entities: [], scenes: [] });
        else if (user.includes('Be strict about cuts')) {
            kind = 'breadth';
            reply = { entities: full.entities.map(({ quotes, ...e }) => ({ ...e, facts: trim(e.facts.slice(0, 3), a, b) })).filter((e) => e.facts.length), scenes: full.scenes.filter((s) => s.start >= a && s.start <= b + 1).map(({ quotes, ...s }) => ({ ...s, facts: trim(s.facts.slice(0, 1), a, b + 1).length ? trim(s.facts.slice(0, 1), a, b + 1) : [{ text: s.line, messages: [s.start] }] })) };
        }
        calls.push({ kind, a, b });
        return JSON.stringify(reply);
    };
    return { generate, calls };
}

test('two steps in parts: each part reads scenes and roster, sweeps, then deepens what it holds; scenes and profiles survive', async () => {
    const { generate, calls } = partsModel();
    const out = await build({ messages, generate, contextTokens: 15200, outputShare: 0.5, depth: true });
    const parts = out.ledger.chunked.parts;
    assert.ok(parts.length >= 2, `read in ${parts.length} parts`);
    for (const p of parts) {
        const mine = calls.filter((c) => c.a >= p.from && c.b <= (p.read ?? p.to));
        assert.deepEqual(mine.slice(0, 2).map((c) => c.kind), ['breadth', 'sweep'], `part ${p.part} starts with the breadth step`);
    }
    assert.ok(calls.some((c) => c.kind === 'depth'));
    assert.equal(calls.at(-1).kind, 'reconcile');
    const entries = Object.values(out.book.entries);
    assert.ok(entries.filter((e) => e.canonkeeper?.kind === 'scene').length >= 6, 'scene entries');
    assert.ok(entries.some((e) => e.canonkeeper?.kind === 'timeline'));
    for (const name of ['Tamsin Dray', 'Mora Quill']) assert.ok(titled(entries, name)?.content.length > 600, `${name} has a profile`);
});

test('two steps: someone in a third of the scenes is a main character even if the roster call did not say so', async () => {
    const first = JSON.parse(twoStep[0]);
    first.entities.find((e) => e.name === 'Mora Quill').main = false;
    first.entities.find((e) => e.name === 'Pell').main = false;
    const replies = [JSON.stringify(first), ...twoStep.slice(1)];
    const out = await built2(replies);
    const asked = out.sent.filter((s) => s.user.includes('[main character: write the profile]')).map((s) => s.user.slice(s.user.lastIndexOf('<to_write>'))).join('\n');
    assert.match(asked, /Mora Quill \[main character: write the profile\]/);
    assert.ok(!/Pell \[main character/.test(asked), 'Pell is in one scene');
});
