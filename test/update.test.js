// Re-run semantics (build step 2): the ledger, the diff/plan, pins, hand
// edits and content hashes. The model is replaced by canned replies, plus one
// reply recorded from a real model on a real one-scene edit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTranscript } from '../src/transcript.js';
import { build } from '../src/build.js';
import { update, windowsFor } from '../src/update.js';
import { align } from '../src/align.js';
import { plan, apply, heldEntries } from '../src/plan.js';
import { messageHash } from '../src/fingerprint.js';
import { replay } from '../src/models/replay.js';
import { normalizeEntry } from '../harness/load.js';
import { checkE9EditLocality } from '../harness/checks.js';

const STORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'story');
const EDIT = join(STORY, 'edits', 'undercroft');
const messages = parseTranscript(readFileSync(join(STORY, 'transcript.jsonl'), 'utf8'));
const edited = parseTranscript(readFileSync(join(EDIT, 'transcript.jsonl'), 'utf8'));
const recorded = JSON.parse(readFileSync(join(STORY, 'recorded', 'replies.json'), 'utf8'));
const editReplies = JSON.parse(readFileSync(join(EDIT, 'replies.json'), 'utf8'));
const answerKey = JSON.parse(readFileSync(join(STORY, 'answer-key.json'), 'utf8'));
const CONTEXT = 200000;

const titled = (book, name) => Object.values(book.entries).find((e) => e.comment === name);
const flat = (book) => Object.values(book.entries).map(normalizeEntry);
const noModel = async () => assert.fail('no model call expected');

/** A reply that reports exactly these entities and scene starts. */
const reply = (entities, scenes = []) =>
    JSON.stringify({ scenes: scenes.map((start) => ({ start })), entities: entities.map((e) => ({ caseSensitive: false, cascade: true, throttle: 0, ...e })) });

async function built(pins = ['Brother Saul']) {
    const first = await build({ messages, generate: replay(recorded), contextTokens: CONTEXT });
    for (const p of pins) titled(first.book, p).canonkeeper.pinned = true;
    return first;
}

const withText = (msgs, id, text) => msgs.map((m) => (m.id === id ? { ...m, text } : m));

// ── message alignment ───────────────────────────────────────────────────────

test('align: an edited message is fresh and everything else keeps its id', () => {
    const r = align(messages.map(messageHash), withText(messages, 22, 'Changed.'));
    assert.deepEqual(r.fresh, [22]);
    assert.deepEqual(r.dirty, [22]);
    assert.equal(r.toNew[22], null);
    assert.equal(r.toNew[23], 23);
});

test('align: an inserted message shifts later ids without making them fresh', () => {
    const now = [...messages.slice(0, 30), { id: 30, name: 'Narrator', text: 'A gull cries.' }, ...messages.slice(30)].map((m, id) => ({ ...m, id }));
    const r = align(messages.map(messageHash), now);
    assert.deepEqual(r.fresh, [30]);
    assert.equal(r.toNew[30], 31);
    assert.equal(r.toNew[80], 81);
});

test('align: a deleted message dirties the message now in its place', () => {
    const now = messages.filter((m) => m.id !== 25).map((m, id) => ({ ...m, id }));
    const r = align(messages.map(messageHash), now);
    assert.deepEqual(r.fresh, []);
    assert.deepEqual(r.dirty, [25]);
    assert.equal(r.toNew[25], null);
    assert.equal(r.toNew[26], 25);
});

test('align: appended messages are fresh, and dirty the last scene', () => {
    const now = [...messages, { id: 81, name: 'Tamsin', text: 'Onward.' }];
    const r = align(messages.map(messageHash), now);
    assert.deepEqual(r.fresh, [81]);
    assert.deepEqual(windowsFor(r.dirty, [10, 20, 30, 40, 52, 63, 71], now.length), [[71, 81]]);
});

// ── an unchanged story makes zero writes ───────────────────────────────────

test('an unchanged story: zero writes, no model call, ledger revision unchanged', async () => {
    const first = await built();
    const again = await update({ book: first.book, ledger: first.ledger, messages, generate: noModel, contextTokens: CONTEXT });
    assert.equal(again.wrote, false);
    assert.deepEqual(again.plan, []);
    assert.equal(again.calls, 0);
    assert.deepEqual(again.book, first.book);
    assert.equal(again.ledger.revision, first.ledger.revision);
});

