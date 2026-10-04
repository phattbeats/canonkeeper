// The SillyTavern adapter's run (build step 3), against a fake SillyTavern:
// the chat, its metadata and the World Info files are plain objects, and the
// model is a reply recorded from a real run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCanon, toMessages, profileGenerate, truncated, bookNameFor, STATE_KEY } from '../adapter/run.js';
import { parseTranscript } from '../src/transcript.js';
import { replay } from '../src/models/replay.js';

const STORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'story');
const lines = readFileSync(join(STORY, 'transcript.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
const chat = lines.slice(1).map((l) => JSON.parse(l));
const recorded = JSON.parse(readFileSync(join(STORY, 'recorded', 'replies.json'), 'utf8'));

function fakeST({ replies = recorded, metadata = {}, books = {} } = {}) {
    const st = {
        chatId: 'Saltwind - 2026-10-04',
        chat: structuredClone(chat),
        metadata,
        books,
        writes: 0,
        metadataSaves: 0,
        open: 'Saltwind - 2026-10-04',
        currentChatId: () => st.open,
        loadBook: async (name) => (name in st.books ? structuredClone(st.books[name]) : null),
        saveBook: async (name, data) => {
            st.writes++;
            st.books[name] = structuredClone(data);
        },
        createBook: async (name) => {
            st.books[name] = { entries: {} };
        },
        saveMetadata: async () => {
            st.metadataSaves++;
        },
        generate: replay(replies),
        settings: { contextTokens: 200000, maxOutputTokens: 64000 },
        profile: { id: 'p1', name: 'test', model: 'recorded' },
    };
    return st;
}

test('the chat reads exactly as the transcript file does', () => {
    assert.deepEqual(toMessages(chat), parseTranscript(lines.join('\n')));
});

test('first run builds the book, binds it to the chat and stores the ledger', async () => {
    const st = fakeST();
    const { result, bookName } = await runCanon(st);
    assert.equal(bookName, bookNameFor(st.chatId));
    assert.equal(st.metadata.world_info, bookName);
    assert.equal(st.writes, 1);
    assert.ok(Object.keys(st.books[bookName].entries).length > 10);
    assert.deepEqual(st.books[bookName], result.book);
    const state = st.metadata[STATE_KEY];
    assert.equal(state.book, bookName);
    assert.equal(state.ledger.revision, 1);
    assert.equal(state.lastRun.ok, true);
    assert.equal(state.lastRun.calls, 1);
    assert.ok(state.lastRun.log.length > 0);
});

test('a second run on the unchanged chat makes no model call and zero writes', async () => {
    const st = fakeST();
    await runCanon(st);
    const before = structuredClone(st.books);
    st.generate = async () => assert.fail('no model call on an unchanged chat');
    const { result } = await runCanon(st);
    assert.equal(result.plan.length, 0);
    assert.equal(st.writes, 1);
    assert.deepEqual(st.books, before);
    assert.match(st.metadata[STATE_KEY].lastRun.summary, /no writes/);
});

test('a pinned entry and a hand-edited entry are held exactly as they are', async () => {
    const st = fakeST();
    const { bookName } = await runCanon(st);
    const book = st.books[bookName];
    const [pinned, edited] = Object.values(book.entries);
    pinned.canonkeeper.pinned = true;
    edited.content = 'Written by hand.';
    const want = structuredClone([pinned, edited]);
    // An unchanged chat: the held entries stay, and nothing is written.
    st.generate = async () => assert.fail('no model call');
    const { result } = await runCanon(st);
    assert.equal(result.plan.length, 0);
    assert.deepEqual(result.held.map((h) => h.reason).sort(), ['edited by hand', 'pinned']);
    assert.deepEqual([st.books[bookName].entries[pinned.uid], st.books[bookName].entries[edited.uid]], want);
});

test('an existing chat lorebook is used, and its own entries are held', async () => {
    const foreign = { uid: 0, key: ['harbor'], comment: 'Mine', content: 'by hand', disable: false };
    const st = fakeST({ metadata: { world_info: 'My Book' }, books: { 'My Book': { entries: { 0: foreign } } } });
    const { bookName, result } = await runCanon(st);
    assert.equal(bookName, 'My Book');
    assert.deepEqual(st.books['My Book'].entries[0], foreign);
    assert.ok(result.held.some((h) => h.uid === 0 && h.reason === 'not written by Canonkeeper'));
    assert.ok(!(bookNameFor(st.chatId) in st.books));
});

test('nothing is written if the chat is switched during the run', async () => {
    const st = fakeST();
    const generate = st.generate;
    st.generate = async (req) => {
        st.open = 'another chat';
        return generate(req);
    };
    await assert.rejects(runCanon(st), /switched/);
    assert.equal(st.writes, 0);
    assert.equal(st.metadataSaves, 0);
});

test('nothing is written if the lorebook changes during the run, and the failure is recorded', async () => {
    const st = fakeST();
    const generate = st.generate;
    st.generate = async (req) => {
        st.books[bookNameFor(st.chatId)].entries[9] = { uid: 9, key: ['x'], comment: 'typed meanwhile', content: '' };
        return generate(req);
    };
    await assert.rejects(runCanon(st), /lorebook changed/);
    assert.equal(st.writes, 0);
    assert.equal(st.metadata[STATE_KEY].lastRun.ok, false);
    assert.equal(st.metadata[STATE_KEY].ledger, undefined);
});

test('a bad reply fails the run with nothing written', async () => {
    const st = fakeST({ replies: ['not json', 'still not json'] });
    await assert.rejects(runCanon(st));
    assert.equal(st.writes, 0);
    assert.equal(st.metadata[STATE_KEY].lastRun.ok, false);
});

test('a reply cut off at the output limit counts as no reply', async () => {
    const asked = [];
    const send = async (...args) => {
        asked.push(args);
        return { content: [{ type: 'text', text: '{"scenes": [' }], stop_reason: 'max_tokens' };
    };
    const generate = profileGenerate({ send, extract: (j) => j.content[0].text, profileId: 'p1' });
    assert.equal(await generate({ system: 's', user: 'u', maxTokens: 100 }), '');
    assert.equal(asked[0][0], 'p1');
    assert.deepEqual(asked[0][1], [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
    assert.equal(asked[0][2], 100);
    assert.equal(asked[0][3].includePreset, false);
    assert.ok(truncated({ choices: [{ finish_reason: 'length' }] }));
    assert.ok(!truncated({ choices: [{ finish_reason: 'stop' }] }));
    assert.ok(!truncated({ stop_reason: 'end_turn' }));
});
