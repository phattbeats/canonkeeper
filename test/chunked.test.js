// The chunked fallback (build step 4): a story too long for the window is
// read in parts with one ledger carried across them, then reconciled once.
// The model is replaced by canned replies, plus the replies recorded from a
// real chunked run of the fixture story on a window too small for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { parseTranscript } from '../src/transcript.js';
import { build } from '../src/build.js';
import { update } from '../src/update.js';
import { TooLongError } from '../src/budget.js';
import { readMerges, ModelOutputError } from '../src/parse.js';
import { replay } from '../src/models/replay.js';
import { runGate } from '../harness/gate.js';
import { checkK10Chunked } from '../harness/checks.js';

const STORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'story');
const messages = parseTranscript(readFileSync(join(STORY, 'transcript.jsonl'), 'utf8'));
const recorded = JSON.parse(readFileSync(join(STORY, 'chunked', 'replies.json'), 'utf8'));
const oneShot = JSON.parse(readFileSync(join(STORY, 'recorded', 'replies.json'), 'utf8'));
// The window the recorded run used: the story needs ~7.7k prompt tokens in the story and ~14k with the instructions for deep entries.
const SMALL = { contextTokens: 15400, outputShare: 0.5 };

const titled = (book, name) => Object.values(book.entries).find((e) => e.comment === name);
const reply = (entities, scenes = []) =>
    JSON.stringify({ scenes: scenes.map((start) => ({ start })), entities: entities.map((e) => ({ caseSensitive: false, cascade: true, throttle: 0, ...e })) });
const merges = (list) => JSON.stringify({ merges: list });

/** A generate that answers part prompts from `parts` in order, and the reconciliation with `rec`. */
function scripted(parts, rec = merges([])) {
    const prompts = [];
    const queue = [...parts];
    const generate = async (req) => {
        prompts.push(req);
        if (req.system.startsWith('You check a lorebook')) return rec;
        const r = queue.shift();
        return typeof r === 'function' ? r(req) : r;
    };
    return { generate, prompts };
}

/** The [from, to] of a part prompt. */
const partOf = (req) => req.user.match(/<part from="(\d+)" to="(\d+)">/).slice(1).map(Number);

// ── a story that doesn't fit is read in parts ──────────────────────────────

test('a story that fits makes one call and is not flagged', async () => {
    const out = await build({ messages, generate: replay(oneShot), contextTokens: 200000 });
    assert.equal(out.ledger.chunked, undefined);
});

test('a story that does not fit is read in parts that cover every message once, each prompt within the window', async () => {
    const { generate, prompts } = scripted(Array.from({ length: 10 }, () => (req) => {
        const [from] = partOf(req);
        return reply([{ name: 'Mora Quill', keys: ['Mora Quill'], facts: [{ text: `Seen from ${from}.`, messages: [from] }] }]);
    }));
    const out = await build({ messages, generate, ...SMALL });
    const parts = out.ledger.chunked.parts;
    assert.ok(parts.length >= 2);
    assert.equal(parts[0].from, 0);
    for (let i = 1; i < parts.length; i++) assert.equal(parts[i].from, parts[i - 1].to + 1);
    assert.equal(parts.at(-1).to, messages.length - 1);
    const input = SMALL.contextTokens * (1 - SMALL.outputShare);
    for (const p of parts) assert.ok(p.promptEstimate <= input, `part ${p.part}: ${p.promptEstimate} > ${input}`);
    assert.equal(prompts.filter((p) => p.user.includes('<part ')).length, parts.length);
    assert.equal(out.ledger.chunked.calls, prompts.length);
});

test('the ledger is carried across parts: a later part sees what earlier parts found', async () => {
    const { generate, prompts } = scripted([
        reply([{ name: 'Mora Quill', keys: ['Mora Quill'], facts: [{ text: 'Captain of the Gull.', messages: [2] }] }]),
        (req) => reply([{ name: 'Mora Quill', keys: ['Quill'], facts: [{ text: 'Sails at dawn.', messages: [partOf(req)[0]] }] }]),
        (req) => reply([], [partOf(req)[0] + 1]),
        reply([]),
    ]);
    const out = await build({ messages, generate, ...SMALL });
    assert.match(prompts[0].user, /<known_entities>\n\(none yet\)/);
    assert.match(prompts[1].user, /- Mora Quill \(keys: Mora Quill\)\n {2}kept: Captain of the Gull\./);
    assert.match(prompts[1].user, /<context from="\d+" to="\d+">/, 'the previous part ends the next one as context');
    const mora = out.ledger.entities.find((e) => e.name === 'Mora Quill');
    assert.deepEqual(mora.facts.map((f) => f.text), ['Captain of the Gull.', 'Sails at dawn.']);
    assert.deepEqual(mora.keys, ['Mora Quill', 'Quill']);
    assert.equal(Object.values(out.book.entries).filter((e) => e.comment === 'Mora Quill').length, 1);
});

