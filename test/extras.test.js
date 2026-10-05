// Build step 7, the optional extras: recall (a few more relevant entries
// each turn) and clips (a highlighted passage becomes an entry). The rule
// for both is that they never interfere with the story: when one fails, the
// prompt the roleplay model gets is exactly what it would be without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { recall, openScene, WINDOW } from '../src/recall.js';
import { clip, clipKeys, ClipError, MAX_PASSAGE } from '../src/clip.js';
import { ModelOutputError } from '../src/parse.js';
import { update } from '../src/update.js';
import { audit } from '../src/audit.js';
import { heldEntries } from '../src/plan.js';
import { entryKeyRegex } from '../src/match.js';
import { parseTranscript } from '../src/transcript.js';
import { replay } from '../src/models/replay.js';
import { runCanon, runClip, recallInputs, recallSession, toMessages, STATE_KEY } from '../adapter/run.js';
import { checkX15Recall, checkX16Clip } from '../harness/checks.js';

const STORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'story');
const text = readFileSync(join(STORY, 'transcript.jsonl'), 'utf8');
const messages = parseTranscript(text);
const chat = text.split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l));
const reference = JSON.parse(readFileSync(join(STORY, 'reference', 'book.json'), 'utf8'));
const starts = JSON.parse(readFileSync(join(STORY, 'reference', 'scenes.json'), 'utf8')).boundaries;
const recorded = JSON.parse(readFileSync(join(STORY, 'recorded', 'replies.json'), 'utf8'));

const entries = Object.values(reference.entries);
const fires = (e, ms) => ms.filter((m) => e.key.some((k) => entryKeyRegex(k, e).test(m.text))).map((m) => m.id);

// --- Recall -----------------------------------------------------------------------

test('the open scene runs from the last scene start, capped at the window', () => {
    assert.deepEqual(openScene(starts, 50), [40, 49]);
    assert.deepEqual(openScene(starts, 81), [71, 80]);
    assert.deepEqual(openScene([], 81), [81 - WINDOW, 80]);
    assert.deepEqual(openScene([], 5), [0, 4]);
});

test('recall picks entries the open scene names that the scan depth no longer reaches', () => {
    const upTo49 = messages.slice(0, 50);
    const out = recall({ entries, messages: upTo49, starts, maxEntries: 3, budgetTokens: 600, scanDepth: 2 });
    assert.deepEqual(out.scene, [40, 49]);
    assert.ok(out.picks.length > 0 && out.picks.length <= 3);
    const scanned = upTo49.slice(-2);
    for (const p of out.picks) {
        const e = reference.entries[p.uid];
        assert.deepEqual(fires(e, scanned), [], `'${e.comment}' fires in the scan window: SillyTavern activates it anyway`);
        assert.ok(p.last >= 40 && p.last <= 49, `'${e.comment}' is about the open scene`);
    }
    for (let i = 1; i < out.picks.length; i++) assert.ok(out.picks[i - 1].last >= out.picks[i].last, 'most recent first');
    // Brother Saul and Kesh are named in the last two messages: SillyTavern has them.
    assert.ok(!out.picks.some((p) => ['Brother Saul', 'Dovrin Kesh'].includes(p.title)));
    // Nothing from another scene: the Drowned Lantern is only in scene 0-9.
    assert.ok(!out.picks.some((p) => p.title === 'The Drowned Lantern'));
});

test('recall stays within its entry count and its token budget', () => {
    const upTo49 = messages.slice(0, 50);
    const all = recall({ entries, messages: upTo49, starts, maxEntries: 50, budgetTokens: 100000 });
    assert.ok(all.picks.length >= 4, 'the scene has several candidates');
    const one = recall({ entries, messages: upTo49, starts, maxEntries: 1, budgetTokens: 100000 });
    assert.equal(one.picks.length, 1);
    assert.deepEqual(one.picks[0], all.picks[0]);
    const smallest = Math.min(...all.picks.map((p) => p.tokens));
    const tight = recall({ entries, messages: upTo49, starts, maxEntries: 50, budgetTokens: smallest });
    assert.ok(tight.picks.length >= 1);
    assert.ok(tight.picks.reduce((n, p) => n + p.tokens, 0) <= smallest);
    assert.deepEqual(recall({ entries, messages: upTo49, starts, budgetTokens: smallest - 1 }).picks, []);
});

