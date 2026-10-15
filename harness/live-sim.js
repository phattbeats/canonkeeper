#!/usr/bin/env node
// Live mode, offline: a chat written one message at a time. Each message is
// appended to a fake SillyTavern chat and the adapter's own tick (runLive) is
// run, exactly as the extension runs it on every new message. At the end the
// session is written as a run directory the gate can score with --live.
//
//   node harness/live-sim.js <transcript.jsonl> --out <dir>
//        [--detect-model <id>] [--model <id>] | [--replay <dir>]
//        [--cadence 4] [--detect-context 32000] [--context 200000] [--detect-only]
//        [--audit-model <id>] [--plant-at <n> [--plant new|steal]] [--dismiss]
//
// --audit-model turns on the claim check of the live audit (without it, each
// update gets the technical pass only). --plant-at puts a key collision in the
// book after message n, as a human would: `new` is two hand-made entries on
// one new key, `steal` is one hand-made entry on a key of an entry Canonkeeper
// wrote. --dismiss dismisses the planted collision once it is queued, to show
// it stays dismissed. The claim lines each audit call was shown go to
// audit-calls.json, and the plant and every audit after it to plant.json.
//
// --detect-only measures the detector alone: the writer is a stub that finds
// nothing, so the updates still fire but make no real call.
//
// The run directory holds book.json (the book live mode kept), scenes.json
// (the scene starts the detector found), ledger.json, live.json (the state
// store: every cycle, every call count), rerun.json (the book re-run on the
// finished scenes with two entries pinned, for I5/I6), and the replies of
// both models, which --replay plays back with no model.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { runLive, STATE_KEY } from '../adapter/run.js';
import { update } from '../src/update.js';
import { claudeCli } from '../src/models/claude-cli.js';
import { replay, recording } from '../src/models/replay.js';
import { DEFAULT_CADENCE } from '../src/live.js';
import { dismissFinding } from '../adapter/run.js';
import { claimsOf } from '../src/audit.js';

const PLANTED = [900, 901];

/** A key collision, made by hand in the book: see --plant. */
function plantCollision(book, how) {
    const entries = Object.values(book.entries);
    if (how === 'steal') {
        const victim = entries.find((e) => e.canonkeeper && !e.constant && (e.key ?? []).length);
        if (!victim) return null;
        const key = victim.key[0];
        book.entries[PLANTED[0]] = { uid: PLANTED[0], key: [key], keysecondary: [], comment: `Planted ${PLANTED[0]}`, content: 'A human wrote this.', constant: false, disable: false };
        return { how, key, uids: [PLANTED[0], victim.uid], victim: victim.uid };
    }
    for (const uid of PLANTED) book.entries[uid] = { uid, key: ['Zedwin Varrocks'], keysecondary: [], comment: `Planted ${uid}`, content: 'A human wrote this.', constant: false, disable: false };
    return { how: 'new', key: 'Zedwin Varrocks', uids: [...PLANTED] };
}

/** The claim lines (title · cites: text) an audit request showed the model. */
const claimLines = (user) => [...user.matchAll(/^C\d+ · (.*)$/gm)].map((m) => m[1]);

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

function parseArgs(argv) {
    const args = { _: [], cadence: DEFAULT_CADENCE, detectContext: 32000, context: 200000, model: 'claude-sonnet-5', detectModel: 'claude-haiku-4-5-20251001' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') args.out = argv[++i];
        else if (a === '--model') args.model = argv[++i];
        else if (a === '--detect-model') args.detectModel = argv[++i];
        else if (a === '--replay') args.replay = argv[++i];
        else if (a === '--cadence') args.cadence = Number(argv[++i]);
        else if (a === '--detect-context') args.detectContext = Number(argv[++i]);
        else if (a === '--context') args.context = Number(argv[++i]);
        else if (a === '--detect-only') args.detectOnly = true;
        else if (a === '--audit-model') args.auditModel = argv[++i];
        else if (a === '--plant-at') args.plantAt = Number(argv[++i]);
        else if (a === '--plant') args.plant = argv[++i];
        else if (a === '--dismiss') args.dismiss = true;
        else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
        else args._.push(a);
    }
    return args;
}