test('an unchanged story stays at zero writes with hand edits, user settings and foreign entries in the book', async () => {
    const first = await built();
    titled(first.book, 'Pell').content = 'Rewritten by a human.';
    titled(first.book, 'Wren').order = 7;
    titled(first.book, 'Wren').disable = true;
    first.book.entries['99'] = { uid: 99, key: ['Pell'], comment: 'My own Pell note', content: 'x' };
    const again = await update({ book: first.book, ledger: first.ledger, messages, generate: noModel, contextTokens: CONTEXT });
    assert.deepEqual(again.plan, []);
    assert.deepEqual(again.book, first.book);
    const reasons = Object.fromEntries(again.held.map((h) => [h.title, h.reason]));
    assert.equal(reasons.Pell, 'edited by hand');
    assert.equal(reasons['My own Pell note'], 'not written by Canonkeeper');
    assert.equal(reasons['Brother Saul'], 'pinned');
    assert.equal(reasons.Wren, undefined, 'order and disable are the user\'s settings, not an edit');
});

test('a second run over an update is itself zero writes', async () => {
    const first = await built();
    const once = await update({ book: first.book, ledger: first.ledger, messages: edited, generate: replay(editReplies), contextTokens: CONTEXT });
    const twice = await update({ book: once.book, ledger: once.ledger, messages: edited, generate: noModel, contextTokens: CONTEXT });
    assert.deepEqual(twice.plan, []);
    assert.deepEqual(twice.book, once.book);
});

// ── editing one scene changes only its entities ────────────────────────────

test('a real one-scene edit (recorded reply): only the scene\'s entities change, pins survive, E9 is green', async () => {
    const first = await built(['Brother Saul', 'The Undercroft']);
    const before = structuredClone(first.book);
    const out = await update({ book: first.book, ledger: first.ledger, messages: edited, generate: replay(editReplies), contextTokens: CONTEXT });
    assert.equal(out.calls, 1);
    assert.ok(out.wrote);
    assert.deepEqual(first.book, before, 'the input book is not mutated');

    const e9 = checkE9EditLocality(flat(before), flat(out.book), messages, edited, answerKey.boundaries);
    assert.equal(e9.ok, true, JSON.stringify(e9.detail));
    assert.deepEqual(e9.detail.scene, [20, 29]);

    for (const name of ['Brother Saul', 'The Undercroft']) assert.deepEqual(titled(out.book, name), titled(before, name), name);
    for (const name of ['Pell', 'Mora Quill', 'Oren Hale', 'Kestrel Lighthouse', 'The Harbor Fire']) assert.deepEqual(titled(out.book, name), titled(before, name), name);
    assert.ok(titled(out.book, 'Fennick Rye'), 'the character the edit introduced has an entry');
    assert.equal(titled(out.book, 'Fennick Rye').uid, first.ledger.nextUid, 'a new entity takes the next uid; nobody else moves');

    // The pinned Undercroft is held, but its canon follows the story, ready
    // for when the pin comes off.
    const canon = out.ledger.entities.find((e) => e.name === 'The Undercroft');
    assert.ok(canon.facts.some((f) => /Brine Kings/.test(f.text)));
    assert.equal(out.ledger.revision, first.ledger.revision + 1);
});

test('E9 goes red when an entry outside the scene changes, a pin changes, or nothing changes', async () => {
    const first = await built(['Brother Saul', 'The Undercroft']);
    const out = await update({ book: first.book, ledger: first.ledger, messages: edited, generate: replay(editReplies), contextTokens: CONTEXT });
    const e9 = (after) => checkE9EditLocality(flat(first.book), flat(after), messages, edited, answerKey.boundaries);

    const outside = structuredClone(out.book);
    titled(outside, 'Kestrel Lighthouse').content += ' It is tall.';
    assert.equal(e9(outside).ok, false);
    assert.equal(e9(outside).detail.offenders[0].title, 'Kestrel Lighthouse');

    const pin = structuredClone(out.book);
    titled(pin, 'The Undercroft').content = 'Rewritten.';
    assert.equal(e9(pin).ok, false);

    assert.equal(e9(first.book).ok, false, 'an edit that changes nothing proves nothing');

    const twoScenes = withText(edited, 45, 'Changed too.');
    assert.equal(checkE9EditLocality(flat(first.book), flat(out.book), messages, twoScenes, answerKey.boundaries).ok, false);
});

