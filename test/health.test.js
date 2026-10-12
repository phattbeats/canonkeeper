// Health (PHA-4224): every live failure path is recorded in the chat's state,
// raises a sticky notice once per new kind, shows while it lasts and clears at
// the next success. The adapter's tick runs against the same fake
// SillyTavern as live.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runLive, noteHealth, profileGenerate, STATE_KEY } from '../adapter/run.js';
import { record, explain, classify, severity, unhealthy, stalled, stallAfter, noteStall, emptyHealth, HISTORY_KEPT, TimeoutError } from '../src/health.js';
import { buildDetectPrompt, readStarts, detectRange, seed, rewind, updateTarget } from '../src/live.js';
import { ModelOutputError } from '../src/parse.js';
import { fingerprint, messageHash } from '../src/fingerprint.js';
import { parseTranscript } from '../src/transcript.js';
import { replay } from '../src/models/replay.js';
import { checkL11Live } from '../harness/checks.js';

const STORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'story');
const lines = readFileSync(join(STORY, 'transcript.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
const chat = lines.slice(1).map((l) => JSON.parse(l));
const answerKey = JSON.parse(readFileSync(join(STORY, 'answer-key.json'), 'utf8'));

/** The ids a prompt asks about: <new from=".." to="..">. */
const asked = (user) => {
    const m = user.match(/<new from="(\d+)" to="(\d+)">/);
    return [Number(m[1]), Number(m[2])];
};

/** A detector that knows the answer key: reports the true starts it is shown. */
function oracle(calls = []) {
    return async ({ user }) => {
        const [from, to] = asked(user);
        calls.push([from, to]);
        return JSON.stringify({ starts: answerKey.boundaries.filter((b) => b >= from && b <= to) });
    };
}

/** A writer that reports one entity citing the last message it was shown. */
function writer(calls = []) {
    return async ({ user }) => {
        const ids = [...user.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
        calls.push(ids);
        const last = Math.max(...ids);
        return JSON.stringify({ scenes: [], entities: [{ name: 'Wren', keys: ['Wren'], facts: [{ text: `Wren was about at ${last}.`, messages: [last] }], caseSensitive: false, cascade: true, throttle: 0 }] });
    };
}

function fakeST({ detectGenerate, generate, cadence = 4, metadata = {} }) {
    const st = {
        chatId: 'live',
        chat: [],
        metadata,
        books: {},
        writes: 0,
        saves: 0,
        open: 'live',
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
        saveMetadata: async () => {
            st.saves++;
        },
        generate,
        detectGenerate,
        settings: { contextTokens: 200000, maxOutputTokens: 64000, cadence, detectContextTokens: 32000 },
    };
    return st;
}

/** Writes the story into the fake chat one message at a time, ticking after each. */
async function play(st, upTo = chat.length) {
    const cycles = [];
    for (const m of chat.slice(st.chat.length, upTo)) {
        st.chat.push(structuredClone(m));
        const c = await runLive(st);
        if (c) cycles.push(c);
    }
    return cycles;
}


const healthOf = (st) => st.metadata[STATE_KEY].health;
const failing = (st) => Object.keys(healthOf(st)?.failing ?? {});

test('a dead detector: recorded, one notice, badge on, and it clears at the next success', async () => {
    const st = fakeST({ detectGenerate: async () => { throw new Error('Request failed with status 401: invalid x-api-key'); }, generate: writer() });
    const told = [];
    st.notify = (e) => told.push(...e);
    st.detectProfile = { name: 'Sonnet' };
    await play(st, 11);
    const h = healthOf(st);
    assert.deepEqual(failing(st), ['detector']);
    assert.ok(unhealthy(h));
    assert.equal(severity(h), 'red');
    assert.equal(h.lastFailure.kind, 'detector');
    assert.match(h.lastFailure.cause, /profile Sonnet was refused/i);
    assert.match(h.lastFailure.fix, /API key/);
    // Several retries, one notice.
    assert.ok(h.consecutive >= 2);
    assert.equal(told.length, 1);
    st.detectGenerate = oracle();
    await play(st, 30);
    assert.deepEqual(failing(st), []);
    assert.equal(unhealthy(healthOf(st)), false);
    assert.equal(healthOf(st).consecutive, 0);
    assert.equal(healthOf(st).lastSuccess.kind !== undefined, true);
    // The history stays after it clears.
    assert.ok(healthOf(st).history.length >= 2);
    assert.equal(told.length, 1);
});

test('a failed update is recorded with its cause, and clears when the update works', async () => {
    const st = fakeST({ detectGenerate: oracle(), generate: async () => { throw new Error('429 rate limit exceeded'); } });
    const told = [];
    st.notify = (e) => told.push(...e);
    await play(st, 13);
    assert.deepEqual(failing(st), ['update']);
    assert.match(healthOf(st).failing.update.cause, /rate or spending limit/);
    assert.equal(told.length, 1);
    st.generate = writer();
    await play(st, 30);
    assert.deepEqual(failing(st), []);
});

test('a failed audit after an update is recorded on its own', async () => {
    const st = fakeST({ detectGenerate: oracle(), generate: writer() });
    st.auditGenerate = async () => { throw new Error('503 overloaded'); };
    st.auditProfile = { id: 'aud', name: 'Haiku' };
    const told = [];
    st.notify = (e) => told.push(...e);
    // The audit's own book read fails once the update has written.
    const load = st.loadBook;
    st.loadBook = async (name) => {
        if (st.writes > 0 && st.failAudit !== false) throw new Error('503 overloaded');
        return load(name);
    };
    await play(st, 13);
    assert.ok(failing(st).includes('audit'), failing(st).join());
    assert.equal(told.filter((t) => t.step === 'audit').length, 1);
});

test('no profile picked: recorded, noticed once, cleared when a tick runs', () => {
    const st = { metadata: {}, notify: (e) => told.push(...e) };
    const told = [];
    const fail = [{ where: 'profile', kind: 'profile', ok: false, error: 'no connection profile is picked' }];
    noteHealth(st, fail);
    noteHealth(st, fail);
    noteHealth(st, fail);
    assert.equal(told.length, 1);
    assert.equal(severity(st.metadata[STATE_KEY].health), 'red');
    assert.match(told[0].fix, /Pick a connection profile/);
    noteHealth(st, [{ where: 'profile', kind: 'profile', ok: true }]);
    assert.equal(unhealthy(st.metadata[STATE_KEY].health), false);
});

test('a model that never answers times out, and that is its own kind', async () => {
    const hang = profileGenerate({ send: () => new Promise(() => {}), extract: () => '', profileId: 'p', timeoutMs: 30 });
    await assert.rejects(hang({ system: 's', user: 'u', maxTokens: 10 }), (err) => err instanceof TimeoutError && /did not answer within/.test(err.message));
    const st = fakeST({ detectGenerate: async () => { throw new TimeoutError(120); }, generate: writer() });
    const told = [];
    st.notify = (e) => told.push(...e);
    await play(st, 7);
    assert.equal(healthOf(st).failing.detector.kind, 'timeout');
    assert.equal(severity(healthOf(st)), 'amber');
    assert.match(healthOf(st).failing.detector.fix, /faster model|server/);
    assert.equal(told.length, 1);
    // A different kind on the same step is a new notice.
    st.detectGenerate = async () => { throw new Error('401 unauthorized'); };
    await play(st, 12);
    assert.equal(told.length, 2);
    assert.equal(healthOf(st).failing.detector.kind, 'detector');
});

test('a book that changed under the update is a stale abort, and is noticed', async () => {
    const st = fakeST({ detectGenerate: oracle(), generate: writer() });
    const gen = st.generate;
    st.generate = async (req) => {
        const out = await gen(req);
        st.books[Object.keys(st.books)[0] ?? 'x'] = { entries: { 1: { uid: 1, comment: 'someone', key: ['a'], content: 'c' } } };
        return out;
    };
    const told = [];
    st.notify = (e) => told.push(...e);
    await play(st, 13);
    assert.equal(healthOf(st).failing.update?.kind, 'stale', JSON.stringify(healthOf(st)));
    assert.match(told[0].cause, /edited while the update was running/);
});

test('an error thrown out of the tick is recorded like any other', () => {
    const st = { metadata: {} };
    noteHealth(st, [{ where: 'tick', kind: 'tick', ok: false, error: new Error('boom') }]);
    assert.equal(st.metadata[STATE_KEY].health.failing.tick.error, 'boom');
});

test('live mode stalls when messages pile up unjudged, noticed once, cleared when caught up', async () => {
    assert.equal(stallAfter(4), 13);
    const st = fakeST({ detectGenerate: async () => 'not json', generate: writer() });
    const told = [];
    st.notify = (e) => told.push(...e);
    // Ticks with no call due (a retry is waiting) must still notice the stall.
    await play(st, 40);
    assert.ok(failing(st).includes('stalled'));
    assert.equal(told.filter((t) => t.kind === 'stalled').length, 1);
    assert.match(healthOf(st).failing.stalled.cause, /Live mode has stalled/);
    st.detectGenerate = oracle();
    await play(st, 60);
    assert.ok(!failing(st).includes('stalled'));
    assert.equal(healthOf(st).stalledNotified, false);
});

test('the history keeps the last ten, and a healthy chat has no health record', async () => {
    let h = emptyHealth();
    for (let i = 0; i < 15; i++) h = record(h, [{ where: 'update', kind: 'update', ok: false, error: `e${i}` }]).health;
    assert.equal(h.history.length, HISTORY_KEPT);
    assert.equal(h.history.at(-1).error, 'e14');
    assert.equal(h.failing.update.count, 15);
    const st = fakeST({ detectGenerate: oracle(), generate: writer() });
    await play(st, 30);
    assert.equal(failing(st).length, 0);
    assert.equal(healthOf(st)?.history?.length ?? 0, 0);
});

test('explain: plain causes and fixes for the failures people meet', () => {
    assert.match(explain('update', '401 Unauthorized', 'Sonnet').fix, /API key/);
    assert.match(explain('update', 'fetch failed').cause, /could not be reached/);
    assert.match(explain('update', 'model: claude-x not found').fix, /pick a model/);
    assert.match(explain('detector', 'reply needs a \'starts\' array').fix, /capable model/);
    assert.match(explain('audit', 'something odd').cause, /something odd/);
    assert.equal(classify('update', new Error('the lorebook changed during the run; nothing was written')), 'stale');
    assert.equal(classify('detector', new TimeoutError(5)), 'timeout');
});

test('noteStall: not stalled leaves the record untouched', () => {
    const h = emptyHealth();
    assert.equal(noteStall(h, false).health, h);
    assert.equal(stalled(null, 100, 4), false);
});
