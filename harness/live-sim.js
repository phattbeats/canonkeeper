#!/usr/bin/env node
// Live mode, offline: a chat written one message at a time. Each message is
// appended to a fake SillyTavern chat and the adapter's own tick (runLive) is
// run, exactly as the extension runs it on every new message. At the end the
// session is written as a run directory the gate can score with --live.
//
//   node harness/live-sim.js <transcript.jsonl> --out <dir>
//        [--detect-model <id>] [--model <id>] | [--replay <dir>]
//        [--cadence 4] [--detect-context 32000] [--context 200000] [--detect-only]
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

    const started = Date.now();
    try {
        for (const message of chat) {
            st.chat.push(message);
            const cycle = await runLive(st);
            if (!cycle) continue;
            const d = cycle.detection;
            const u = cycle.update;
            const said = [
                d && (d.ok ? `detect ${d.judged.join('-')} -> ${d.starts.join(',') || 'none'}` : `detect FAILED: ${d.error}`),
                u && (u.ok ? `update through ${u.through}: ${u.writes} writes, ${u.calls} call(s)` : `update FAILED: ${u.error}`),
            ].filter(Boolean);
            console.log(`[${String(st.chat.length).padStart(3)}] ${said.join('; ') || (cycle.seeded != null ? 'seeded' : 'rewound')}`);
        }
    } finally {
        writeJson(join(args.out, 'detect-replies.json'), detectReplies);
        writeJson(join(args.out, 'write-replies.json'), writeReplies);
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
