// Live mode (build step 5): detection on a cadence, the update on a scene
// end, the state store, and the L11 check that has to be able to fail. The
// adapter's own tick (runLive) runs against a fake SillyTavern, one message
// at a time, as the extension runs it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runLive, runCanon, STATE_KEY } from '../adapter/run.js';
import { buildDetectPrompt, readStarts, detectRange, seed, rewind, updateTarget } from '../src/live.js';
import { ModelOutputError } from '../src/parse.js';
import { fingerprint, messageHash } from '../src/fingerprint.js';
import { parseTranscript } from '../src/transcript.js';
import { replay } from '../src/models/replay.js';
import { checkL11Live } from '../harness/checks.js';

const STORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'story');
const lines = readFileSync(join(STORY, 'transcript.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
const chat = lines.slice(1).map((l) => JSON.parse(l));
const messages = parseTranscript(lines.join('\n'));
const recorded = JSON.parse(readFileSync(join(STORY, 'recorded', 'replies.json'), 'utf8'));
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

test('N messages make about N/cadence detection calls, not N', async () => {
    for (const cadence of [1, 4, 7]) {
        const calls = [];
        const st = fakeST({ detectGenerate: oracle(calls), generate: writer(), cadence });
        await play(st);
        // The newest message is look-ahead, so N messages leave N - 1 to judge.
        assert.equal(calls.length, Math.floor((chat.length - 1) / cadence), `cadence ${cadence}`);
        // Every message judged once, in order, with no gap and no overlap.
        assert.deepEqual(calls.map(([f]) => f), calls.map((_, i) => i * cadence));
        assert.ok(calls.every(([f, t]) => t - f + 1 === cadence));
        const live = st.metadata[STATE_KEY].live;
        assert.equal(live.detectCalls, calls.length);
        assert.equal(checkL11Live({ cadence, ...live }, chat.length).ok, true);
    }
});

test('each scene end triggers one update, of the finished scenes only', async () => {
    const writes = [];
    const st = fakeST({ detectGenerate: oracle(), generate: writer(writes) });
    const cycles = await play(st);
    const updates = cycles.filter((c) => c.update).map((c) => c.update);
    assert.deepEqual(updates.map((u) => u.through), answerKey.boundaries.map((b) => b - 1));
    assert.ok(updates.every((u) => u.ok && u.calls === 1));
    // The first update builds from the start; each later one reads only the
    // scene that just ended, never the open one.
    assert.deepEqual(writes[0], [...Array(10).keys()]);
    for (let i = 1; i < writes.length; i++) {
        const from = answerKey.boundaries[i - 1];
        const to = answerKey.boundaries[i] - 1;
        assert.deepEqual(writes[i], Array.from({ length: to - from + 1 }, (_, k) => from + k), `update ${i}`);
    }
    const state = st.metadata[STATE_KEY];
    assert.deepEqual(state.ledger.scenes, answerKey.boundaries.slice(0, -1));
    assert.equal(state.ledger.messageCount, 71);
    assert.equal(state.lastRun.trigger, 'live');
    assert.equal(state.live.updates, answerKey.boundaries.length);
    assert.equal(checkL11Live({ cadence: 4, ...state.live }, chat.length).ok, true);
});

test('a tick with nothing due makes no call and saves nothing', async () => {
    const st = fakeST({ detectGenerate: oracle(), generate: writer() });
    await play(st, 5);
    const saves = st.saves;
    st.detectGenerate = async () => assert.fail('no detection due');
    st.generate = async () => assert.fail('no update due');
    assert.equal(await runLive(st), null);
    st.chat.push(structuredClone(chat[5]));
    assert.equal(await runLive(st), null);
    assert.equal(st.saves, saves);
});

test('a failed detection is tried again after another cadence of messages, not on every message', async () => {
    let calls = 0;
    const st = fakeST({ detectGenerate: async () => (calls++, 'not json'), generate: writer() });
    const cycles = await play(st, 11);
    // Two tries per attempt (one retry), at 5 and 9 messages: never at 6, 7, 8.
    assert.equal(calls, 4);
    assert.deepEqual(cycles.filter((c) => c.detection).map((c) => [c.messages, c.detection.ok]), [[5, false], [9, false]]);
    st.detectGenerate = oracle();
    await play(st, 12);
    assert.equal(st.metadata[STATE_KEY].live.hashes.length, 0);
    await play(st, 13);
    assert.deepEqual(st.metadata[STATE_KEY].live.starts, [10]);
    assert.equal(st.metadata[STATE_KEY].live.hashes.length, 12);
});

test('a failed update is recorded, nothing is written, and it is tried again later', async () => {
    const st = fakeST({ detectGenerate: oracle(), generate: async () => 'not json' });
    const cycles = await play(st, 13);
    const failed = cycles.find((c) => c.update);
    assert.equal(failed.update.ok, false);
    assert.equal(st.writes, 0);
    st.generate = async () => assert.fail('not retried on the very next message');
    await play(st, 16);
    st.generate = writer();
    await play(st, 17);
    assert.equal(st.metadata[STATE_KEY].ledger.messageCount, 10);
    assert.ok(st.writes > 0);
});

test('an edited message is judged again, and so is everything after it', async () => {
    const st = fakeST({ detectGenerate: oracle(), generate: writer() });
    await play(st, 25);
    assert.deepEqual(st.metadata[STATE_KEY].live.starts, [10, 20]);
    st.chat[15].mes = 'Tamsin says something else entirely.';
    const calls = [];
    st.detectGenerate = oracle(calls);
    const cycle = await runLive(st);
    assert.equal(cycle.rewound, 15);
    assert.deepEqual(calls, [[15, 23]]);
    // Message 15 sits in a finished scene, so the book follows the edit.
    assert.equal(cycle.update.through, 19);
    assert.deepEqual(st.metadata[STATE_KEY].live.starts, [10, 20]);
});

test('switching chats mid-tick leaves the state store alone', async () => {
    const st = fakeST({ detectGenerate: oracle(), generate: writer() });
    await play(st, 8);
    const before = structuredClone(st.metadata[STATE_KEY]);
    const detect = oracle();
    st.detectGenerate = async (req) => {
        st.open = 'another';
        return detect(req);
    };
    for (const m of chat.slice(8, 12)) st.chat.push(structuredClone(m));
    assert.equal(await runLive(st), null);
    assert.deepEqual(st.metadata[STATE_KEY], before);
    assert.equal(st.writes, 0);
});

test('after a /canon run, live mode carries on from its ledger', async () => {
    const st = fakeST({ detectGenerate: oracle(), generate: replay(recorded) });
    st.chat = structuredClone(chat);
    await runCanon(st);
    const ledger = st.metadata[STATE_KEY].ledger;
    st.detectGenerate = async () => assert.fail('nothing new to judge');
    st.generate = async () => assert.fail('the ledger already covers the chat');
    const cycle = await runLive(st);
    assert.equal(cycle.seeded, chat.length);
    assert.equal(cycle.detection, undefined);
    assert.equal(cycle.update, undefined);
    assert.deepEqual(st.metadata[STATE_KEY].live.starts, ledger.scenes);
});

test('the detector sees the open scene as context, and nothing before it', () => {
    const live = { ...seed(null, []), hashes: messages.slice(0, 24).map(() => 'x'), starts: [10, 20] };
    const range = detectRange(live, messages.slice(0, 29), { cadence: 4, input: 30000 });
    assert.deepEqual(range, { contextFrom: 20, judgeFrom: 24, to: 27 });
    const p = buildDetectPrompt(messages.slice(0, 29), range);
    assert.match(p.user, /<scene_so_far from="20" to="23">/);
    assert.match(p.user, /<new from="24" to="27">/);
    // The newest message is shown after them, to see where the story goes.
    assert.match(p.user, /<next>\n#28 /);
    assert.doesNotMatch(p.user, /#19 /);
    // A small window: the new messages come first, the context gets what's left.
    const tight = detectRange(live, messages.slice(0, 29), { cadence: 4, input: 1200 });
    assert.equal(tight.judgeFrom, 24);
    assert.ok(tight.to >= 24 && tight.contextFrom > 20);
    // Fewer than `cadence` waiting besides the newest: no call.
    assert.equal(detectRange(live, messages.slice(0, 28), { cadence: 4, input: 30000 }), null);
});

test('the detector reply is strict, and ids outside what it judged are ignored', () => {
    assert.deepEqual(readStarts('{"starts": [12, 9, 15, 12, "x"]}', 10, 14).starts, [12]);
    assert.deepEqual(readStarts('{"starts": []}', 0, 3).starts, []);
    assert.deepEqual(readStarts('{"starts": [{"id": 12, "skips": "the night"}, {"id": 30, "skips": "x"}]}', 10, 14).starts, [12]);
    assert.deepEqual(readStarts('{"starts": [0]}', 0, 3).starts, []);
    assert.throws(() => readStarts('no', 0, 3), ModelOutputError);
    assert.throws(() => readStarts('{"scenes": []}', 0, 3), ModelOutputError);
});

test('rewind keeps what is unchanged and drops what came after a change', () => {
    const live = { ...seed(null, []), hashes: messages.slice(0, 30).map(messageHash), starts: [10, 20] };
    assert.equal(rewind(live, messages).rewound, null);
    const edited = messages.map((m) => (m.id === 15 ? { ...m, text: 'changed' } : m));
    const r = rewind(live, edited);
    assert.equal(r.rewound, 15);
    assert.equal(r.live.hashes.length, 15);
    assert.deepEqual(r.live.starts, [10]);
    // Seeding from a ledger: only one that is an unchanged start of the chat.
    const ledger = { hashes: messages.slice(0, 30).map(messageHash), scenes: [10, 20] };
    assert.deepEqual(seed(ledger, messages).starts, [10, 20]);
    assert.equal(seed(ledger, messages).hashes.length, 30);
    assert.equal(seed(ledger, edited).hashes.length, 0);
    assert.deepEqual(seed(ledger, edited).starts, []);
});

test('the update target is the end of the last finished scene, once', () => {
    const live = { ...seed(null, []), starts: [10, 20] };
    assert.equal(updateTarget(live, null, messages), 20);
    const ledger = { messageCount: 20, fingerprint: fingerprint(messages.slice(0, 20)) };
    assert.equal(updateTarget(live, ledger, messages), 0);
    // A /canon run that read the open scene too: nothing to do until a new scene ends.
    const canon = { messageCount: 25, fingerprint: fingerprint(messages.slice(0, 25)) };
    assert.equal(updateTarget(live, canon, messages), 0);
    assert.equal(updateTarget({ ...live, starts: [10, 20, 30] }, canon, messages), 30);
});

test('L11 goes red on per-message detection, on no updates, and on no cycles', () => {
    const live = { cadence: 4, detectCalls: 81, hashes: Array(81).fill('x'), starts: [10], cycles: [{ update: { ok: true, through: 9 } }] };
    assert.equal(checkL11Live(live, 81).ok, false);
    assert.equal(checkL11Live({ ...live, detectCalls: 20 }, 81).ok, true);
    assert.equal(checkL11Live({ ...live, detectCalls: 20, cycles: [{ detection: { ok: true } }] }, 81).ok, false);
    assert.equal(checkL11Live({ ...live, detectCalls: 20, cycles: [{ update: { ok: true, through: 12 } }] }, 81).ok, false);
    assert.equal(checkL11Live({ ...live, detectCalls: 20, hashes: Array(40).fill('x') }, 81).ok, false);
    assert.equal(checkL11Live({ cadence: 4, cycles: [] }, 81).ok, false);
    assert.equal(checkL11Live(null, 81).ok, false);
});
