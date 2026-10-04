// The audit (build step 6): the technical pass, claim re-verification, the
// review queue, and a deleted entry staying deleted. The model is replaced by
// canned replies, plus verdicts recorded from a real model on the planted book.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTranscript } from '../src/transcript.js';
import { build } from '../src/build.js';
import { update } from '../src/update.js';
import { technicalPass, claimsOf, readVerdicts, batches, audit, accept, dismiss, openFindings, claimId, StaleAuditError } from '../src/audit.js';
import { ModelOutputError, extractJson } from '../src/parse.js';
import { planBudget } from '../src/budget.js';
import { replay } from '../src/models/replay.js';
import { runCanon, runAudit, acceptFinding, dismissFinding, STATE_KEY } from '../adapter/run.js';

const STORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'story');
const readJson = (...p) => JSON.parse(readFileSync(join(STORY, ...p), 'utf8'));
const messages = parseTranscript(readFileSync(join(STORY, 'transcript.jsonl'), 'utf8'));
const recorded = readJson('recorded', 'replies.json');
const plant = readJson('audit', 'plant.json');
const CONTEXT = 200000;

const titled = (book, name) => Object.values(book.entries).find((e) => e.comment === name);
const noModel = async () => assert.fail('no model call expected');
const of = (findings, check) => findings.filter((f) => f.check === check);

async function built() {
    const out = await build({ messages, generate: replay(recorded), contextTokens: CONTEXT });
    titled(out.book, 'Brother Saul').canonkeeper.pinned = true;
    return out;
}

/** What a human does in the World Info editor. */
function deleteEntry(book, name) {
    const e = titled(book, name);
    delete book.entries[String(e.uid)];
    return e;
}

/** A reply judging every claim `verdict`, except those listed. */
function verdictsReply(count, overrides = {}) {
    return JSON.stringify({ claims: Array.from({ length: count }, (_, i) => ({ id: `C${i + 1}`, why: '', verdict: overrides[i + 1] ?? 'supported' })) });
}

// ── the technical pass ──────────────────────────────────────────────────────

test('the planted collision in the broken fixture is caught, on both entries', () => {
    const book = readJson('broken-collision', 'book.json');
    const found = of(technicalPass({ book, messages }), 'collision');
    assert.equal(found.length, 1);
    assert.equal(found[0].key, 'Captain');
    assert.deepEqual(found[0].titles.sort(), ['Mora Quill', 'Oren Hale']);
    // Neither is pinned: Canonkeeper's rule takes the key off both.
    assert.deepEqual(found[0].fix.uids.sort(), found[0].uids.sort());
});

test('the reference book and a fresh build have no technical findings', async () => {
    assert.deepEqual(technicalPass({ book: readJson('reference', 'book.json'), messages }), []);
    const { book, ledger } = await built();
    assert.deepEqual(technicalPass({ book, ledger, messages }), []);
});

test('a deleted entry is caught, and a run leaves it deleted', async () => {
    const { book, ledger } = await built();
    const gone = deleteEntry(book, plant.delete);
    const found = of(technicalPass({ book, ledger, messages }), 'deleted');
    assert.deepEqual(found.map((f) => f.uids), [[gone.uid]]);
    assert.deepEqual(found[0].fix, { op: 'restore', uid: gone.uid, name: gone.comment, says: `restore '${gone.comment}'` });

    // Without the tombstone, /canon would quietly add it back.
    const out = await update({ book, ledger, messages, generate: noModel, contextTokens: CONTEXT });
    assert.deepEqual(out.plan, []);
    assert.deepEqual(out.ledger.deleted, { [gone.uid]: gone.comment });
    assert.ok(out.ledger.review.some((r) => r.name === gone.comment && /deleted/.test(r.reason)));
    // Still caught after the run, from the ledger's own record.
    assert.deepEqual(of(technicalPass({ book: out.book, ledger: out.ledger, messages }), 'deleted').map((f) => f.uids), [[gone.uid]]);
    // And again on the run after that.
    const again = await update({ book: out.book, ledger: out.ledger, messages, generate: noModel, contextTokens: CONTEXT });
    assert.deepEqual(again.plan, []);
});