test('recall skips disabled, constant and keyless entries, and an empty chat', () => {
    const upTo49 = messages.slice(0, 50);
    const base = recall({ entries, messages: upTo49, starts, maxEntries: 50, budgetTokens: 100000 }).picks.map((p) => p.uid);
    const changed = entries.map((e) => (e.uid === base[0] ? { ...e, disable: true } : e.uid === base[1] ? { ...e, constant: true } : e.uid === base[2] ? { ...e, key: [] } : e));
    const picks = recall({ entries: changed, messages: upTo49, starts, maxEntries: 50, budgetTokens: 100000 }).picks.map((p) => p.uid);
    assert.deepEqual(picks, base.slice(3));
    assert.deepEqual(recall({ entries, messages: [], starts }).picks, []);
});

// --- Recall across a generation (adapter/run.js recallSession) -----------------

const metaFor = () => ({ world_info: 'Book', [STATE_KEY]: { book: 'Book', ledger: { scenes: starts } } });

/**
 * A generation as SillyTavern runs it, as far as recall sees it: the
 * interceptor, then World Info's scan (keyword activation in the scan window,
 * plus `recursive`, entries another entry's text brings in), then the prompt,
 * then the end. Returns the prompt: World Info, then recall's block.
 */
async function generate(session, page, { recursive = [], type = 'normal' } = {}) {
    await session.intercept(type);
    const scanned = toMessages(page.chat.filter((m) => typeof m.mes === 'string')).slice(-2);
    const wi = entries.filter((e) => fires(e, scanned).length || recursive.includes(e.uid));
    session.activated(wi.map((e) => ({ ...e, world: 'Book' })));
    const prompt = { worldInfo: wi.map((e) => e.content).join('\n'), recall: page.block };
    session.end();
    assert.equal(page.block, '', 'the block never outlives its generation');
    return prompt;
}

function fakeSession() {
    const page = {
        block: '',
        settings: { recall: true, recallEntries: 3, recallTokens: 600 },
        chat: chat.slice(0, 50),
        metadata: metaFor(),
        loadBook: async () => structuredClone(reference),
        logs: [],
    };
    const session = recallSession({
        settings: () => page.settings,
        inputs: () => recallInputs({ chat: page.chat, metadata: page.metadata, loadBook: () => page.loadBook(), settings: page.settings, scanDepth: 2 }),
        setPrompt: (text) => (page.block = text),
        log: (line) => page.logs.push(line),
        timeoutMs: 200,
    });
    return { page, session };
}

test('recall adds one block of entries World Info left out, and nothing else', async () => {
    const { page, session } = fakeSession();
    const prompt = await generate(session, page);
    assert.ok(session.last.ok && session.last.picks.length > 0 && session.last.picks.length <= 3);
    const picked = session.last.picks.map((p) => reference.entries[p.uid]);
    assert.equal(prompt.recall, picked.map((e) => e.content.trim()).join('\n'));
    for (const e of picked) assert.ok(!prompt.worldInfo.includes(e.content), `'${e.comment}' is not in World Info already`);
    page.settings.recall = false;
    const off = await generate(session, page);
    assert.deepEqual(off, { worldInfo: prompt.worldInfo, recall: '' }, 'World Info is the same with recall on and off');
});

