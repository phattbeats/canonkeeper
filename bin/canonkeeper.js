#!/usr/bin/env node
// Offline runner for the core. Writes a run directory the gate can score.
//
//   canonkeeper build <transcript.jsonl> --out <dir> [--model <id> | --replay <replies.json>] [--context <tokens>] [--output-share <0..1>]
//   canonkeeper pin   <dir> <entry title>          mark an entry as human-pinned in <dir>/book.json
//   canonkeeper rerun <transcript.jsonl> --run <dir> [--model <id> | --replay <replies.json>] [--context <tokens>]
//   canonkeeper update <transcript.jsonl> --run <dir> [--out <dir>] [--model <id> | --replay <replies.json>] [--context <tokens>] [--dry-run]
//   canonkeeper audit <transcript.jsonl> --run <dir> [--model <id> | --replay <replies.json>] [--context <tokens>] [--no-verify] [--recheck]
//   canonkeeper accept <transcript.jsonl> --run <dir> [--recite] <finding id>
//   canonkeeper dismiss <dir> <finding id>
//
// build writes book.json, scenes.json, ledger.json and replies.json (the raw
// model replies, replayable with --replay). rerun starts from <dir>/book.json
// and <dir>/ledger.json and writes only <dir>/rerun.json (the gate's I5/I6
// input). update brings the run directory itself up to date: it prints the
// plan, then rewrites book.json, scenes.json and ledger.json if anything
// changed, and saves the model's replies to update-replies.json. --out writes
// those to another directory and leaves the run as it was. --dry-run prints
// the plan and writes nothing.
//
// audit reads <dir>/book.json and <dir>/ledger.json, writes nothing to them,
// and writes <dir>/audit.json (the findings, the claims' verdicts and the
// review queue) and audit-replies.json. --no-verify runs only the technical
// pass, keeping verdicts from an earlier audit.json. accept applies one
// finding's fix to book.json (and ledger.json), then audits again with no
// model call; dismiss marks a finding dismissed.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseTranscript } from '../src/transcript.js';
import { build } from '../src/build.js';
import { update } from '../src/update.js';
import { describe } from '../src/plan.js';
import { audit, accept, dismiss, describeFinding, openFindings } from '../src/audit.js';
import { claudeCli } from '../src/models/claude-cli.js';
import { replay, recording } from '../src/models/replay.js';

const DEFAULT_CONTEXT = 200000;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