test('a deleted entry no longer claims its keys', async () => {
    const { book, ledger } = await built();
    const gone = deleteEntry(book, 'Oren Hale');
    const out = await update({ book, ledger, messages, generate: noModel, contextTokens: CONTEXT });
    assert.equal(out.book.entries[String(gone.uid)], undefined);
    const keys = Object.values(out.book.entries).flatMap((e) => e.key.map((k) => k.toLowerCase()));
    for (const k of gone.key) assert.ok(!keys.includes(k.toLowerCase()), `'${k}' is still claimed`);
});

test('a collision between two hand-edited entries can be fixed from the queue; the fix is not applied until accepted', async () => {
    const { book, ledger } = await built();
    for (const name of plant.collision.entries) titled(book, name).key.push(plant.collision.key);
    const before = structuredClone(book);
    const record = await audit({ book, ledger, messages, contextTokens: CONTEXT });
    assert.deepEqual(book, before, 'the audit wrote nothing');
    const coll = of(record.findings, 'collision')[0];
    assert.equal(coll.fix.op, 'drop-key');
    // A run doesn't touch them: both are edited by hand.
    const run = await update({ book, ledger, messages, generate: noModel, contextTokens: CONTEXT });
    assert.deepEqual(run.plan, []);

    const out = await accept({ book, ledger, messages, record, id: coll.id });
    for (const name of plant.collision.entries) assert.ok(!titled(out.book, name).key.includes(plant.collision.key));
    assert.equal(out.writes.length, 2);
    assert.deepEqual(of(technicalPass({ book: out.book, ledger: out.ledger, messages }), 'collision'), []);
});

test('a collision with an entry Canonkeeper owns is left to /canon, which resolves it', async () => {
    const { book, ledger } = await built();
    const quill = titled(book, 'Mora Quill');
    book.entries['900'] = { uid: 900, key: ['Quill'], comment: 'A pen', content: 'A goose-feather pen.', disable: false };
    const [coll] = of(technicalPass({ book, ledger, messages }), 'collision');
    assert.deepEqual(coll.uids.sort((a, b) => a - b), [quill.uid, 900]);
    assert.equal(coll.fix, null);
    assert.match(coll.message, /Run \/canon/);
    const out = await update({ book, ledger, messages, generate: noModel, contextTokens: CONTEXT });
    assert.ok(!titled(out.book, 'Mora Quill').key.includes('Quill'));
    assert.deepEqual(of(technicalPass({ book: out.book, ledger: out.ledger, messages }), 'collision'), []);
});

test('two pinned entries on one key: caught, and only a human can choose', () => {
    const book = structuredClone(readJson('broken-collision', 'book.json'));
    for (const e of Object.values(book.entries)) if (e.key.includes('Captain')) e.canonkeeper = { ...e.canonkeeper, pinned: true };
    const [coll] = of(technicalPass({ book, messages }), 'collision');
    assert.equal(coll.fix, null);
});

test('no keys, overbroad keys, probability and recursion settings', () => {
    const entry = (uid, extra) => ({ uid, key: [`Thing${uid}`], comment: `T${uid}`, content: '', disable: false, ...extra });
    const book = { entries: {
        1: entry(1, { key: [] }),
        2: entry(2, { key: ['the'] }),
        3: entry(3, { probability: 0, useProbability: true }),
        4: entry(4, { probability: 50, useProbability: true }),
        5: entry(5, { probability: 50, useProbability: false }),
        6: entry(6, { probability: 140 }),
        7: entry(7, { delayUntilRecursion: true, excludeRecursion: true }),
        8: entry(8, { delayUntilRecursion: true }),
        9: entry(9, { key: ['Thing9'], delayUntilRecursion: true }),
        10: entry(10, { content: 'It mentions Thing9.', preventRecursion: false }),
        11: entry(11, { key: [], constant: true }),
        12: entry(12, { key: [], disable: true }),
    } };
    const found = technicalPass({ book, messages });
    const at = (check) => of(found, check).map((f) => [f.uids[0], f.severity]);
    assert.deepEqual(at('no-keys'), [[1, 'error']]);
    assert.deepEqual(at('overbroad'), [[2, 'error']]);
    assert.deepEqual(at('probability'), [[3, 'error'], [4, 'warning'], [6, 'error']]);
    assert.deepEqual(at('recursion'), [[7, 'error'], [8, 'error']]);
    assert.deepEqual(of(found, 'overbroad')[0].fix, { op: 'drop-key', key: 'the', uids: [2], says: "remove 'the' from 'T2'" });
    assert.deepEqual(of(found, 'recursion')[0].fix.fields, { delayUntilRecursion: false });
});