test('an entry World Info brings in by recursion is not added again', async () => {
    const { page, session } = fakeSession();
    await generate(session, page);
    const first = session.last.picks.map((p) => p.uid);
    const prompt = await generate(session, page, { recursive: [first[0]] });
    const now = session.last.picks.map((p) => p.uid);
    assert.ok(!now.includes(first[0]));
    assert.ok(prompt.worldInfo.includes(reference.entries[first[0]].content));
    assert.ok(!prompt.recall.includes(reference.entries[first[0]].content));
    assert.equal(session.last.inPrompt >= 1, true);
});

test('recall off, or a quiet generation: no block', async () => {
    const { page, session } = fakeSession();
    page.settings.recall = false;
    assert.equal((await generate(session, page)).recall, '');
    page.settings.recall = true;
    assert.equal((await generate(session, page, { type: 'quiet' })).recall, '');
});

test('broken recall leaves the prompt exactly as recall off would', async () => {
    const off = fakeSession();
    off.page.settings.recall = false;
    const baseline = await generate(off.session, off.page);

    const breaks = {
        'a corrupt state store': (p) => (p.metadata[STATE_KEY].live = { starts: 7 }),
        'the book failing to load': (p) => (p.loadBook = async () => {
            throw new Error('disk on fire');
        }),
        'a book that answers too late': (p) => (p.loadBook = () => new Promise((r) => setTimeout(() => r(structuredClone(reference)), 400))),
    };
    for (const [what, breakIt] of Object.entries(breaks)) {
        const { page, session } = fakeSession();
        breakIt(page);
        const prompt = await generate(session, page);
        assert.deepEqual(prompt, baseline, `${what}: same prompt as recall off`);
        assert.equal(session.last.ok, false, what);
        await new Promise((r) => setTimeout(r, what.includes('late') ? 300 : 0));
        assert.equal(page.block, '', `${what}: nothing written after the fact`);
    }

    // A message with no text: toMessages throws, so recall does nothing.
    const { page, session } = fakeSession();
    page.chat = [...page.chat.slice(0, -1), { name: 'x', is_user: false }];
    const prompt = await generate(session, page);
    assert.equal(prompt.recall, '');
    assert.equal(session.last.ok, false);

    // World Info's report is unreadable: the block it had is taken back.
    const late = fakeSession();
    await late.session.intercept('normal');
    assert.notEqual(late.page.block, '');
    late.session.activated(42);
    assert.equal(late.page.block, '');
    assert.equal(late.session.last.ok, false);
    late.session.end();
});

test('a chat with no lorebook bound: recall adds nothing and does not fail', async () => {
    const { page, session } = fakeSession();
    page.metadata = {};
    assert.equal((await generate(session, page)).recall, '');
    assert.equal(session.last.ok, true);
});

// --- Clips ------------------------------------------------------------------------

const BARGAIN = '"A letter to the Lamplighters\' Guild in exchange for hiding the Saltwind Chart." Tamsin holds out her hand. "Done. Call it the Lighthouse Bargain."';
const reply = (o) => JSON.stringify(o);
const good = reply({ title: 'Terms of the bargain', blurb: 'Tamsin agrees to carry Brother Saul\'s letter to the Lamplighters\' Guild in exchange for his hiding the Saltwind Chart.', keys: ['a letter', 'Lighthouse Bargain', 'hiding the Saltwind Chart', 'she', 'Captain'] });

function bookWithoutBargain() {
    const book = structuredClone(reference);
    delete book.entries['14'];
    return book;
}

