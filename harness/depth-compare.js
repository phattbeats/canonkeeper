#!/usr/bin/env node
// Side-by-side of two lorebooks built from one chat: entry length, quotes,
// scene entries and keys per entry. For judging whether a build got deeper.
//
//   node harness/depth-compare.js <transcript.jsonl> <before-book.json> <after-book.json> [--md]
//
// A quote is a stretch of 3+ words in double quotes in the entry's text that
// is word for word in some message of the chat. It is counted from the text,
// not from Canonkeeper's own record, so books of either age are scored the
// same way.

import { readFileSync } from 'node:fs';
import { loadTranscript, loadBook } from './load.js';
import { entryKeyRegex } from '../src/match.js';

const flat = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ');

export function stats(book, messages) {
    const text = messages.map((m) => flat(m.text)).join('\n');
    const rows = book.map((e) => {
        const quoted = [...flat(e.content).matchAll(/"([^"]{8,}?)"/g)].map((m) => m[1].trim().replace(/[,.;]$/, '')).filter((q) => q.split(' ').length >= 3);
        const verified = new Set(quoted.filter((q) => text.includes(q)));
        const redundant = e.keys.filter((k) => e.keys.some((j) => j !== k && j.toLowerCase() !== k.toLowerCase() && entryKeyRegex(j, e.raw).test(k)));
        return { title: e.title, chars: e.content.length, quotes: verified.size, unverified: quoted.length - [...quoted].filter((q) => text.includes(q)).length, keys: e.keys.length, redundant: redundant.length, kind: e.kind ?? (e.constant ? 'constant' : 'entity') };
    });
    const sorted = rows.map((r) => r.chars).sort((a, b) => a - b);
    const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
    return {
        rows,
        summary: {
            entries: rows.length,
            scenes: rows.filter((r) => r.kind === 'scene').length,
            timeline: rows.some((r) => r.kind === 'timeline') ? 'yes' : 'no',
            totalChars: sum((r) => r.chars),
            medianChars: sorted[Math.floor(sorted.length / 2)] ?? 0,
            longestChars: sorted[sorted.length - 1] ?? 0,
            over1000: rows.filter((r) => r.chars >= 1000).length,
            verifiedQuotes: sum((r) => r.quotes),
            entriesWithQuotes: rows.filter((r) => r.quotes).length,
            totalKeys: sum((r) => r.keys),
            keysPerEntry: +(sum((r) => r.keys) / Math.max(1, rows.length)).toFixed(2),
            singleKeyEntries: rows.filter((r) => r.keys === 1).length,
            redundantKeys: sum((r) => r.redundant),
        },
    };
}

function main() {
    const [t, a, b] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
    const messages = loadTranscript(t);
    const before = stats(loadBook(a), messages);
    const after = stats(loadBook(b), messages);
    const keys = Object.keys(before.summary);
    console.log('| measure | before | after |\n|---|---:|---:|');
    for (const k of keys) console.log(`| ${k} | ${before.summary[k]} | ${after.summary[k]} |`);
    const old = new Map(before.rows.map((r) => [r.title.toLowerCase(), r]));
    console.log('\n| entry | chars before | chars after | quotes after | keys before | keys after |\n|---|---:|---:|---:|---:|---:|');
    for (const r of after.rows.sort((x, y) => y.chars - x.chars)) {
        const o = old.get(r.title.toLowerCase());
        console.log(`| ${r.title}${r.kind === 'entity' ? '' : ` (${r.kind})`} | ${o ? o.chars : '–'} | ${r.chars} | ${r.quotes} | ${o ? o.keys : '–'} | ${r.keys} |`);
    }
    // Breadth: each old entity is present (its name, or a key of it, is a new
    // entry's title or key), named in another entry's text, or absent.
    const bare = (x) => String(x).toLowerCase().replace(/^the /, '').replace(/['’]s$/, '').trim();
    const oldBook = loadBook(a);
    const fresh = loadBook(b).filter((e) => !e.kind || !['scene', 'timeline'].includes(e.kind));
    const names = new Set(fresh.flatMap((e) => [e.title, ...e.keys]).map(bare));
    const text = loadBook(b).map((e) => e.content.toLowerCase()).join('\n');
    const present = [];
    const inText = [];
    const absent = [];
    for (const e of oldBook) {
        const ids = [e.title, ...e.keys].map(bare);
        if (ids.some((i) => names.has(i))) present.push(e.title);
        else if (ids.some((i) => i.length > 3 && text.includes(i))) inText.push(e.title);
        else absent.push(e.title);
    }
    console.log(`\nNon-scene entities: ${before.rows.length} before, ${fresh.length} after.`);
    console.log(`Old entities present by name or alias: ${present.length} of ${oldBook.length}.`);
    if (inText.length) console.log(`Named only inside other entries: ${inText.join('; ')}`);
    if (absent.length) console.log(`Absent: ${absent.join('; ')}`);
}

main();
