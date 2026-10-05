#!/usr/bin/env node
// The acceptance gate. Runs the answer-key self-check, then I1–I6 and C7–C8,
// on one builder run against one transcript. With --edits it also runs E9 on
// every edit fixture, and a run without output for one is a fixture error.
// With --chunked (a run on a window too small for the story) it also runs
// K10 on the run's ledger.json. The step 4 bar for a chunked run is the
// invariants plus K10, so C7 and C8 are then scored and shown but don't gate.
// With --live (a session from harness/live-sim.js) it also runs L11 on the
// run's live.json. The step 5 bar is the invariants, C8 on the scene starts
// the detector found, and L11. The live book only covers the scenes that have
// ended, so C7 is scored and shown but doesn't gate.
// With --audit, the run directory is an audit run (see loadAudit) and the
// gate runs only A12 and A13: the step 6 bar.
// With --books, the chat had other active lorebooks (see loadOthers): B14
// runs, and I1 and C7 score the chat's book and the others together, so an
// entity another book covers counts as found, and once.
// With --extras, the run directory is an extras run (see loadExtras) and the
// gate runs only X15 and X16: the step 7 bar.
//
//   node harness/gate.js [--story fixtures/story] [--run fixtures/story/reference] [--edits] [--chunked] [--live] [--audit] [--books] [--extras] [--json]
//
// Exit codes: 0 every check green · 1 at least one check red ·
//             2 fixtures missing or malformed (never a pass)

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTranscript, loadAnswerKey, loadRun, loadEdits, loadLedger, loadLive, loadAudit, loadOthers, loadExtras, FixtureError } from './load.js';
import {
    validateAnswerKey,
    checkI1KeywordCollisions,
    checkI2ZeroKeyEntries,
    checkI3OverbroadKeys,
    checkI4Provenance,
    checkI5ZeroWritesOnRerun,
    checkI6PinsSurvive,
    scoreC7Coverage,
    scoreC8Boundaries,
    checkE9EditLocality,
    checkK10Chunked,
    checkL11Live,
    checkA12AuditCatches,
    checkA13AuditQuiet,
    checkB14OtherBooks,
    checkX15Recall,
    checkX16Clip,
} from './checks.js';

export function runGate({ storyDir, runDir, edits = false, chunked = false, live = false, audit = false, books = false, extras = false }) {
    const messages = loadTranscript(join(storyDir, 'transcript.jsonl'));
    const key = loadAnswerKey(join(storyDir, 'answer-key.json'));

    const keyCheck = validateAnswerKey(key, messages);
    if (!keyCheck.ok) throw new FixtureError(`answer key failed its own validation:\n  - ${keyCheck.problems.join('\n  - ')}`);

    if (audit) {
        const a = loadAudit(runDir);
        const checks = [checkA12AuditCatches(a.planted), checkA13AuditQuiet(a.clean)];
        return { ok: checks.every((c) => c.ok), messages: messages.length, entries: a.planted.book.length, checks };
    }
    if (extras) {
        const x = loadExtras(runDir);
        const checks = [checkX15Recall(x), checkX16Clip(x)];
        return { ok: checks.every((c) => c.ok), messages: messages.length, entries: Object.keys(JSON.parse(x.clip.working.bookAfter).entries).length, checks };
    }
    const run = loadRun(runDir);
    const others = books ? loadOthers(runDir) : [];
    const all = [...run.book, ...others.flatMap((b) => b.entries)];

    const checks = [
        checkI1KeywordCollisions(all),
        checkI2ZeroKeyEntries(run.book),
        checkI3OverbroadKeys(run.book, messages),
        checkI4Provenance(run.book, messages),
        checkI5ZeroWritesOnRerun(run.book, run.rerun),
        checkI6PinsSurvive(run.book, run.rerun),
        { ...scoreC7Coverage(all, key, messages), ...(chunked || live ? { gates: false } : {}) },
        { ...scoreC8Boundaries(run.boundaries, key.boundaries), ...(chunked ? { gates: false } : {}) },
    ];
    if (books) checks.push(checkB14OtherBooks(run.book, others));
    if (chunked) checks.push(checkK10Chunked(loadLedger(runDir), messages.length));
    if (live) checks.push(checkL11Live(loadLive(runDir), messages.length));
    if (edits) {
        for (const e of loadEdits(storyDir, runDir)) checks.push({ ...checkE9EditLocality(run.book, e.book, messages, e.transcript, key.boundaries), edit: e.name });
    }
    return { ok: checks.every((c) => c.ok || c.gates === false), messages: messages.length, entries: run.book.length, checks };
}

function parseArgs(argv) {
    const args = { story: 'fixtures/story', run: null, edits: false, chunked: false, live: false, audit: false, books: false, extras: false, json: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--story') args.story = argv[++i];
        else if (argv[i] === '--run') args.run = argv[++i];
        else if (argv[i] === '--json') args.json = true;
        else if (argv[i] === '--edits') args.edits = true;
        else if (argv[i] === '--chunked') args.chunked = true;
        else if (argv[i] === '--live') args.live = true;
        else if (argv[i] === '--audit') args.audit = true;
        else if (argv[i] === '--books') args.books = true;
        else if (argv[i] === '--extras') args.extras = true;
        else throw new FixtureError(`unknown argument: ${argv[i]}`);
    }
    args.run ??= join(args.story, 'reference');
    return args;
}

function main() {
    let report;
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
        report = runGate({ storyDir: resolve(args.story), runDir: resolve(args.run), edits: args.edits, chunked: args.chunked, live: args.live, audit: args.audit, books: args.books, extras: args.extras });
    } catch (err) {
        if (!(err instanceof FixtureError)) throw err;
        console.error(`FIXTURE ERROR: ${err.message}`);
        process.exit(2);
    }
    if (args.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`run ${args.run}: ${report.entries} entries, ${report.messages} messages`);
        for (const c of report.checks) {
            console.log(`  ${c.ok ? 'PASS' : c.gates === false ? 'INFO' : 'FAIL'}  ${c.id}  ${c.name}${c.edit ? ` (${c.edit})` : ''}`);
            if (!c.ok) console.log(`        ${JSON.stringify(c.detail)}`);
        }
        console.log(report.ok ? 'GATE GREEN' : 'GATE RED');
    }
    process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