test('a clip becomes an entry: blurb, the passage, keys that are free and in the chat', async () => {
    const calls = [];
    const generate = async (req) => (calls.push(req), good);
    const { entry, dropped } = await clip({ book: reference, messages, at: 47, text: BARGAIN, generate });
    assert.equal(calls.length, 1);
    assert.match(calls[0].user, /<passage>\n"A letter to the Lamplighters/);
    assert.match(calls[0].user, /#46 /, 'the scene before the passage is context');
    assert.equal(entry.comment, 'Clip: Terms of the bargain');
    assert.deepEqual(entry.key, ['a letter', 'hiding the Saltwind Chart']);
    assert.deepEqual(dropped.map((d) => [d.key, d.reason.split(' ').slice(0, 2).join(' ')]), [['Lighthouse Bargain', 'already a'], ['she', 'a pronoun'], ['Captain', 'a bare']]);
    assert.ok(entry.content.startsWith('Tamsin agrees') && entry.content.includes(BARGAIN));
    assert.deepEqual(entry.canonkeeper.sources, [[47, 47]]);
    assert.deepEqual(entry.canonkeeper.facts, [{ text: 'Tamsin agrees to carry Brother Saul\'s letter to the Lamplighters\' Guild in exchange for his hiding the Saltwind Chart.', sources: [[47, 47]] }]);
    assert.deepEqual(entry.canonkeeper.clip, { at: 47, passage: BARGAIN });
    assert.equal(entry.preventRecursion, true);
    assert.ok(!(String(entry.uid) in reference.entries));
});

test('a selection as the page renders it (no markdown, other spacing) still matches its message', async () => {
    const at = messages.findIndex((m) => m.text.includes('*'));
    const msg = at >= 0 ? messages[at] : { ...messages[47], text: messages[47].text.replace('Done.', '*Done.*') };
    const ms = at >= 0 ? messages : messages.map((m) => (m.id === 47 ? msg : m));
    const rendered = msg.text.replace(/[*_]/g, '').replace(/\s+/g, '  ').slice(0, 120);
    const out = await clip({ book: reference, messages: ms, at: msg.id, text: rendered, generate: async () => good });
    assert.ok(out.entry);
});

test('a clip is refused, with no model call, when there is nothing to clip', async () => {
    const generate = async () => assert.fail('no model call');
    await assert.rejects(clip({ book: reference, messages, at: 99, text: 'x', generate }), ClipError);
    await assert.rejects(clip({ book: reference, messages, at: 47, text: 'words from another message entirely', generate }), /isn't in message 47/);
    await assert.rejects(clip({ book: reference, messages, at: 47, text: 'x'.repeat(MAX_PASSAGE + 1), generate }), /at most/);
});

test('a clip with no usable key is refused; a bad reply gets one retry, then fails', async () => {
    const taken = reply({ title: 'T', blurb: 'B.', keys: ['Tamsin', 'Saltwind Chart', 'nowhere in the story'] });
    await assert.rejects(clip({ book: reference, messages, at: 47, text: BARGAIN, generate: async () => taken }), /no usable key.*"Tamsin" \(already a key of 'Tamsin Dray'\)/);
    let n = 0;
    await assert.rejects(clip({ book: reference, messages, at: 47, text: BARGAIN, generate: async () => (n++, 'The narrator continues the story.') }), ModelOutputError);
    assert.equal(n, 2);
    n = 0;
    const out = await clip({ book: reference, messages, at: 47, text: BARGAIN, generate: async () => (n++ ? good : '{"title": 3}') });
    assert.equal(n, 2);
    assert.ok(out.entry);
});

test('clip keys: another book\'s keys are taken too, and an overbroad key is dropped', () => {
    const held = new Map([['the chart', "'Old Map' in 'Character book'"]]);
    const { keys, dropped } = clipKeys(['the chart', 'Tamsin', 'the', 'Saltgate'], messages, held);
    assert.deepEqual(keys, ['Tamsin', 'Saltgate']);
    assert.deepEqual(dropped.map((d) => d.key), ['the chart', 'the']);
});

test('a clip never reuses a uid the ledger gave out, even one deleted since', async () => {
    const ledger = { written: { 30: 'h' }, deleted: { 31: 'Gone' }, entities: [{ uid: 32 }], nextUid: 20 };
    const { entry } = await clip({ book: reference, ledger, messages, at: 47, text: BARGAIN, generate: async () => good });
    assert.equal(entry.uid, 33);
});

// --- Clips through the adapter, and through later /canon runs -------------------

function fakeST(generate) {
    const st = {
        chatId: 'Saltwind',
        chat: structuredClone(chat),
        metadata: {},
        books: {},
        writes: 0,
        currentChatId: () => 'Saltwind',
        bookExists: async (name) => name in st.books,
        loadBook: async (name) => structuredClone(st.books[name] ?? { entries: {} }),
        saveBook: async (name, data) => {
            st.writes++;
            st.books[name] = structuredClone(data);
        },
        createBook: async (name) => {
            st.books[name] = { entries: {} };
        },
        saveMetadata: async () => {},
        generate,
        settings: { contextTokens: 200000, maxOutputTokens: 64000 },
        profile: { id: 'p', name: 'test' },
    };
    return st;
}

test('a failed clip writes nothing to the book and says why in the record', async () => {
    const st = fakeST(replay(recorded));
    const { bookName } = await runCanon(st);
    const before = JSON.stringify(st.books[bookName]);
    const writes = st.writes;
    st.generate = async () => 'Saul smiles and the lamp turns.';
    await assert.rejects(runClip(st, { at: 47, text: BARGAIN }), ModelOutputError);
    assert.equal(st.writes, writes);
    assert.equal(JSON.stringify(st.books[bookName]), before);
    const record = st.metadata[STATE_KEY].clips.at(-1);
    assert.equal(record.ok, false);
    assert.match(record.error, /JSON/);
    assert.ok(st.metadata[STATE_KEY].ledger, 'the ledger is kept');
});

test('a clip adds one entry; /canon then holds it, as built or rebuilt, and gives its keys way', async () => {
    const st = fakeST(replay(recorded));
    const { bookName } = await runCanon(st);
    const built = structuredClone(st.books[bookName]);
    st.generate = async () => reply({ title: 'The bargain struck', blurb: 'Tamsin and Brother Saul agree a trade.', keys: ['a letter', 'hiding the Saltwind Chart'] });
    const { entry } = await runClip(st, { at: 47, text: BARGAIN });
    const after = st.books[bookName];
    assert.deepEqual(Object.keys(after.entries).sort(), [...Object.keys(built.entries), String(entry.uid)].sort());
    for (const [uid, e] of Object.entries(built.entries)) assert.deepEqual(after.entries[uid], e, 'no other entry changed');
    assert.equal(st.metadata[STATE_KEY].clips.at(-1).ok, true);

    const ledger = st.metadata[STATE_KEY].ledger;
    assert.deepEqual(heldEntries(after, ledger.written).map((h) => [h.entry.uid, h.reason]), [[entry.uid, 'clip']]);
    const rerun = await update({ book: after, ledger, messages, generate: async () => assert.fail('no model call'), contextTokens: 200000 });
    assert.deepEqual(rerun.plan, [], 'an unchanged chat still means zero writes');
    const rebuilt = await update({ book: after, ledger: null, messages, generate: replay(recorded), contextTokens: 200000 });
    assert.deepEqual(rebuilt.book.entries[String(entry.uid)], after.entries[String(entry.uid)], 'a rebuild holds the clip');
    assert.ok(rebuilt.held.some((h) => h.uid === entry.uid && h.reason === 'clip'));
    const claimed = Object.values(rebuilt.book.entries).filter((e) => e.uid !== entry.uid).flatMap((e) => e.key.map((k) => k.toLowerCase()));
    for (const k of entry.key) assert.ok(!claimed.includes(k.toLowerCase()), `'${k}' stays the clip's`);
});

test('the audit reads a clip as held, checks its blurb, and finds nothing technical', async () => {
    const book = bookWithoutBargain();
    const { entry } = await clip({ book, messages, at: 47, text: BARGAIN, generate: async () => good });
    book.entries[String(entry.uid)] = entry;
    const record = await audit({ book, ledger: null, messages, generate: null, contextTokens: 200000 });
    const mine = record.findings.filter((f) => f.uids?.includes(entry.uid) || f.message.includes(entry.comment));
    assert.deepEqual(mine, []);
    assert.ok(record.claims.total >= 1);
});

// --- The gate's X15 and X16, on made-up evidence: green, then red ----------------

function evidence() {
    const off = [{ role: 'system', content: 'Main prompt.\nWorld Info entry.' }, { role: 'user', content: 'Hello.' }];
    const picks = [{ uid: 3, title: 'A', content: 'Entry A.' }, { uid: 5, title: 'B', content: 'Entry B.' }];
    const book = { entries: { 1: { uid: 1, comment: 'One', key: ['one'], content: 'x' } } };
    const clipped = { entries: { ...book.entries, 9: { uid: 9, comment: 'Clip: c', key: ['green wax'], content: 'c', canonkeeper: { clip: { at: 48 } } } } };
    return {
        recall: {
            maxEntries: 3,
            budgetTokens: 600,
            off,
            off2: structuredClone(off),
            on: [off[0], { role: 'system', content: 'Entry A.\nEntry B.' }, off[1]],
            picks,
            broken: [{ what: 'a corrupt state store', prompt: structuredClone(off) }],
        },
        clip: {
            broken: { error: 'not valid JSON', bookBefore: JSON.stringify(book), bookAfter: JSON.stringify(book), prompt: structuredClone(off) },
            working: {
                bookBefore: JSON.stringify(book),
                bookAfter: JSON.stringify(clipped),
                bookAfterCanon: JSON.stringify(clipped),
                canon: { ok: true, plan: [], held: [{ uid: 9, title: 'Clip: c', reason: 'clip' }] },
                firesInScan: false,
                prompt: structuredClone(off),
            },
        },
    };
}

test('X15 and X16 are green on a run that keeps the rule', () => {
    const x = evidence();
    assert.equal(checkX15Recall(x).ok, true, JSON.stringify(checkX15Recall(x).detail));
    assert.equal(checkX16Clip(x).ok, true, JSON.stringify(checkX16Clip(x).detail));
});

test('X15 goes red when broken recall changes the prompt, or recall reorders it', () => {
    const changed = evidence();
    changed.recall.broken[0].prompt[0].content += '\nEntry A.';
    assert.equal(checkX15Recall(changed).ok, false);
    const reordered = evidence();
    reordered.recall.on = [{ role: 'system', content: 'World Info entry.\nMain prompt.' }, { role: 'system', content: 'Entry A.\nEntry B.' }, reordered.recall.off[1]];
    assert.equal(checkX15Recall(reordered).ok, false);
    const unstable = evidence();
    unstable.recall.off2[1].content = 'Hi.';
    assert.equal(checkX15Recall(unstable).ok, false);
    const nothing = evidence();
    nothing.recall.picks = [];
    nothing.recall.on = nothing.recall.off;
    assert.equal(checkX15Recall(nothing).ok, false, 'a working case that adds nothing proves nothing');
    assert.equal(checkX15Recall({}).ok, false);
});

test('X16 goes red when a failed clip writes, a clip touches another entry, or /canon rewrites it', () => {
    const wrote = evidence();
    wrote.clip.broken.bookAfter = wrote.clip.working.bookAfter;
    assert.equal(checkX16Clip(wrote).ok, false);
    const touched = evidence();
    const after = JSON.parse(touched.clip.working.bookAfter);
    after.entries[1].key = [];
    touched.clip.working.bookAfter = JSON.stringify(after);
    touched.clip.working.bookAfterCanon = touched.clip.working.bookAfter;
    assert.equal(checkX16Clip(touched).ok, false);
    const rewritten = evidence();
    rewritten.clip.working.canon.plan = ['update 9'];
    assert.equal(checkX16Clip(rewritten).ok, false);
    const unheld = evidence();
    unheld.clip.working.canon.held = [];
    assert.equal(checkX16Clip(unheld).ok, false);
    assert.equal(checkX16Clip({}).ok, false);
});
