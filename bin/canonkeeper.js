#!/usr/bin/env node
// Offline runner for the core. Writes a run directory the gate can score.
//
//   canonkeeper build <transcript.jsonl> --out <dir> [--model <id> | --replay <replies.json>] [--context <tokens>]
//   canonkeeper pin   <dir> <entry title>          mark an entry as human-pinned in <dir>/book.json
//   canonkeeper rerun <transcript.jsonl> --run <dir> [--model <id> | --replay <replies.json>] [--context <tokens>]
//
// build writes book.json, scenes.json, ledger.json and replies.json (the raw
// model replies, replayable with --replay). rerun starts from <dir>/book.json
// and <dir>/ledger.json and writes <dir>/rerun.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseTranscript } from '../src/transcript.js';
import { build, rerun } from '../src/build.js';
import { claudeCli } from '../src/models/claude-cli.js';
import { replay, recording } from '../src/models/replay.js';

const DEFAULT_CONTEXT = 200000;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

function parseArgs(argv) {
    const args = { _: [], context: DEFAULT_CONTEXT };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out' || a === '--run') args.dir = argv[++i];
        else if (a === '--model') args.model = argv[++i];
        else if (a === '--replay') args.replay = argv[++i];
        else if (a === '--context') args.context = Number(argv[++i]);
        else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
        else args._.push(a);
    }
    return args;
}

function model(args) {
    if (args.replay) return replay(readJson(args.replay));
    return claudeCli({ model: args.model });
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const args = parseArgs(rest);

    if (cmd === 'build') {
        const [transcript] = args._;
        if (!transcript || !args.dir) throw new Error('usage: canonkeeper build <transcript.jsonl> --out <dir>');
        const messages = parseTranscript(readFileSync(transcript, 'utf8'));
        const replies = [];
        const started = Date.now();
        mkdirSync(args.dir, { recursive: true });
        let out;
        try {
            out = await build({ messages, generate: recording(model(args), replies), contextTokens: args.context });
        } finally {
            // Kept even when the run fails, so a rejected reply can be inspected.
            writeJson(join(args.dir, 'replies.json'), replies);
        }
        writeJson(join(args.dir, 'book.json'), out.book);
        writeJson(join(args.dir, 'scenes.json'), out.scenes);
        writeJson(join(args.dir, 'ledger.json'), out.ledger);
        const n = Object.keys(out.book.entries).length;
        console.log(`built ${n} entries, ${out.scenes.boundaries.length} scene breaks, ${out.ledger.review.length} for review, ${replies.length} model call(s), ${((Date.now() - started) / 1000).toFixed(0)}s -> ${args.dir}`);
        for (const r of out.ledger.review) console.log(`  review: ${r.name}: ${r.reason}`);
        return;
    }

    if (cmd === 'pin') {
        const [dir, title] = args._;
        if (!dir || !title) throw new Error('usage: canonkeeper pin <dir> <entry title>');
        const book = readJson(join(dir, 'book.json'));
        const entry = Object.values(book.entries).find((e) => e.comment === title);
        if (!entry) throw new Error(`no entry titled '${title}'`);
        entry.canonkeeper.pinned = true;
        writeJson(join(dir, 'book.json'), book);
        console.log(`pinned uid ${entry.uid} '${title}'`);
        return;
    }

    if (cmd === 'rerun') {
        const [transcript] = args._;
        if (!transcript || !args.dir) throw new Error('usage: canonkeeper rerun <transcript.jsonl> --run <dir>');
        const messages = parseTranscript(readFileSync(transcript, 'utf8'));
        const out = await rerun({
            book: readJson(join(args.dir, 'book.json')),
            ledger: readJson(join(args.dir, 'ledger.json')),
            messages,
            generate: model(args),
            contextTokens: args.context,
        });
        writeJson(join(args.dir, 'rerun.json'), out.book);
        console.log(out.wrote ? 'transcript changed: rebuilt, pins kept' : 'transcript unchanged: nothing written');
        return;
    }

    throw new Error('usage: canonkeeper build|pin|rerun ... (see the header of bin/canonkeeper.js)');
}

main().catch((err) => {
    console.error(`canonkeeper: ${err.message}`);
    process.exit(1);
});