test('a fact citing messages outside its part is left out, for review', async () => {
    const { generate } = scripted([
        reply([{ name: 'Saltgate', keys: ['Saltgate'], facts: [{ text: 'A port.', messages: [0] }, { text: 'Burned later.', messages: [79] }] }]),
        reply([]),
        reply([]),
    ]);
    const out = await build({ messages, generate, ...SMALL });
    const saltgate = out.ledger.entities.find((e) => e.name === 'Saltgate');
    assert.deepEqual(saltgate.facts.map((f) => f.text), ['A port.']);
    assert.ok(out.ledger.review.some((r) => r.name === 'Saltgate' && /outside part/.test(r.reason)));
});

test('a part decides scene starts from its second message through the next part\'s first, never its own first', async () => {
    const { generate, prompts } = scripted([
        (req) => reply([{ name: 'Saltgate', keys: ['Saltgate'], facts: [{ text: 'A port.', messages: [0] }] }], [10, partOf(req)[1] + 1, partOf(req)[1] + 5]),
        (req) => reply([], [partOf(req)[0], partOf(req)[0] + 1]),
        reply([]),
    ]);
    const out = await build({ messages, generate, ...SMALL });
    const [a, b] = out.ledger.chunked.parts;
    assert.match(prompts[0].user, new RegExp(`<next_part_starts>\\n#${a.to + 1} `));
    assert.deepEqual(out.scenes.boundaries.slice(0, 3), [10, b.from, b.from + 1]);
});

test('a part whose last scene starts past its first third hands that scene to the next part', async () => {
    const { generate, prompts } = scripted([
        (req) => {
            const [, to] = partOf(req);
            return reply([
                { name: 'Saltgate', keys: ['Saltgate'], facts: [{ text: 'A port.', messages: [0] }] },
                { name: 'Wren', keys: ['Wren'], facts: [{ text: 'Late in the part.', messages: [to - 3] }] },
            ], [10, to - 5]);
        },
        reply([]),
        reply([]),
        reply([]),
    ]);
    const out = await build({ messages, generate, ...SMALL });
    const [a, b] = out.ledger.chunked.parts;
    assert.equal(a.read, partOf(prompts[0])[1], 'the part records how far it read');
    assert.equal(b.from, a.read - 5, 'the next part starts at the handed-over scene');
    assert.equal(a.to, b.from - 1);
    assert.deepEqual(out.scenes.boundaries, [10, b.from]);
    assert.equal(out.ledger.entities.find((e) => e.name === 'Wren'), undefined, 'its facts are the next part\'s to report');
    assert.ok(!out.ledger.review.some((r) => r.name === 'Wren'), 'and are not a problem');
});

test('a window too small for even one message beside the prompt is refused before any call', async () => {
    let called = false;
    await assert.rejects(build({ messages, generate: async () => ((called = true), ''), contextTokens: 1500 }), TooLongError);
    assert.equal(called, false);
});

// ── the reconciliation pass ────────────────────────────────────────────────

test('reconciliation merges an epithet from an early part into the name from a later one', async () => {
    const { generate, prompts } = scripted(
        [
            reply([{ name: 'the cartographer', keys: ['the cartographer'], facts: [{ text: 'Draws the chart.', messages: [3] }] }]),
            (req) => reply([{ name: 'Ines Vell', keys: ['Ines Vell'], facts: [{ text: 'Named at last.', messages: [65] }] }]),
            reply([]),
        ],
        merges([{ keep: 'Ines Vell', same: ['the cartographer'] }]),
    );
    const out = await build({ messages, generate, ...SMALL });
    const rec = prompts.at(-1);
    assert.match(rec.user, /- the cartographer \(keys: the cartographer\)/);
    assert.ok(rec.maxTokens <= 8000, 'the reconciliation has a budget of its own');
    const ines = titled(out.book, 'Ines Vell');
    assert.ok(ines.key.some((k) => /cartographer/.test(k)));
    assert.deepEqual(ines.canonkeeper.facts.map((f) => f.text), ['Named at last.', 'Draws the chart.']);
    assert.equal(titled(out.book, 'the cartographer'), undefined);
    assert.deepEqual(out.ledger.chunked.reconciliation.merges, [{ keep: 'Ines Vell', same: ['the cartographer'] }]);
});