/** A SillyTavern with one chat and one lorebook, as plain objects. */
function fakeST({ generate, detectGenerate, settings }) {
    const st = {
        chatId: 'live-session',
        chat: [],
        metadata: {},
        books: {},
        currentChatId: () => st.chatId,
        bookExists: async (name) => name in st.books,
        loadBook: async (name) => structuredClone(st.books[name] ?? { entries: {} }),
        saveBook: async (name, data) => {
            st.books[name] = structuredClone(data);
        },
        createBook: async (name) => {
            st.books[name] = { entries: {} };
        },
        saveMetadata: async () => {},
        generate,
        detectGenerate,
        settings,
        profile: { id: 'sim', name: 'live-sim', model: null },
    };
    return st;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const [transcript] = args._;
    if (!transcript || !args.out) throw new Error('usage: live-sim.js <transcript.jsonl> --out <dir>');
    const chat = readFileSync(transcript, 'utf8').split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l));
    mkdirSync(args.out, { recursive: true });

    const detectReplies = [];
    const writeReplies = [];
    const detectModel = args.replay ? replay(readJson(join(args.replay, 'detect-replies.json'))) : claudeCli({ model: args.detectModel });
    const writeModel = args.detectOnly ? async () => '{"scenes": [], "entities": []}'
        : args.replay ? replay(readJson(join(args.replay, 'write-replies.json'))) : claudeCli({ model: args.model });
    const settings = { contextTokens: args.context, maxOutputTokens: 64000, cadence: args.cadence, detectContextTokens: args.detectContext };
    const st = fakeST({ generate: recording(writeModel, writeReplies), detectGenerate: recording(detectModel, detectReplies), settings });
    const auditCalls = [];
    if (args.auditModel) {
        const auditModel = args.replay ? replay(readJson(join(args.replay, 'audit-replies.json'))) : claudeCli({ model: args.auditModel });
        const auditReplies = [];
        const rec = recording(auditModel, auditReplies);
        st.auditGenerate = async (req) => {
            // A line citing what its fact cites is a claim check; any other is a re-cite try.
            const state = st.metadata[STATE_KEY];
            const messages = st.chat.map((m, id) => ({ id, name: String(m.name ?? ''), isUser: !!m.is_user, text: m.mes }));
            const own = new Set(claimsOf({ book: st.books[state.book], ledger: state.ledger, messages }).claims.map((c) => `${c.title} · cites ${c.ids.map((id) => `#${id}`).join(', ')}: ${c.text}`));
            const lines = claimLines(req.user);
            const call = { at: st.chat.length, lines, kinds: lines.map((l) => (own.has(l) ? 'verify' : 'recite')) };
            auditCalls.push(call);
            const t = Date.now();
            try {
                return await rec(req);
            } finally {
                call.ms = Date.now() - t;
                writeJson(join(args.out, 'audit-replies.json'), auditReplies);
            }
        };
        st.auditProfile = { id: `sim-audit:${args.auditModel}`, name: 'live-sim audit', model: args.auditModel };
    }
    const plant = args.plantAt ? { at: null, wanted: args.plantAt, audits: [] } : null;

    const started = Date.now();
    try {
        for (const message of chat) {
            st.chat.push(message);
            const cycle = await runLive(st);
            const bookName = st.metadata[STATE_KEY]?.book;
            if (plant && plant.at == null && st.chat.length >= plant.wanted && bookName && st.books[bookName]) {
                Object.assign(plant, plantCollision(st.books[bookName], args.plant ?? 'new'), { at: st.chat.length });
                console.log(`[${String(st.chat.length).padStart(3)}] planted a '${plant.how}' collision on '${plant.key}'`);
            } else if (plant?.at != null && cycle?.audit) {
                const a = st.metadata[STATE_KEY].audit;
                const f = a.findings.find((x) => x.check === 'collision' && plant.uids.every((u) => x.uids.includes(u)));
                const book = st.books[bookName];
                plant.audits.push({ at: st.chat.length, audit: cycle.audit, finding: f ? { id: f.id, dismissed: !!f.dismissed, message: f.message } : null, plantedIntact: plant.uids.filter((u) => u >= 900).every((u) => book.entries[u]?.key?.includes(plant.key)), victimKeeps: plant.victim == null ? null : !!book.entries[plant.victim]?.key?.includes(plant.key), victimExists: plant.victim == null ? null : !!book.entries[plant.victim] });
                if (args.dismiss && f && !f.dismissed && !plant.dismissedAt) {
                    await dismissFinding(st, f.id);
                    plant.dismissedAt = st.chat.length;
                    console.log(`[${String(st.chat.length).padStart(3)}] dismissed ${f.id}`);
                }
            }
            if (!cycle) continue;
            const d = cycle.detection;
            const u = cycle.update;
            const said = [
                d && (d.ok ? `detect ${d.judged.join('-')} -> ${d.starts.join(',') || 'none'}` : `detect FAILED: ${d.error}`),
                u && (u.ok ? `update through ${u.through}: ${u.writes} writes, ${u.calls} call(s)` : `update FAILED: ${u.error}`),
                cycle.audit && (cycle.audit.ok ? `audit: ${cycle.audit.findings} open, ${cycle.audit.checked} checked, ${cycle.audit.reused} reused, ${cycle.audit.calls} call(s)` : `audit FAILED: ${cycle.audit.error}`),
            ].filter(Boolean);
            console.log(`[${String(st.chat.length).padStart(3)}] ${said.join('; ') || (cycle.seeded != null ? 'seeded' : 'rewound')}`);
        }
    } finally {
        writeJson(join(args.out, 'detect-replies.json'), detectReplies);
        writeJson(join(args.out, 'write-replies.json'), writeReplies);
        writeJson(join(args.out, 'audit-calls.json'), auditCalls);
        if (plant) writeJson(join(args.out, 'plant.json'), plant);
        if (st.metadata[STATE_KEY]?.audit) writeJson(join(args.out, 'audit.json'), st.metadata[STATE_KEY].audit);
    }

    const state = st.metadata[STATE_KEY];
    if (args.detectOnly) {
        writeJson(join(args.out, 'live.json'), { cadence: args.cadence, messageCount: chat.length, ...state.live });
        console.log(`${chat.length} messages, cadence ${args.cadence}: ${state.live.detectCalls} detection calls; scene starts: ${state.live.starts.join(', ')}`);
        return;
    }
    const book = st.books[state.book];
    writeJson(join(args.out, 'book.json'), book);
    writeJson(join(args.out, 'ledger.json'), state.ledger);
    writeJson(join(args.out, 'scenes.json'), { boundaries: state.live.starts });
    writeJson(join(args.out, 'live.json'), { cadence: args.cadence, messageCount: chat.length, ...state.live });

    // I5/I6: pin two entries as a user would, then re-run on the same
    // finished scenes. No model call may be needed and nothing may change.
    const pinned = structuredClone(book);
    const titles = Object.values(pinned.entries).slice(0, 2).map((e) => ((e.canonkeeper.pinned = true), e.comment));
    writeJson(join(args.out, 'book.json'), pinned);
    const rerun = await update({
        book: pinned,
        ledger: state.ledger,
        messages: st.chat.slice(0, state.ledger.messageCount).map((m, id) => ({ id, name: String(m.name ?? ''), isUser: !!m.is_user, text: m.mes })),
        generate: async () => {
            throw new Error('the re-run on unchanged scenes made a model call');
        },
        contextTokens: args.context,
        starts: state.live.starts,
    });
    writeJson(join(args.out, 'rerun.json'), rerun.book);

    const live = state.live;
    console.log(`${chat.length} messages, cadence ${args.cadence}: ${live.detectCalls} detection calls, ${live.updates} updates (${writeReplies.length} writer calls), ${live.cycles.length} cycles, ${((Date.now() - started) / 1000).toFixed(0)}s`);
    console.log(`scene starts: ${live.starts.join(', ')}`);
    console.log(`book: ${Object.keys(book.entries).length} entries through message ${state.ledger.messageCount - 1}; pinned for the re-run: ${titles.join(', ')}`);
}

main().catch((err) => {
    console.error(`live-sim: ${err.stack ?? err.message}`);
    process.exit(1);
});