test('a pinned entry inside the edited scene survives even when the model rewrites its facts', async () => {
    const first = await built(['The Undercroft']);
    const pinned = structuredClone(titled(first.book, 'The Undercroft'));
    const now = withText(messages, 20, messages[20].text.replace('two centuries', 'four centuries'));
    const r = reply([{ name: 'The Undercroft', keys: ['Undercroft'], facts: [{ text: 'Four centuries old.', messages: [20] }] }]);
    const out = await update({ book: first.book, ledger: first.ledger, messages: now, generate: replay([r]), contextTokens: CONTEXT });
    assert.deepEqual(titled(out.book, 'The Undercroft'), pinned);
    assert.ok(!out.plan.some((o) => o.uid === pinned.uid));
});

test('a hand-edited entry is held through an update, and keeps its keys', async () => {
    const first = await built();
    const wren = titled(first.book, 'Wren');
    wren.content = 'My Wren.';
    const held = structuredClone(wren);
    const now = withText(messages, 22, messages[22].text + ' Wren hums.');
    const r = reply([{ name: 'Wren', keys: ['Wren'], facts: [{ text: 'Hums.', messages: [22] }] }]);
    const out = await update({ book: first.book, ledger: first.ledger, messages: now, generate: replay([r]), contextTokens: CONTEXT });
    assert.deepEqual(titled(out.book, 'Wren'), held);
    assert.equal(out.held.find((h) => h.uid === held.uid).reason, 'edited by hand');
});

test('an update rewrites only the owned fields and keeps the user\'s settings', async () => {
    const first = await built();
    const wren = titled(first.book, 'Wren');
    Object.assign(wren, { order: 7, position: 2, disable: true });
    const now = withText(messages, 22, messages[22].text + ' Wren hums.');
    const r = reply([{ name: 'Wren', keys: ['Wren'], facts: [{ text: 'Hums while she walks.', messages: [22] }] }]);
    const out = await update({ book: first.book, ledger: first.ledger, messages: now, generate: replay([r]), contextTokens: CONTEXT });
    const after = titled(out.book, 'Wren');
    assert.match(after.content, /Hums while she walks\./);
    assert.deepEqual([after.order, after.position, after.disable], [7, 2, true]);
    assert.deepEqual(out.plan.find((o) => o.title === 'Wren').fields, ['content', 'canonkeeper']);
});

// ── what the model may change in an update ─────────────────────────────────

test('a restated fact keeps its place and its sources outside the changed message', async () => {
    const first = await built();
    const ines = first.ledger.entities.find((e) => e.name === 'Ines Vell');
    const fact = ines.facts.find((f) => f.messages.includes(26) && f.messages.some((id) => id > 29));
    assert.ok(fact, 'fixture: Ines has a fact citing message 26 and a later scene');
    const now = withText(messages, 26, messages[26].text + ' The ink is still fresh.');
    const r = reply([{ name: 'Ines Vell', keys: ['Ines'], facts: [{ text: fact.text, messages: [26] }] }]);
    const out = await update({ book: first.book, ledger: first.ledger, messages: now, generate: replay([r]), contextTokens: CONTEXT });
    assert.deepEqual(titled(out.book, 'Ines Vell').content, titled(first.book, 'Ines Vell').content);
    assert.deepEqual(out.ledger.entities.find((e) => e.name === 'Ines Vell').facts.find((f) => f.text === fact.text).messages, fact.messages);
});

test('a new fact citing only unchanged messages is left out, and the entry does not grow', async () => {
    const first = await built();
    const now = withText(messages, 22, messages[22].text + ' Fennick Rye waves.');
    const r = reply([
        { name: 'Ines Vell', keys: ['Ines'], facts: [{ text: 'Owns brass dividers.', messages: [22, 23] }, { text: 'Liked sweets.', messages: [24] }] },
        { name: 'Fennick Rye', keys: ['Fennick Rye'], facts: [{ text: 'Waves at Wren.', messages: [22] }] },
    ]);
    const out = await update({ book: first.book, ledger: first.ledger, messages: now, generate: replay([r]), contextTokens: CONTEXT });
    const ines = titled(out.book, 'Ines Vell');
    assert.match(ines.content, /Owns brass dividers\./, 'cites the changed message 22');
    assert.doesNotMatch(ines.content, /Liked sweets/);
    assert.ok(out.ledger.review.some((x) => /cites no changed message/.test(x.reason) && /Liked sweets/.test(x.reason)));
    assert.ok(titled(out.book, 'Fennick Rye'));
});