test('a merge naming an unlisted entity, or one entity twice, is not applied', () => {
    const listed = [{ name: 'Ines Vell', keys: [] }, { name: 'the cartographer', keys: [] }, { name: 'Mora Quill', keys: ['Captain Quill'] }];
    const r = readMerges(merges([
        { keep: 'Ines Vell', same: ['the cartographer'] },
        { keep: 'Mora Quill', same: ['the cartographer'] },
        { keep: 'Oren Hale', same: ['Mora Quill'] },
        { keep: 'Mora Quill', same: ['Captain Quill'] }, // her own key: merges nothing, not a problem
    ]), listed);
    assert.deepEqual(r.merges, [{ keep: 'Ines Vell', same: ['the cartographer'] }]);
    assert.equal(r.review.length, 2);
    assert.throws(() => readMerges('{"merged": []}', listed), ModelOutputError);
});

test('a part that names an entity known by an epithet renames it, keeping the epithet as a key', async () => {
    const { generate } = scripted([
        reply([{ name: 'the cartographer', keys: ['the cartographer'], facts: [{ text: 'Draws the chart.', messages: [3] }] }]),
        (req) => reply([{ name: 'Ines Vell', keys: ['Ines Vell', 'the cartographer'], facts: [{ text: 'Named at last.', messages: [65] }] }]),
        reply([]),
    ]);
    const out = await build({ messages, generate, ...SMALL });
    const ines = titled(out.book, 'Ines Vell');
    assert.deepEqual(ines.canonkeeper.facts.map((f) => f.text), ['Draws the chart.', 'Named at last.']);
    assert.ok(ines.key.some((k) => /cartographer/.test(k)));
    assert.equal(titled(out.book, 'the cartographer'), undefined);
    assert.deepEqual(out.ledger.chunked.renamed, [{ from: 'the cartographer', to: 'Ines Vell' }]);
});

test('a reconciliation reply that is not JSON gets one retry, then the run fails', async () => {
    const parts = [reply([{ name: 'Saltgate', keys: ['Saltgate'], facts: [{ text: 'A port.', messages: [0] }] }, { name: 'Mora Quill', keys: ['Mora Quill'], facts: [{ text: 'A captain.', messages: [2] }] }]), reply([]), reply([])];
    let n = 0;
    const flaky = scripted(parts, 'not json');
    await assert.rejects(build({ messages, generate: flaky.generate, ...SMALL }), ModelOutputError);
    const once = scripted(parts);
    const generate = async (req) => (req.system.startsWith('You check a lorebook') && n++ === 0 ? 'not json' : once.generate(req));
    const out = await build({ messages, generate, ...SMALL });
    assert.equal(out.ledger.chunked.reconciliation.ran, true);
});

// ── the recorded run: same invariants, flagged as chunked ──────────────────

test('the recorded chunked run passes I1–I6 and is flagged as chunked (K10)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canonkeeper-chunked-'));
    const first = await build({ messages, generate: replay(recorded), ...SMALL });
    assert.ok(first.ledger.chunked.parts.length >= 2);
    titled(first.book, 'Brother Saul').canonkeeper.pinned = true;
    const again = await update({ book: first.book, ledger: first.ledger, messages, generate: async () => assert.fail('no call'), ...SMALL });
    assert.equal(again.calls, 0);
    assert.equal(again.plan.length, 0);
    assert.deepEqual(again.ledger.chunked, first.ledger.chunked, 'a re-run keeps the flag');
    writeFileSync(join(dir, 'book.json'), JSON.stringify(first.book));
    writeFileSync(join(dir, 'rerun.json'), JSON.stringify(again.book));
    writeFileSync(join(dir, 'scenes.json'), JSON.stringify(first.scenes));
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify(first.ledger));
    const report = runGate({ storyDir: STORY, runDir: dir, chunked: true });
    for (const c of report.checks.filter((x) => x.gates !== false)) assert.equal(c.ok, true, `${c.id}: ${JSON.stringify(c.detail)}`);
    assert.equal(report.ok, true);
    // The planted miss, read across the cut: one entry, under her name.
    const ines = titled(first.book, 'Ines Vell');
    assert.ok(ines.key.some((k) => /cartographer/.test(k)));
    assert.ok(!ines.key.includes('I'), 'a pronoun is never a key');
});

test('K10 is red on a one-shot ledger, a gap between parts, or a missing reconciliation', async () => {
    const one = await build({ messages, generate: replay(oneShot), contextTokens: 200000 });
    assert.equal(checkK10Chunked(one.ledger, messages.length).ok, false);
    const parts = [{ part: 1, from: 0, to: 40 }, { part: 2, from: 41, to: 80 }];
    const rec = { ran: true, merges: [] };
    assert.equal(checkK10Chunked({ chunked: { parts, reconciliation: rec } }, 81).ok, true);
    assert.equal(checkK10Chunked({ chunked: { parts: [parts[0], { ...parts[1], from: 42 }], reconciliation: rec } }, 81).ok, false);
    assert.equal(checkK10Chunked({ chunked: { parts: [parts[0]], reconciliation: rec } }, 41).ok, false);
    assert.equal(checkK10Chunked({ chunked: { parts } }, 81).ok, false);
});
