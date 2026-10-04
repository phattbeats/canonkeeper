#!/usr/bin/env node
// Recall against a hand-curated lorebook, for real chats that have a human-
// built book but no answer key (the gate's answer-key format needs decoys,
// planted cases and boundaries a real chat doesn't come with).
//
//   node harness/compare.js --reference <book.json> --built <book.json> [--json]
//
// A reference entry counts as found when a built entry shares one of its
// names: its title (split on ',' and '/', parentheses dropped) or one of its
// keys, compared after `fold`. Names are matched, wording never is.
// Unmatched entries are listed so a human can rule on near-misses; the exit
// code is 0 only when every reference entry is found.

import { readFileSync } from 'node:fs';
import { fold } from './checks.js';

export function referenceNames(entry) {
    const title = String(entry.comment ?? '').replace(/\([^)]*\)/g, '');
    return new Set([...title.split(/[,/]/), ...(entry.key ?? [])].map(fold).filter(Boolean));
}

export function compareBooks(reference, built) {
    const builtEntries = Object.values(built.entries).filter((e) => !e.disable);
    const builtNames = builtEntries.map((e) => ({ uid: e.uid, title: e.comment, names: new Set([e.comment, ...(e.key ?? [])].map(fold)) }));
    const found = [];
    const missed = [];
    for (const r of Object.values(reference.entries)) {
        const names = referenceNames(r);
        const hits = builtNames.filter((b) => [...b.names].some((n) => names.has(n)));
        if (hits.length) found.push({ reference: r.comment, built: hits.map((h) => h.title) });
        else missed.push({ reference: r.comment, names: [...names] });
    }
    const matched = new Set(found.flatMap((f) => f.built));
    const unmatchedBuilt = builtNames.filter((b) => !matched.has(b.title)).map((b) => b.title);
    const total = found.length + missed.length;
    return { total, found: found.length, recall: total ? found.length / total : 0, missed, matches: found, unmatchedBuilt, builtCount: builtEntries.length };
}

function main() {
    const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]]] : acc), []));
    if (!args.reference || !args.built) {
        console.error('usage: node harness/compare.js --reference <book.json> --built <book.json> [--json]');
        process.exit(2);
    }
    const report = compareBooks(JSON.parse(readFileSync(args.reference, 'utf8')), JSON.parse(readFileSync(args.built, 'utf8')));
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
        console.log(`reference recall ${report.found}/${report.total} (${(report.recall * 100).toFixed(1)}%), built ${report.builtCount} entries`);
        for (const m of report.missed) console.log(`  MISSED  ${m.reference}   names: ${m.names.join(' | ')}`);
        console.log(`  built entries matching no reference entry (${report.unmatchedBuilt.length}): ${report.unmatchedBuilt.join('; ')}`);
    }
    process.exit(report.missed.length ? 1 : 0);
}

if (process.argv[1]?.endsWith('compare.js')) main();
