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
import { technicalPass, claimsOf, readVerdicts, batches, audit, accept, checkHand, parseMessageList, dismiss, openFindings, claimId, StaleAuditError } from '../src/audit.js';
import { ModelOutputError, extractJson } from '../src/parse.js';
import { planBudget } from '../src/budget.js';
import { replay } from '../src/models/replay.js';
import { runCanon, runAudit, acceptFinding, checkFinding, dismissFinding, STATE_KEY } from '../adapter/run.js';

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

test('overlap warnings on a colliding key sit inside the collision: one row', () => {
    const book = readJson('broken-collision', 'book.json');
    const all = technicalPass({ book, messages });
    const rows = all.filter((f) => /captain/i.test(f.key ?? ''));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].check, 'collision');
    assert.ok(!all.some((f) => f.check === 'overlap' && /captain/i.test(f.key)));
    assert.ok(rows[0].related.every((r) => r.check === 'overlap'));
});

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

test('the technical pass is handed over before any model call, then claim progress counts up', async () => {
    const { book, ledger } = await built();
    const { claims } = claimsOf({ book, ledger, messages });
    const events = [];
    let firstCall = null;
    const generate = async (req) => {
        firstCall ??= events.length;
        return verdictsReply(claims.length);
    };
    const record = await audit({ book, ledger, messages, generate, contextTokens: CONTEXT, onProgress: (p) => events.push(p) });
    assert.equal(events[0].phase, 'technical');
    assert.ok(firstCall >= 1, 'the technical event came before the first model call');
    assert.equal(events[0].total, claims.length);
    assert.equal(events[0].checked, 0);
    assert.deepEqual(events[0].findings.map((f) => f.id), record.findings.filter((f) => f.check !== 'claim' && f.check !== 'stale').map((f) => f.id));
    const counts = events.slice(1).map((p) => p.checked);
    assert.ok(counts.length >= 1);
    assert.deepEqual(counts, [...counts].sort((a, b) => a - b));
    assert.equal(counts.at(-1), record.claims.checked + record.claims.unchecked);
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
    const capped = batches(messages, claims, planBudget({ contextTokens: CONTEXT, maxOutputTokens: 8000 }), 20);
    assert.ok(capped.batches.length > 1);
    assert.equal(capped.batches.flat().length, claims.length);
    for (const b of capped.batches) assert.ok(b.length <= 20 || new Set(b.map((c) => c.uid)).size === 1);
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

test('a second audit of an unchanged book makes no claim-check call and keeps every verdict', async () => {
    const { book, ledger } = await built();
    const { claims } = claimsOf({ book, ledger, messages });
    let calls = 0;
    const gen = async () => (calls++, verdictsReply(claims.length, { 3: 'unsupported', 7: 'contradicted' }));
    const first = await audit({ book, ledger, messages, generate: gen, contextTokens: CONTEXT, profile: 'haiku' });
    const made = calls;
    assert.ok(made > 0);
    const second = await audit({ book, ledger, messages, generate: gen, contextTokens: CONTEXT, profile: 'haiku', previous: first });
    assert.equal(calls, made, 'no further call');
    assert.equal(second.calls, 0);
    assert.equal(second.reused, claims.length);
    assert.deepEqual(second.verdicts, first.verdicts);
    // A different checker, or a re-check, asks again.
    const other = await audit({ book, ledger, messages, generate: gen, contextTokens: CONTEXT, profile: 'sonnet', previous: first });
    assert.ok(other.calls > 0);
    const forced = await audit({ book, ledger, messages, generate: gen, contextTokens: CONTEXT, profile: 'haiku', previous: first, recheck: true });
    assert.equal(forced.reused, 0);
    assert.ok(forced.calls > 0);
});

test('editing one cited message re-checks only the claims citing it', async () => {
    const { book } = await built();
    const { claims } = claimsOf({ book, messages });
    const asked = [];
    const gen = async ({ user }) => {
        const n = (user.match(/^C\d+ · /gm) ?? []).length;
        asked.push(n);
        return verdictsReply(n);
    };
    const first = await audit({ book, messages, generate: gen, contextTokens: CONTEXT });
    asked.length = 0;
    const edited = messages.map((m) => (m.id === 40 ? { ...m, text: `${m.text} Later, rain.` } : m));
    const citing = claims.filter((c) => c.ids.includes(40));
    assert.ok(citing.length > 0 && citing.length < claims.length);
    const second = await audit({ book, messages: edited, generate: gen, contextTokens: CONTEXT, previous: first });
    assert.equal(asked.reduce((a, b) => a + b, 0), citing.length);
    assert.equal(second.reused, claims.length - citing.length);
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

// ── re-citing: a true fact that cites the wrong message ─────────────────────

const MISCITED = { entity: 'Dovrin Kesh', text: 'Orders the watch to search couriers for the stolen charts.', wrongly: [30], truly: [12] };

/** The recorded build with one true fact citing the wrong message, and the plant's false facts added. */
async function miscited() {
    const reply = extractJson(recorded[0]);
    const fact = reply.entities.find((e) => e.name === MISCITED.entity).facts.find((f) => f.text === MISCITED.text);
    fact.messages = MISCITED.wrongly;
    for (const f of plant.falseFacts) reply.entities.find((e) => e.name === f.entity).facts.push({ text: f.text, messages: f.messages });
    const out = await build({ messages, generate: replay([JSON.stringify(reply), ...recorded.slice(1)]), contextTokens: CONTEXT });
    return out;
}

/**
 * A claim checker that knows the truth: a claim is supported when it cites a
 * message that really says it. Counts how many claims it was asked about.
 */
function checker(truth, seen = []) {
    return async ({ user }) => {
        const claims = [...user.matchAll(/^C(\d+) · .* · cites ((?:#\d+(?:, )?)+): (.*)$/gm)];
        return JSON.stringify({
            claims: claims.map(([, n, cites, text]) => {
                seen.push({ text, cites: cites.split(', ').map((c) => Number(c.slice(1))) });
                const real = truth[text];
                const ok = real && cites.split(', ').some((c) => real.includes(Number(c.slice(1))));
                return { id: `C${n}`, why: '', verdict: ok ? 'supported' : 'unsupported' };
            }),
        });
    };
}
const TRUTH = { [MISCITED.text]: MISCITED.truly };
for (const e of extractJson(recorded[0]).entities) for (const f of e.facts) if (f.text !== MISCITED.text) TRUTH[f.text] ??= f.messages;

test('a true fact citing the wrong message gets a re-cite to the right one, beside drop; a false fact gets none', async () => {
    const { book, ledger } = await miscited();
    const record = await audit({ book, ledger, messages, generate: checker(TRUTH), contextTokens: CONTEXT });
    const claims = of(record.findings, 'claim');
    const mis = claims.find((f) => f.claim === MISCITED.text);
    assert.ok(mis, 'the mis-citation is flagged');
    assert.equal(mis.fix.op, 'drop-fact');
    assert.equal(mis.recite.op, 'recite');
    assert.deepEqual(mis.recite.messages, MISCITED.truly);
    // The planted false facts: flagged, nothing to re-cite to.
    for (const f of plant.falseFacts) {
        const hit = claims.find((x) => x.claim === f.text);
        assert.ok(hit, `not flagged: ${f.text}`);
        assert.equal(hit.recite, null);
        assert.equal(hit.fix.op, 'drop-fact');
    }
    assert.match(record.recites[claimId(mis.uids[0], MISCITED.text)].ids.join(), /12/);
});

test('accepting a re-cite updates the fact\'s provenance and nothing else, with no model call', async () => {
    const { book, ledger } = await miscited();
    const record = await audit({ book, ledger, messages, generate: checker(TRUTH), contextTokens: CONTEXT });
    const f = of(record.findings, 'claim').find((x) => x.claim === MISCITED.text);
    const before = structuredClone(book);
    const out = await accept({ book, ledger, messages, record, id: f.id, choice: 'recite' });
    assert.deepEqual(book, before, 'accept does not touch its inputs');
    const kesh = titled(out.book, MISCITED.entity);
    assert.deepEqual(kesh.canonkeeper.facts.find((x) => x.text === MISCITED.text).sources, [[12, 12]]);
    assert.deepEqual(out.ledger.entities.find((e) => e.uid === kesh.uid).facts.find((x) => x.text === MISCITED.text).messages, [12]);
    assert.ok(kesh.content.includes(MISCITED.text), 'the fact stays');
    assert.equal(out.writes.length, 1);
    // The next audit, with no model call, finds the fact supported and the queue without it.
    const next = await audit({ book: out.book, ledger: out.ledger, messages, previous: out.record });
    assert.ok(!of(next.findings, 'claim').some((x) => x.claim === MISCITED.text));
    assert.equal(next.verdicts[claimId(kesh.uid, MISCITED.text)].verdict, 'supported');
    // And a full re-check of the new book agrees.
    const again = await audit({ book: out.book, ledger: out.ledger, messages, generate: checker(TRUTH), contextTokens: CONTEXT, recheck: true });
    assert.ok(!of(again.findings, 'claim').some((x) => x.claim === MISCITED.text));
    const unchanged = await update({ book: out.book, ledger: out.ledger, messages, generate: noModel, contextTokens: CONTEXT });
    assert.deepEqual(unchanged.plan, []);
});

test('a suggestion that fails the claim check is never queued', async () => {
    const { book, ledger } = await miscited();
    // The checker finds the fact in no message at all, so the search has candidates and every one fails.
    const seen = [];
    const record = await audit({ book, ledger, messages, generate: checker({ ...TRUTH, [MISCITED.text]: [] }, seen), contextTokens: CONTEXT });
    const f = of(record.findings, 'claim').find((x) => x.claim === MISCITED.text);
    assert.ok(f, 'still flagged');
    assert.equal(f.recite, null);
    assert.ok(seen.filter((c) => c.text === MISCITED.text).length > 1, 'candidates were tried');
});

test('a re-cite search is kept with the verdict, and redone on a re-check', async () => {
    const { book, ledger } = await miscited();
    const first = await audit({ book, ledger, messages, generate: checker(TRUTH), contextTokens: CONTEXT, profile: 'a' });
    const seen = [];
    const again = await audit({ book, ledger, messages, generate: checker(TRUTH, seen), contextTokens: CONTEXT, previous: first, profile: 'a' });
    assert.equal(seen.length, 0);
    assert.deepEqual(of(again.findings, 'claim').map((f) => f.recite), of(first.findings, 'claim').map((f) => f.recite));
    const other = [];
    await audit({ book, ledger, messages, generate: checker(TRUTH, other), contextTokens: CONTEXT, previous: first, profile: 'b' });
    assert.ok(other.length > 0);
});

test('an entry the user edited gets no re-cite, as it gets no drop', async () => {
    const { book, ledger } = await miscited();
    titled(book, MISCITED.entity).content += ' Edited by hand.';
    const record = await audit({ book, ledger, messages, generate: checker(TRUTH), contextTokens: CONTEXT });
    const f = of(record.findings, 'claim').find((x) => x.claim === MISCITED.text);
    assert.equal(f.fix, null);
    assert.equal(f.recite, null);
});

test('in SillyTavern: Accept on a re-cite changes the fact\'s sources, is logged, and leaves the queue', async () => {
    const reply = extractJson(recorded[0]);
    reply.entities.find((e) => e.name === MISCITED.entity).facts.find((f) => f.text === MISCITED.text).messages = MISCITED.wrongly;
    const st = fakeST();
    st.generate = replay([JSON.stringify(reply), ...recorded.slice(1)]);
    const { bookName } = await runCanon(st);
    st.generate = checker(TRUTH);
    await runAudit(st);
    const f = st.metadata[STATE_KEY].audit.findings.find((x) => x.claim === MISCITED.text);
    assert.ok(f.recite && f.fix);
    st.generate = noModel;
    await acceptFinding(st, f.id, 'recite');
    const kesh = titled(st.books[bookName], MISCITED.entity);
    assert.deepEqual(kesh.canonkeeper.facts.find((x) => x.text === MISCITED.text).sources, [[12, 12]]);
    const after = st.metadata[STATE_KEY].audit;
    assert.match(after.accepted[0].says, /cite #12/);
    assert.ok(!after.findings.some((x) => x.claim === MISCITED.text));
    assert.ok(kesh.content.includes(MISCITED.text));
});

// ── fixing a flagged fact by hand ───────────────────────────────────────────

const REWORDED = 'Orders the watch to search every courier for the stolen charts.';
const HAND_TRUTH = { ...TRUTH, [REWORDED]: [12] };

async function flagged() {
    const { book, ledger } = await miscited();
    const record = await audit({ book, ledger, messages, generate: checker(HAND_TRUTH), contextTokens: CONTEXT });
    const f = of(record.findings, 'claim').find((x) => x.claim === MISCITED.text);
    return { book, ledger, record, f };
}

test('message lists a person types are read, and nonsense is refused', () => {
    assert.deepEqual(parseMessageList('12'), [12]);
    assert.deepEqual(parseMessageList('#14, 12-13 ; 12'), [12, 13, 14]);
    assert.throws(() => parseMessageList('twelve'), /not a message number/);
    assert.throws(() => parseMessageList('15-12'), /not a usable range/);
    assert.throws(() => parseMessageList('  '), /at least one/);
});

test('a flagged fact re-pointed by hand to the right message passes the check, is saved with no model call and verifies on the next audit', async () => {
    const { book, ledger, record, f } = await flagged();
    assert.deepEqual(f.hand.cites, MISCITED.wrongly);
    const checked = await checkHand({ messages, record, id: f.id, edit: { messages: [12] }, generate: checker(HAND_TRUTH), contextTokens: CONTEXT });
    assert.equal(checked.ok, true);
    const before = structuredClone(book);
    const out = await accept({ book, ledger, messages, record, id: f.id, choice: 'hand', edit: { messages: [12] }, checked });
    assert.deepEqual(book, before);
    const kesh = titled(out.book, MISCITED.entity);
    assert.deepEqual(kesh.canonkeeper.facts.find((x) => x.text === MISCITED.text).sources, [[12, 12]]);
    const next = await audit({ book: out.book, ledger: out.ledger, messages, previous: out.record });
    assert.ok(!of(next.findings, 'claim').some((x) => x.claim === MISCITED.text));
    const again = await audit({ book: out.book, ledger: out.ledger, messages, generate: checker(HAND_TRUTH), contextTokens: CONTEXT, recheck: true });
    assert.ok(!of(again.findings, 'claim').some((x) => x.claim === MISCITED.text));
});

test('a hand rewording the messages do not support is warned about before save, with the reason; saving anyway keeps it flagged', async () => {
    const { book, ledger, record, f } = await flagged();
    const wording = 'Orders the watch to burn every courier along with the charts.';
    const checked = await checkHand({ messages, record, id: f.id, edit: { text: wording }, generate: checker(HAND_TRUTH), contextTokens: CONTEXT });
    assert.equal(checked.ok, false);
    assert.equal(checked.verdict, 'unsupported');
    // Nothing was saved by the check.
    assert.equal(titled(book, MISCITED.entity).content.includes(wording), false);
    const out = await accept({ book, ledger, messages, record, id: f.id, choice: 'hand', edit: { text: wording }, checked });
    const kesh = titled(out.book, MISCITED.entity);
    assert.ok(kesh.content.includes(wording) && !kesh.content.includes(MISCITED.text));
    const next = await audit({ book: out.book, ledger: out.ledger, messages, previous: out.record });
    const still = of(next.findings, 'claim').find((x) => x.claim === wording);
    assert.ok(still, 'the unsupported wording stays flagged');
    assert.ok(!of(next.findings, 'claim').some((x) => x.claim === MISCITED.text));
});

test('a reworded fact and a picked message together are checked as one claim', async () => {
    const { record, f } = await flagged();
    const seen = [];
    const checked = await checkHand({ messages, record, id: f.id, edit: { text: REWORDED, messages: [12] }, generate: checker(HAND_TRUTH, seen), contextTokens: CONTEXT });
    assert.equal(checked.ok, true);
    assert.deepEqual(seen, [{ text: REWORDED, cites: [12] }]);
});

test('a hand edit that changes nothing, names no such message, or skips the check is refused', async () => {
    const { book, ledger, record, f } = await flagged();
    const generate = checker(HAND_TRUTH);
    await assert.rejects(checkHand({ messages, record, id: f.id, edit: {}, generate, contextTokens: CONTEXT }), /nothing was changed/);
    await assert.rejects(checkHand({ messages, record, id: f.id, edit: { messages: [9999] }, generate, contextTokens: CONTEXT }), /messages must be between/);
    await assert.rejects(checkHand({ messages, record, id: f.id, edit: { text: '  ' }, generate, contextTokens: CONTEXT }), /cannot be empty/);
    await assert.rejects(accept({ book, ledger, messages, record, id: f.id, choice: 'hand', edit: { messages: [12] } }), /claim check/);
});

test('an entry the user edited, or a stale audit, cannot be hand-fixed', async () => {
    const { book, ledger } = await miscited();
    titled(book, MISCITED.entity).content += ' Edited by hand.';
    const held = await audit({ book, ledger, messages, generate: checker(HAND_TRUTH), contextTokens: CONTEXT });
    const g = of(held.findings, 'claim').find((x) => x.claim === MISCITED.text);
    assert.equal(g.hand, null);
    const { book: b2, ledger: l2, record, f } = await flagged();
    const checked = { verdict: 'supported', why: '', profile: null };
    titled(b2, MISCITED.entity).content += ' Changed since.';
    await assert.rejects(accept({ book: b2, ledger: l2, messages, record, id: f.id, choice: 'hand', edit: { messages: [12] }, checked }), StaleAuditError);
});

test('in SillyTavern: a hand edit is checked, then saved and logged, and a failed check writes nothing until it is saved anyway', async () => {
    const reply = extractJson(recorded[0]);
    reply.entities.find((e) => e.name === MISCITED.entity).facts.find((f) => f.text === MISCITED.text).messages = MISCITED.wrongly;
    const st = fakeST();
    st.generate = replay([JSON.stringify(reply), ...recorded.slice(1)]);
    const { bookName } = await runCanon(st);
    st.generate = checker(HAND_TRUTH);
    await runAudit(st);
    const f = st.metadata[STATE_KEY].audit.findings.find((x) => x.claim === MISCITED.text);
    const bad = await checkFinding(st, f.id, { text: 'Orders the watch to burn every courier.' });
    assert.equal(bad.ok, false);
    assert.ok(titled(st.books[bookName], MISCITED.entity).content.includes(MISCITED.text), 'checking writes nothing');
    const good = await checkFinding(st, f.id, { messages: [12] });
    assert.equal(good.ok, true);
    st.generate = noModel;
    await acceptFinding(st, f.id, 'hand', { messages: [12] }, good);
    const after = st.metadata[STATE_KEY].audit;
    assert.match(after.accepted[0].says, /by hand: cited #12/);
    assert.ok(!after.findings.some((x) => x.claim === MISCITED.text));
});