test('provenance that points outside the chat, or at messages that never name the entry', async () => {
    const { book, ledger } = await built();
    titled(book, 'Pell').canonkeeper.sources = [[500, 501]];
    titled(book, 'Wren').canonkeeper.sources = [[0, 0]];
    const found = of(technicalPass({ book, ledger, messages }), 'provenance');
    assert.deepEqual(found.map((f) => f.message.split("'")[1]).sort(), ['Pell', 'Wren']);
});

test('a regex key and matchWholeWords are read as SillyTavern reads them', () => {
    const book = { entries: {
        1: { uid: 1, key: ['/\\bthe\\b/i'], comment: 'Regex', disable: false },
        2: { uid: 2, key: ['a'], comment: 'Substring', matchWholeWords: false, disable: false },
        3: { uid: 3, key: ['a'], comment: 'Word', disable: false },
    } };
    const found = of(technicalPass({ book, messages }), 'overbroad').map((f) => f.uids[0]);
    assert.deepEqual(found, [1, 2]);
});

// ── claim re-verification ───────────────────────────────────────────────────

test('claims carry their cited messages; one whose message changed is stale, not verified', async () => {
    const { book, ledger } = await built();
    const { claims, stale } = claimsOf({ book, ledger, messages });
    assert.ok(claims.length > 40);
    assert.equal(stale.length, 0);
    const edited = messages.map((m) => (m.id === 40 ? { ...m, text: 'The lighthouse is gone.' } : m));
    const after = claimsOf({ book, ledger, messages: edited });
    assert.ok(after.stale.length > 0);
    assert.ok(after.stale.every((c) => c.cited.includes(40)));
    const record = await audit({ book, ledger, messages: edited, generate: async () => verdictsReply(after.claims.length), contextTokens: CONTEXT });
    assert.equal(record.claims.stale, after.stale.length);
    assert.equal(of(record.findings, 'stale').length, 1);
});

test('verdicts are read strictly; a claim with no usable verdict stays unchecked', () => {
    assert.throws(() => readVerdicts('no json here', 3), ModelOutputError);
    assert.throws(() => readVerdicts('{"verdicts": []}', 3), ModelOutputError);
    const got = readVerdicts(JSON.stringify({ claims: [
        { id: 'C1', verdict: 'contradicted', why: 'no' },
        { id: 'C1', verdict: 'supported' },
        { id: 'C2', verdict: 'maybe' },
        { id: 'C9', verdict: 'supported' },
        { id: 'C3', verdict: 'unsupported' },
    ] }), 3);
    assert.deepEqual([...got.keys()].sort(), [0, 2]);
    assert.equal(got.get(0).verdict, 'contradicted');
});

test('claims are batched to fit the window, an entry kept whole', async () => {
    const { book, ledger } = await built();
    const { claims } = claimsOf({ book, ledger, messages });
    const one = batches(messages, claims, planBudget({ contextTokens: CONTEXT, maxOutputTokens: 8000 }));
    assert.equal(one.batches.length, 1);
    const small = batches(messages, claims, planBudget({ contextTokens: 6000, maxOutputTokens: 1500 }));
    assert.ok(small.batches.length > 1);
    assert.equal(small.batches.flat().length + small.tooBig.length, claims.length);
    for (const b of small.batches) {
        const uids = [...new Set(b.map((c) => c.uid))];
        for (const u of uids) assert.equal(b.filter((c) => c.uid === u).length, claims.filter((c) => c.uid === u).length);
    }
});

