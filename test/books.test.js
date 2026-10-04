// Every lorebook active for the chat (PHA-3971): the character card's books,
// global worlds and the persona book are read, never written. An entity one
// of them already covers, by title or by one of its names as a key, gets no
// Canonkeeper entry, and their keys win every contest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTranscript } from '../src/transcript.js';
import { build } from '../src/build.js';
import { update } from '../src/update.js';
import { compile } from '../src/compile.js';
import { technicalPass } from '../src/audit.js';
import { replay } from '../src/models/replay.js';
import { runCanon, STATE_KEY } from '../adapter/run.js';
import { runGate } from '../harness/gate.js';

const STORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'story');
const lines = readFileSync(join(STORY, 'transcript.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
const messages = parseTranscript(lines.join('\n'));
const chat = lines.slice(1).map((l) => JSON.parse(l));
const recorded = JSON.parse(readFileSync(join(STORY, 'recorded', 'replies.json'), 'utf8'));
const CONTEXT = 200000;

const fold = (s) => s.toLowerCase();
const wi = (uid, comment, key, extra = {}) => ({ uid, comment, key, keysecondary: [], content: `${comment}, as the user wrote it.`, disable: false, constant: false, ...extra });
const ent = (name, keys, ids) => ({ name, keys, facts: [{ text: `${name} is in the story.`, messages: ids }], caseSensitive: false, cascade: true, throttle: 0 });

const CARD = "Narrator's card";
const GLOBAL = 'Saltgate Gazetteer';
const cartographer = wi(3, 'The Cartographer (Ines)', ['Ines Vell']);
const watchman = wi(0, 'Watchman Reyes', ['Watchman Reyes']);
const lantern = wi(1, 'The Drowned Lantern', ['tavern']);
const foreign = [
    { book: CARD, entry: cartographer },
    { book: GLOBAL, entry: watchman },
    { book: GLOBAL, entry: lantern },
];
const keysOf = (entries) => entries.flatMap((e) => e.key.map(fold));

test("a character-card entry titled 'The Cartographer (Ines)' keyed 'Ines Vell' gives no second Ines entry", async () => {
    const { book, ledger } = await build({ messages, generate: replay(recorded), contextTokens: CONTEXT, foreign: [{ book: CARD, entry: cartographer }] });
    const entries = Object.values(book.entries);
    assert.ok(!entries.some((e) => /ines/i.test(e.comment)), 'no Canonkeeper entry for Ines');
    assert.ok(!keysOf(entries).some((k) => ['ines', 'ines vell', 'the cartographer'].includes(k)), 'no Canonkeeper key for Ines');
    // The skip is on the review list, with the other book and its entry.
    const skip = ledger.review.find((r) => r.name === 'Ines Vell');
    assert.match(skip.reason, /Narrator's card/);
    assert.match(skip.reason, /The Cartographer \(Ines\)/);
    assert.equal(ledger.entities.find((e) => e.name === 'Ines Vell').heldBy.book, CARD);
});

test("a global book's key is never claimed by a Canonkeeper entry", async () => {
    // Directly: 'Watchman' fires on every 'Watchman Reyes' the global book
    // keys, so Oren Hale gives it up and keeps his other names.
    const out = compile([ent('Oren Hale', ['Oren Hale', 'Captain Hale', 'Watchman'], [10])], messages, { foreign: [{ book: GLOBAL, entry: watchman }] });
    const hale = out.entries.find((e) => e.comment === 'Oren Hale');
    assert.ok(hale && !hale.key.includes('Watchman'));
    assert.ok(hale.key.includes('Oren Hale'));
    // And across the recorded build: no Canonkeeper entry holds a global key,
    // and the Drowned Lantern, which the global book has by title, is skipped.
    const { book } = await build({ messages, generate: replay(recorded), contextTokens: CONTEXT, foreign });
    const entries = Object.values(book.entries);
    const theirs = new Set(foreign.flatMap((f) => f.entry.key.map(fold)));
    assert.deepEqual(keysOf(entries).filter((k) => theirs.has(k)), []);
    assert.ok(!entries.some((e) => fold(e.comment) === 'the drowned lantern'));
    assert.ok(entries.length > 10, 'the rest of the book is still built');
});

test('an entity a book enabled later covers loses its Canonkeeper entry; foreign entries are never in a plan', async () => {
    const first = await build({ messages, generate: replay(recorded), contextTokens: CONTEXT });
    const ines = Object.values(first.book.entries).find((e) => e.comment === 'Ines Vell');
    assert.ok(ines);
    const out = await update({ book: first.book, ledger: first.ledger, messages, generate: async () => assert.fail('no model call'), contextTokens: CONTEXT, foreign: [{ book: CARD, entry: cartographer }] });
    assert.deepEqual(out.plan.map((o) => [o.op, o.title]), [['remove', 'Ines Vell']]);
    assert.ok(!out.plan.some((o) => o.title === cartographer.comment));
    // A disabled entry in another book is not active: it covers nothing.
    const off = await update({ book: first.book, ledger: first.ledger, messages, generate: async () => assert.fail('no model call'), contextTokens: CONTEXT, foreign: [{ book: CARD, entry: { ...cartographer, disable: true } }] });
    assert.deepEqual(off.plan, []);
});

// ── through the adapter ─────────────────────────────────────────────────────

function fakeST(books, others) {
    const st = {
        chatId: 'Saltwind - 2026-10-04',
        chat: structuredClone(chat),
        metadata: {},
        books,
        saved: [],
        currentChatId: () => st.chatId,
        bookExists: async (name) => name in st.books,
        loadBook: async (name) => structuredClone(st.books[name] ?? { entries: {} }),
        saveBook: async (name, data) => {
            st.saved.push(name);
            st.books[name] = structuredClone(data);
        },
        createBook: async (name) => {
            st.books[name] = { entries: {} };
        },
        // The books active for the chat besides its own, as the adapter finds them.
        otherBooks: async () => others.map(({ name, via }) => ({ name, via, entries: structuredClone(st.books[name]?.entries ?? {}) })),
        saveMetadata: async () => {},
        generate: replay(recorded),
        settings: { contextTokens: CONTEXT, maxOutputTokens: 64000 },
        profile: { id: 'p1', name: 'test', model: 'recorded' },
    };
    return st;
}

test('foreign books are byte-identical after a run, and the run names the books it consulted', async () => {
    const books = {
        [CARD]: { entries: { 3: cartographer } },
        [GLOBAL]: { entries: { 0: watchman, 1: lantern } },
    };
    const files = Object.fromEntries(Object.entries(books).map(([n, b]) => [n, JSON.stringify(b)]));
    const st = fakeST(books, [{ name: CARD, via: 'character' }, { name: GLOBAL, via: 'global' }]);
    const { bookName, result } = await runCanon(st);
    // A rerun, with the chat edited at the end, writes again.
    st.chat.push({ name: 'Narrator', is_user: false, mes: 'Ines Vell unrolls the Saltwind Chart.' });
    st.generate = replay([JSON.stringify({ scenes: [], entities: [], review: [] })]);
    await runCanon(st);
    for (const [name, file] of Object.entries(files)) assert.equal(JSON.stringify(st.books[name]), file, `'${name}' unchanged`);
    assert.deepEqual([...new Set(st.saved)], [bookName]);
    // Zero duplicate entities across books.
    const mine = Object.values(st.books[bookName].entries);
    assert.ok(!mine.some((e) => ['ines vell', 'the drowned lantern'].includes(fold(e.comment))));
    const run = st.metadata[STATE_KEY].lastRun;
    assert.deepEqual(run.books.map((b) => b.name), [CARD, GLOBAL]);
    assert.ok(run.log.some((l) => l.includes(`'${CARD}'`) && l.includes(`'${GLOBAL}'`)));
    assert.ok(result.ledger.review.some((r) => r.name === 'Ines Vell'));
});

test('the chat book is never counted as another book, even when it is also global', async () => {
    const st = fakeST({ [GLOBAL]: { entries: { 0: watchman } } }, [{ name: 'Mine', via: 'global' }, { name: GLOBAL, via: 'global' }]);
    st.metadata.world_info = 'Mine';
    st.books.Mine = { entries: {} };
    await runCanon(st);
    assert.deepEqual(st.metadata[STATE_KEY].lastRun.books.map((b) => b.name), [GLOBAL]);
});

// ── the audit ───────────────────────────────────────────────────────────────

test('a key the chat book shares with another active book is an audit finding', () => {
    const book = { entries: { 5: wi(5, 'Ines', ['Ines Vell', 'Ines']) } };
    const findings = technicalPass({ book, messages, foreign: [{ book: CARD, entry: cartographer }] });
    const f = findings.find((x) => x.check === 'cross-book');
    assert.ok(f);
    assert.equal(f.key, 'Ines Vell');
    assert.match(f.message, /Narrator's card/);
    // The fix is to the chat book: another book is never written.
    assert.deepEqual(f.fix.uids, [5]);
    const clean = technicalPass({ book, messages, foreign: [{ book: CARD, entry: { ...cartographer, disable: true } }] });
    assert.ok(!clean.some((x) => x.check === 'cross-book'));
});

// ── the gate's --books mode, on a run made offline ──────────────────────────

/** A run directory as the live driver writes it: chat book, rerun, scenes, others.json. */
async function gateRun({ tamper = false } = {}) {
    const harbor = wi(4, 'The Harbor Chain', ['harbor chain']);
    const books = {
        [CARD]: { entries: { 3: cartographer } },
        [GLOBAL]: { entries: { 1: { ...lantern, key: ['Drowned Lantern', 'tavern'] }, 4: harbor } },
    };
    const files = Object.fromEntries(Object.entries(books).map(([n, b]) => [n, JSON.stringify(b)]));
    const st = fakeST(books, [{ name: CARD, via: 'character' }, { name: GLOBAL, via: 'global' }]);
    const { bookName, result } = await runCanon(st);
    for (const t of ['Brother Saul', 'The Undercroft']) Object.values(st.books[bookName].entries).find((e) => e.comment === t).canonkeeper.pinned = true;
    const book = structuredClone(st.books[bookName]);
    st.generate = async () => assert.fail('no model call');
    await runCanon(st);
    if (tamper) st.books[GLOBAL].entries[4].key.push('chain');
    const dir = mkdtempSync(join(tmpdir(), 'canonkeeper-books-'));
    writeFileSync(join(dir, 'book.json'), JSON.stringify(book));
    writeFileSync(join(dir, 'rerun.json'), JSON.stringify(st.books[bookName]));
    writeFileSync(join(dir, 'scenes.json'), JSON.stringify(result.scenes));
    writeFileSync(join(dir, 'others.json'), JSON.stringify({ books: Object.keys(files).map((name) => ({ name, before: files[name], after: [JSON.stringify(st.books[name])] })) }));
    return runGate({ storyDir: STORY, runDir: dir, books: true });
}

test('gate --books: green when the other books cover entities once and are unchanged; red when one was written', async () => {
    const green = await gateRun();
    assert.ok(green.ok, JSON.stringify(green.checks.filter((c) => !c.ok)));
    const b14 = green.checks.find((c) => c.id === 'B14');
    assert.deepEqual(b14.detail.books, [CARD, GLOBAL]);
    const red = await gateRun({ tamper: true });
    assert.deepEqual(red.checks.find((c) => c.id === 'B14').detail.written, [{ book: GLOBAL, run: 1 }]);
});
