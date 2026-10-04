#!/usr/bin/env node
// Live acceptance for the one-shot build: n fresh runs of a real model on the
// fixture story, each built, pinned, re-run and gated as `npm run build:story`
// does (without the edit fixtures), then a tally. One model call is
// stochastic, so a live pass is k of n green runs, not one.
//
//   node harness/live-runs.js [--model claude-sonnet-5] [--n 10] [--pass 8] [--jobs 3] [--out .run/live-runs/<model>] [--json]
//
// Each run directory is <out>/<i>; the summary is <out>/summary.json.
// Exit codes: 0 at least --pass runs green · 1 fewer

import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runGate } from './gate.js';
import { fold } from './checks.js';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const cli = join(root, 'bin/canonkeeper.js');
const story = join(root, 'fixtures/story');
const transcript = join(story, 'transcript.jsonl');

function sh(args) {
    return new Promise((ok, fail) => {
        const p = spawn(process.execPath, [cli, ...args], { cwd: root });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (out += d));
        p.on('close', (code) => (code === 0 ? ok(out.trim()) : fail(new Error(`canonkeeper ${args[0]} exited ${code}: ${out.trim()}`))));
    });
}

/** The pin the CI run uses, under whatever title this run gave it. */
function pinTitle(dir) {
    const book = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8'));
    const titles = Object.values(book.entries).map((e) => e.comment);
    return titles.find((t) => fold(t) === fold('Brother Saul')) ?? titles.find((t) => fold(t).includes('saul')) ?? titles[0];
}

async function one(model, dir) {
    const started = Date.now();
    try {
        await sh(['build', transcript, '--out', dir, '--model', model]);
        await sh(['pin', dir, pinTitle(dir)]);
        await sh(['rerun', transcript, '--run', dir]);
        const g = runGate({ storyDir: story, runDir: dir });
        const c7 = g.checks.find((c) => c.id === 'C7').detail;
        const c8 = g.checks.find((c) => c.id === 'C8').detail;
        const scenes = JSON.parse(readFileSync(join(dir, 'scenes.json'), 'utf8')).boundaries;
        return {
            dir,
            ok: g.ok,
            red: g.checks.filter((c) => !c.ok && c.gates !== false).map((c) => c.id),
            entries: g.entries,
            missed: c7.missed,
            extra: c7.extra.map((e) => e.title),
            precision: c7.precision,
            boundaries: scenes,
            boundaryMisses: c8.unmatchedExpected ?? [],
            seconds: Math.round((Date.now() - started) / 1000),
        };
    } catch (e) {
        return { dir, ok: false, red: ['ERROR'], error: e.message.slice(0, 500), seconds: Math.round((Date.now() - started) / 1000) };
    }
}

function parseArgs(argv) {
    const args = { model: 'claude-sonnet-5', n: 10, pass: 8, jobs: 3, out: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--model') args.model = argv[++i];
        else if (a === '--n') args.n = Number(argv[++i]);
        else if (a === '--pass') args.pass = Number(argv[++i]);
        else if (a === '--jobs') args.jobs = Number(argv[++i]);
        else if (a === '--out') args.out = argv[++i];
        else if (a === '--json') args.json = true;
        else throw new Error(`unknown option ${a}`);
    }
    args.out ??= join('.run/live-runs', args.model);
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    mkdirSync(args.out, { recursive: true });
    const runs = [];
    let next = 1;
    const worker = async () => {
        while (next <= args.n) {
            const i = next++;
            const r = await one(args.model, join(args.out, String(i)));
            runs[i - 1] = r;
            if (!args.json) console.log(`run ${i}: ${r.ok ? 'green' : `red ${r.red.join(',')}`}${r.missed?.length ? ` · missed ${r.missed.join(', ')}` : ''}${r.extra?.length ? ` · extra ${r.extra.join(', ')}` : ''}${r.boundaries ? ` · scenes ${r.boundaries.join(' ')}` : ''}${r.error ? ` · ${r.error}` : ''} (${r.seconds}s)`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(args.jobs, args.n) }, worker));
    const green = runs.filter((r) => r.ok).length;
    const summary = { model: args.model, n: args.n, pass: args.pass, green, ok: green >= args.pass, runs };
    writeFileSync(join(args.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else console.log(`${args.model}: ${green} of ${args.n} green, pass needs ${args.pass} -> ${summary.ok ? 'PASS' : 'FAIL'}`);
    process.exit(summary.ok ? 0 : 1);
}

main().catch((e) => {
    console.error(e.message);
    process.exit(2);
});