test('the planted false facts are flagged by the recorded verification', async () => {
    const replies = JSON.parse(readFileSync(join(STORY, 'audit', 'verify-planted.json'), 'utf8'));
    const reply = extractJson(recorded[0]);
    for (const f of plant.falseFacts) reply.entities.find((e) => e.name === f.entity).facts.push({ text: f.text, messages: f.messages });
    const { book, ledger } = await build({ messages, generate: replay([JSON.stringify(reply)]), contextTokens: CONTEXT });
    titled(book, 'Brother Saul').canonkeeper.pinned = true;
    for (const name of plant.collision.entries) titled(book, name).key.push(plant.collision.key);
    deleteEntry(book, plant.delete);
    const record = await audit({ book, ledger, messages, generate: replay(replies), contextTokens: CONTEXT });
    for (const f of plant.falseFacts) {
        const hit = of(record.findings, 'claim').find((x) => x.claim === f.text);
        assert.ok(hit, `not flagged: ${f.text}`);
        assert.equal(hit.verdict, f.expect);
    }
    // Mora Quill was edited by hand (the collision), so her fact can't be
    // dropped from the queue; the lighthouse's can.
    assert.equal(of(record.findings, 'claim').find((x) => x.claim === plant.falseFacts[1].text).fix, null);
    assert.equal(of(record.findings, 'claim').find((x) => x.claim === plant.falseFacts[0].text).fix.op, 'drop-fact');
});

// ── the review queue ────────────────────────────────────────────────────────

test('accepting a restore brings the entry back on its uid, as it was', async () => {
    const { book, ledger } = await built();
    const original = structuredClone(book);
    const gone = deleteEntry(book, plant.delete);
    const run = await update({ book, ledger, messages, generate: noModel, contextTokens: CONTEXT });
    const record = await audit({ book: run.book, ledger: run.ledger, messages, contextTokens: CONTEXT });
    const out = await accept({ book: run.book, ledger: run.ledger, messages, record, id: `deleted:${gone.uid}` });
    assert.deepEqual(out.writes, [`add ${gone.uid} '${gone.comment}'`]);
    assert.deepEqual(out.book.entries[String(gone.uid)], original.entries[String(gone.uid)]);
    assert.equal(out.ledger.deleted, undefined);
    // From then on it's an ordinary entry: an unchanged run writes nothing.
    const next = await update({ book: out.book, ledger: out.ledger, messages, generate: noModel, contextTokens: CONTEXT });
    assert.deepEqual(next.plan, []);
    assert.deepEqual(technicalPass({ book: out.book, ledger: out.ledger, messages }), []);
});

test('accepting a restore right after the deletion, before any run, works too', async () => {
    const { book, ledger } = await built();
    const gone = deleteEntry(book, plant.delete);
    const record = await audit({ book, ledger, messages, contextTokens: CONTEXT });
    const out = await accept({ book, ledger, messages, record, id: `deleted:${gone.uid}` });
    assert.ok(out.book.entries[String(gone.uid)]);
    const next = await update({ book: out.book, ledger: out.ledger, messages, generate: noModel, contextTokens: CONTEXT });
    assert.deepEqual(next.plan, []);
});

test('accepting a drop-fact rewrites only that entry, with no model call', async () => {
    const { book, ledger } = await built();
    const light = titled(book, 'Kestrel Lighthouse');
    const fact = light.canonkeeper.facts[0].text;
    const { claims } = claimsOf({ book, ledger, messages });
    const at = claims.findIndex((c) => c.id === claimId(light.uid, fact)) + 1;
    const record = await audit({ book, ledger, messages, generate: async () => verdictsReply(claims.length, { [at]: 'contradicted' }), contextTokens: CONTEXT });
    const [f] = of(record.findings, 'claim');
    assert.equal(f.claim, fact);
    const out = await accept({ book, ledger, messages, record, id: f.id });
    assert.deepEqual(out.writes, [`update ${light.uid} 'Kestrel Lighthouse' (content, canonkeeper)`]);
    assert.ok(!out.book.entries[String(light.uid)].content.includes(fact));
    assert.ok(!out.ledger.entities.find((e) => e.uid === light.uid).facts.some((x) => x.text === fact));
    const next = await update({ book: out.book, ledger: out.ledger, messages, generate: noModel, contextTokens: CONTEXT });
    assert.deepEqual(next.plan, []);
});