test('a fact from a changed message the model does not restate is dropped, and said so', async () => {
    const first = await built();
    const saltgate = first.ledger.entities.find((e) => e.name === 'Saltgate');
    const gone = saltgate.facts.find((f) => f.messages.includes(20));
    const now = withText(messages, 20, messages[20].text + ' Bells.');
    const out = await update({ book: first.book, ledger: first.ledger, messages: now, generate: replay([reply([])]), contextTokens: CONTEXT });
    assert.doesNotMatch(titled(out.book, 'Saltgate').content, new RegExp(gone.text.slice(0, 20)));
    assert.ok(out.ledger.review.some((x) => x.name === 'Saltgate' && /not restated/.test(x.reason)));
});

// ── an epithet named later (live mode reads one scene at a time) ───────────

const scene1 = messages.slice(0, 10);
const scenes12 = messages.slice(0, 20);

test('an entity known by an epithet is renamed when a later scene names it, and keeps its uid', async () => {
    const first = await build({
        messages: scene1,
        generate: replay([reply([{ name: 'the Magistrate', keys: ['the Magistrate'], facts: [{ text: 'Has men watching the docks.', messages: [5] }] }])]),
        contextTokens: CONTEXT,
    });
    const uid = titled(first.book, 'the Magistrate').uid;
    const r = reply([{ name: 'Dovrin Kesh', keys: ['Kesh', 'Magistrate Kesh', 'Dovrin Kesh', 'the Magistrate'], facts: [{ text: 'Wants every copy of the charts burned.', messages: [15] }] }]);
    const out = await update({ book: first.book, ledger: first.ledger, messages: scenes12, generate: replay([r]), contextTokens: CONTEXT });
    const kesh = titled(out.book, 'Dovrin Kesh');
    assert.equal(kesh.uid, uid);
    assert.ok(!titled(out.book, 'the Magistrate'));
    assert.ok(kesh.key.includes('the Magistrate') && kesh.key.includes('Kesh'));
    assert.match(kesh.content, /watching the docks/);
    assert.match(kesh.content, /burned/);
    assert.ok(out.ledger.review.some((x) => x.name === 'Dovrin Kesh' && /renamed/.test(x.reason)));
});

test('two known entries the passages show are one are merged into the named one', async () => {
    const first = await build({
        messages: scene1,
        generate: replay([reply([
            { name: 'the Magistrate', keys: ['the Magistrate'], facts: [{ text: 'Has men watching the docks.', messages: [5] }] },
            { name: 'Kesh', keys: ['Kesh'], facts: [{ text: 'Gave Hale his orders.', messages: [9] }] },
        ])]),
        contextTokens: CONTEXT,
    });
    const uid = titled(first.book, 'Kesh').uid;
    const r = reply([{ name: 'Kesh', keys: ['Kesh', 'Magistrate Kesh', 'Dovrin Kesh', 'Magistrate'], facts: [{ text: 'Wants every copy of the charts burned.', messages: [15] }] }]);
    const out = await update({ book: first.book, ledger: first.ledger, messages: scenes12, generate: replay([r]), contextTokens: CONTEXT });
    const kesh = titled(out.book, 'Kesh');
    assert.equal(kesh.uid, uid);
    assert.ok(!titled(out.book, 'the Magistrate'));
    assert.ok(kesh.key.some((k) => /Magistrate/.test(k)));
    assert.match(kesh.content, /watching the docks/);
    assert.ok(out.ledger.review.some((x) => /"the Magistrate" is the same entity/.test(x.reason)));
    // And the next run is zero writes.
    const again = await update({ book: out.book, ledger: out.ledger, messages: scenes12, generate: noModel, contextTokens: CONTEXT });
    assert.equal(again.plan.length, 0);
});

test('a message inserted early moves sources, but no fact is reworded', async () => {
    const first = await built();
    const now = [...messages.slice(0, 12), { id: 12, name: 'Narrator', text: 'Rain.' }, ...messages.slice(12)].map((m, id) => ({ ...m, id }));
    const out = await update({ book: first.book, ledger: first.ledger, messages: now, generate: replay([reply([])]), contextTokens: CONTEXT });
    for (const e of Object.values(first.book.entries)) {
        const after = out.book.entries[String(e.uid)];
        assert.equal(after.content, e.content, e.comment);
        assert.deepEqual(after.key, e.key, e.comment);
    }
    assert.ok(out.plan.every((o) => o.op === 'update' && o.fields.join() === 'canonkeeper'));
    assert.deepEqual(titled(out.book, 'Kestrel Lighthouse').canonkeeper.sources, [[41, 41], [45, 45]]);
});

