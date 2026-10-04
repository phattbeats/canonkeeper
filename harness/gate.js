#!/usr/bin/env node
// The acceptance gate. Runs the answer-key self-check, then I1–I6 and C7–C8,
// on one builder run against one transcript.
//
//   node harness/gate.js [--story fixtures/story] [--run fixtures/story/reference] [--json]
//
// Exit codes: 0 every check green · 1 at least one check red ·
//             2 fixtures missing or malformed (never a pass)

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTranscript, loadAnswerKey, loadRun, FixtureError } from './load.js';
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
} from './checks.js';

export function runGate({ storyDir, runDir }) {
    const messages = loadTranscript(join(storyDir, 'transcript.jsonl'));
    const key = loadAnswerKey(join(storyDir, 'answer-key.json'));
    const run = loadRun(runDir);

    const keyCheck = validateAnswerKey(key, messages);
    if (!keyCheck.ok) throw new FixtureError(`answer key failed its own validation:\n  - ${keyCheck.problems.join('\n  - ')}`);

    const checks = [
        checkI1KeywordCollisions(run.book),
        checkI2ZeroKeyEntries(run.book),
        checkI3OverbroadKeys(run.book, messages),
        checkI4Provenance(run.book, messages),
        checkI5ZeroWritesOnRerun(run.book, run.rerun),
        checkI6PinsSurvive(run.book, run.rerun),
        scoreC7Coverage(run.book, key, messages),
        scoreC8Boundaries(run.boundaries, key.boundaries),
    ];
    return { ok: checks.every((c) => c.ok), messages: messages.length, entries: run.book.length, checks };
}

function parseArgs(argv) {
    const args = { story: 'fixtures/story', run: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--story') args.story = argv[++i];
        else if (argv[i] === '--run') args.run = argv[++i];
        else if (argv[i] === '--json') args.json = true;
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
        report = runGate({ storyDir: resolve(args.story), runDir: resolve(args.run) });
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
            console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.name}`);
            if (!c.ok) console.log(`        ${JSON.stringify(c.detail)}`);
        }
        console.log(report.ok ? 'GATE GREEN' : 'GATE RED');
    }
    process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