test('a fix is refused once the book or the chat has changed since the audit', async () => {
    const { book, ledger } = await built();
    deleteEntry(book, plant.delete);
    const record = await audit({ book, ledger, messages, contextTokens: CONTEXT });
    const [f] = of(record.findings, 'deleted');
    const changed = structuredClone(book);
    titled(changed, 'Pell').content = 'Edited.';
    await assert.rejects(accept({ book: changed, ledger, messages, record, id: f.id }), StaleAuditError);
    const more = [...messages, { id: messages.length, name: 'Tamsin', text: 'One more line.' }];
    await assert.rejects(accept({ book, ledger, messages: more, record, id: f.id }), StaleAuditError);
});

test('a dismissed finding stays dismissed in later audits, and verdicts carry over', async () => {
    const { book, ledger } = await built();
    deleteEntry(book, plant.delete);
    const { claims } = claimsOf({ book, ledger, messages });
    const first = await audit({ book, ledger, messages, generate: async () => verdictsReply(claims.length, { 1: 'unsupported' }), contextTokens: CONTEXT });
    const id = of(first.findings, 'deleted')[0].id;
    const after = dismiss(first, id);
    assert.equal(openFindings(after).some((f) => f.id === id), false);
    const second = await audit({ book, ledger, messages, previous: after, contextTokens: CONTEXT });
    assert.equal(second.findings.find((f) => f.id === id).dismissed, true);
    assert.equal(of(second.findings, 'claim').length, 1, 'the verdict carried over without a model call');
    assert.equal(second.claims.checked, claims.length);
});

// ── in SillyTavern ──────────────────────────────────────────────────────────

const chat = readFileSync(join(STORY, 'transcript.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l));

function fakeST() {
    const st = {
        chatId: 'Saltwind', chat: structuredClone(chat), metadata: {}, books: {}, writes: 0, open: 'Saltwind',
        currentChatId: () => st.open,
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
        generate: replay(recorded),
        settings: { contextTokens: CONTEXT, maxOutputTokens: 64000 },
        profile: { id: 'p1', name: 'test', model: 'recorded' },
    };
    return st;
}

test('/canon-audit keeps the review queue in the chat metadata and writes nothing; accept writes the fix', async () => {
    const st = fakeST();
    const { bookName } = await runCanon(st);
    for (const name of plant.collision.entries) titled(st.books[bookName], name).key.push(plant.collision.key);
    const gone = deleteEntry(st.books[bookName], plant.delete);
    const writes = st.writes;
    const claims = claimsOf({ book: st.books[bookName], ledger: st.metadata[STATE_KEY].ledger, messages }).claims.length;
    st.generate = async () => verdictsReply(claims);
    const { summary } = await runAudit(st);
    assert.equal(st.writes, writes, 'the audit wrote nothing');
    assert.match(summary, /2 errors?|error/);
    const a = st.metadata[STATE_KEY].audit;
    assert.equal(a.book, bookName);
    assert.ok(a.findings.some((f) => f.check === 'collision'));
    assert.ok(a.findings.some((f) => f.id === `deleted:${gone.uid}`));
    assert.ok(a.log.length);

    // /canon in between: the deleted entry stays deleted.
    st.generate = noModel;
    const run = await runCanon(st);
    assert.equal(run.result.plan.length, 0);
    assert.equal(st.books[bookName].entries[String(gone.uid)], undefined);

    await acceptFinding(st, `deleted:${gone.uid}`);
    assert.ok(st.books[bookName].entries[String(gone.uid)]);
    const after = st.metadata[STATE_KEY].audit;
    assert.equal(after.accepted.length, 1);
    assert.ok(!after.findings.some((f) => f.check === 'deleted'));
    assert.ok(!st.metadata[STATE_KEY].ledger.deleted);

    await dismissFinding(st, 'collision:captain');
    assert.equal(st.metadata[STATE_KEY].audit.findings.find((f) => f.id === 'collision:captain').dismissed, true);
});

test('/canon-audit on a chat with no lorebook says so and keeps the error', async () => {
    const st = fakeST();
    await assert.rejects(runAudit(st), /no lorebook/);
    assert.match(st.metadata[STATE_KEY].audit.error.message, /no lorebook/);
});