test('an entity whose only scene is deleted loses its entry, unless a human holds it', async () => {
    const first = await built();
    // Pell is only cited in the first scene: delete it, and the model finds
    // nothing about him in what is left.
    const now = messages.filter((m) => m.id >= 10).map((m, id) => ({ ...m, id }));
    const pell = titled(first.book, 'Pell');
    const out = await update({ book: first.book, ledger: first.ledger, messages: now, generate: replay([reply([])]), contextTokens: CONTEXT });
    assert.ok(out.plan.some((o) => o.op === 'remove' && o.uid === pell.uid));

    pell.canonkeeper.pinned = true;
    const kept = await update({ book: first.book, ledger: first.ledger, messages: now, generate: replay([reply([])]), contextTokens: CONTEXT });
    assert.deepEqual(kept.book.entries[String(pell.uid)], pell);
});

test('a retired uid is never handed out again', async () => {
    const first = await built();
    const now = messages.filter((m) => m.id >= 10).map((m, id) => ({ ...m, id }));
    const gone = await update({ book: first.book, ledger: first.ledger, messages: now, generate: replay([reply([])]), contextTokens: CONTEXT });
    const retired = gone.plan.filter((o) => o.op === 'remove').map((o) => o.uid);
    assert.ok(retired.length);
    const more = [...now, { id: now.length, name: 'Narrator', text: 'Gilda Marr boards the Gull.' }];
    const r = reply([{ name: 'Gilda Marr', keys: ['Gilda Marr'], facts: [{ text: 'Boards the Gull.', messages: [now.length] }] }]);
    const out = await update({ book: gone.book, ledger: gone.ledger, messages: more, generate: replay([r]), contextTokens: CONTEXT });
    const gilda = titled(out.book, 'Gilda Marr');
    assert.ok(gilda && !retired.includes(gilda.uid) && gilda.uid >= first.ledger.nextUid);
});

test('a ledger from an older version rebuilds once, keeping uids by title and holding pins', async () => {
    const first = await built();
    const old = { ...first.ledger, version: 1 };
    const out = await update({ book: first.book, ledger: old, messages, generate: replay(recorded), contextTokens: CONTEXT });
    assert.equal(out.calls, 1);
    assert.deepEqual(out.plan, []);
    assert.equal(out.ledger.version, 2);
    for (const e of Object.values(first.book.entries)) assert.equal(titled(out.book, e.comment).uid, e.uid);
});

// ── the plan itself ────────────────────────────────────────────────────────

test('plan and apply: add, update, remove, and nothing else', async () => {
    const first = await built();
    const entries = Object.values(structuredClone(first.book.entries));
    const pell = entries.find((e) => e.comment === 'Pell');
    pell.content = 'Changed.';
    const removed = entries.pop();
    entries.push({ ...structuredClone(removed), uid: 500, comment: 'New' });
    const ops = plan(first.book, entries);
    assert.deepEqual(ops.map((o) => [o.op, o.uid]), [['update', pell.uid], ['remove', removed.uid], ['add', 500]]);
    assert.deepEqual(ops[0].fields, ['content']);
    const next = apply(first.book, ops);
    assert.equal(next.entries[String(pell.uid)].content, 'Changed.');
    assert.equal(next.entries[String(removed.uid)], undefined);
    assert.equal(next.entries['500'].comment, 'New');
    assert.deepEqual(plan(next, entries), []);
});

test('held entries: pinned, hand-edited, foreign; unpinning does not count as an edit', async () => {
    const first = await built([]);
    const book = structuredClone(first.book);
    titled(book, 'Pell').canonkeeper.pinned = true;
    titled(book, 'Pell').canonkeeper.pinned = false;
    assert.deepEqual(heldEntries(book, first.ledger.written), []);
    titled(book, 'Wren').key.push('the runner');
    assert.deepEqual(heldEntries(book, first.ledger.written).map((h) => [h.entry.comment, h.reason]), [['Wren', 'edited by hand']]);
});