function parseArgs(argv) {
    const args = { _: [], context: DEFAULT_CONTEXT };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run') args.dir = argv[++i];
        else if (a === '--out') args.out = argv[++i];
        else if (a === '--model') args.model = argv[++i];
        else if (a === '--replay') args.replay = argv[++i];
        else if (a === '--context') args.context = Number(argv[++i]);
        else if (a === '--output-share') args.outputShare = Number(argv[++i]);
        else if (a === '--dry-run') args.dryRun = true;
        else if (a === '--no-verify') args.noVerify = true;
        else if (a === '--recheck') args.recheck = true;
        else if (a === '--recite') args.recite = true;
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
        args.dir = args.out ?? args.dir;
        if (!transcript || !args.dir) throw new Error('usage: canonkeeper build <transcript.jsonl> --out <dir>');
        const messages = parseTranscript(readFileSync(transcript, 'utf8'));
        const replies = [];
        const started = Date.now();
        mkdirSync(args.dir, { recursive: true });
        let out;
        try {
            out = await build({ messages, generate: recording(model(args), replies), contextTokens: args.context, outputShare: args.outputShare });
        } finally {
            // Kept even when the run fails, so a rejected reply can be inspected.
            writeJson(join(args.dir, 'replies.json'), replies);
        }
        writeJson(join(args.dir, 'book.json'), out.book);
        writeJson(join(args.dir, 'scenes.json'), out.scenes);
        writeJson(join(args.dir, 'ledger.json'), out.ledger);
        const n = Object.keys(out.book.entries).length;
        console.log(`built ${n} entries, ${out.scenes.boundaries.length} scene breaks, ${out.ledger.review.length} for review, ${replies.length} model call(s), ${((Date.now() - started) / 1000).toFixed(0)}s -> ${args.dir}`);
        const ck = out.ledger.chunked;
        if (ck) {
            console.log(`CHUNKED: the story didn't fit --context ${args.context}, so it was read in ${ck.parts.length} parts: ${ck.parts.map((p) => `${p.from}-${p.to}`).join(', ')}`);
            const r = ck.reconciliation;
            console.log(r.ran ? `  reconciliation merged ${r.merges.length}: ${r.merges.map((m) => `${m.same.join(' + ')} -> ${m.keep}`).join('; ') || 'none'}` : `  reconciliation skipped: ${r.reason}`);
        }
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

    if (cmd === 'rerun' || cmd === 'update') {
        const [transcript] = args._;
        if (!transcript || !args.dir) throw new Error(`usage: canonkeeper ${cmd} <transcript.jsonl> --run <dir>`);
        const messages = parseTranscript(readFileSync(transcript, 'utf8'));
        const replies = [];
        const out = await update({
            book: readJson(join(args.dir, 'book.json')),
            // No ledger: one full rebuild, holding pins and foreign entries.
            ledger: existsSync(join(args.dir, 'ledger.json')) ? readJson(join(args.dir, 'ledger.json')) : null,
            messages,
            generate: recording(model(args), replies),
            contextTokens: args.context,
            outputShare: args.outputShare,
        });
        console.log(`${out.plan.length} write(s), ${out.calls} model call(s), ${out.held.length} entr${out.held.length === 1 ? 'y' : 'ies'} held`);
        for (const line of describe(out.plan)) console.log(`  ${line}`);
        for (const h of out.held) console.log(`  held ${h.uid} '${h.title}': ${h.reason}`);
        if (cmd === 'rerun') {
            writeJson(join(args.dir, 'rerun.json'), out.book);
            return;
        }
        if (args.dryRun) return;
        const dest = args.out ?? args.dir;
        mkdirSync(dest, { recursive: true });
        if (replies.length) writeJson(join(dest, 'update-replies.json'), replies);
        if (dest === args.dir && !out.wrote && existsSync(join(args.dir, 'ledger.json')) && out.ledger.fingerprint === readJson(join(args.dir, 'ledger.json')).fingerprint) return;
        writeJson(join(dest, 'book.json'), out.book);
        writeJson(join(dest, 'scenes.json'), out.scenes);
        writeJson(join(dest, 'ledger.json'), out.ledger);
        return;
    }

    if (cmd === 'audit') {
        const [transcript] = args._;
        if (!transcript || !args.dir) throw new Error('usage: canonkeeper audit <transcript.jsonl> --run <dir>');
        const messages = parseTranscript(readFileSync(transcript, 'utf8'));
        const previous = existsSync(join(args.dir, 'audit.json')) ? readJson(join(args.dir, 'audit.json')) : null;
        const replies = [];
        const record = await audit({
            book: readJson(join(args.dir, 'book.json')),
            ledger: existsSync(join(args.dir, 'ledger.json')) ? readJson(join(args.dir, 'ledger.json')) : null,
            messages,
            generate: args.noVerify ? null : recording(model(args), replies),
            contextTokens: args.context,
            previous,
            profile: args.model ?? null,
            recheck: !!args.recheck,
        });
        if (replies.length) writeJson(join(args.dir, 'audit-replies.json'), replies);
        writeJson(join(args.dir, 'audit.json'), record);
        printAudit(record);
        return;
    }

    if (cmd === 'accept') {
        const [transcript, id] = args._;
        if (!transcript || !args.dir || !id) throw new Error('usage: canonkeeper accept <transcript.jsonl> --run <dir> [--recite] <finding id>');
        const messages = parseTranscript(readFileSync(transcript, 'utf8'));
        const ledgerPath = join(args.dir, 'ledger.json');
        const record = readJson(join(args.dir, 'audit.json'));
        const out = await accept({ book: readJson(join(args.dir, 'book.json')), ledger: existsSync(ledgerPath) ? readJson(ledgerPath) : null, messages, record, id, choice: args.recite ? 'recite' : 'fix' });
        for (const line of out.writes) console.log(`  ${line}`);
        writeJson(join(args.dir, 'book.json'), out.book);
        if (out.ledger) writeJson(ledgerPath, out.ledger);
        // The fix changed the book: the technical pass runs again, and the
        // claims' verdicts carry over.
        const next = await audit({ book: out.book, ledger: out.ledger, messages, previous: out.record });
        writeJson(join(args.dir, 'audit.json'), next);
        printAudit(next);
        return;
    }

    if (cmd === 'dismiss') {
        const [dir, id] = args._;
        if (!dir || !id) throw new Error('usage: canonkeeper dismiss <dir> <finding id>');
        writeJson(join(dir, 'audit.json'), dismiss(readJson(join(dir, 'audit.json')), id));
        console.log(`dismissed ${id}`);
        return;
    }

    throw new Error('usage: canonkeeper build|pin|rerun|update|audit|accept|dismiss ... (see the header of bin/canonkeeper.js)');
}

function printAudit(record) {
    const open = openFindings(record);
    const c = record.claims;
    console.log(`audit: ${open.length} open finding(s) (${open.filter((f) => f.severity === 'error').length} errors); claims ${c.checked} of ${c.total} verified, ${c.stale} stale, ${c.unchecked} unchecked; ${record.calls} model call(s)`);
    for (const f of record.findings) console.log(`  ${f.id}\n    ${describeFinding(f)}`);
}

main().catch((err) => {
    console.error(`canonkeeper: ${err.message}`);
    process.exit(1);
});
