#!/usr/bin/env node
// Turns a one-shot reply (breadth and depth in one) into the replies of a
// two-step build: the first reply (scenes and roster), an empty sweep, then the depth batches, in the order
// deepen() asks for them. The split is lossless: the breadth reply keeps each
// main character's and scene's first facts, the batches add the rest and the
// quotes, so the two-step build compiles to the book the one-shot reply does.
//
//   node harness/split-replies.js <one-shot replies.json> <out.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { MAINS_PER_CALL, SCENES_PER_CALL } from '../src/deepen.js';

const KEEP_MAIN = 3;
const batches = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

export function split(reply) {
    const data = JSON.parse(reply);
    const mains = data.entities.filter((e) => e.main);
    const first = {
        entities: data.entities.map(({ quotes, ...e }) => ({ ...e, facts: e.main ? e.facts.slice(0, KEEP_MAIN) : e.facts })),
        scenes: data.scenes.map(({ quotes, ...s }) => ({ ...s, facts: s.facts.slice(0, 1) })),
    };
    const scenes = data.scenes.filter((s) => s.facts?.length);
    const calls = [
        ...batches(mains, MAINS_PER_CALL).map((b) => ({
            entities: b.map((e) => ({ name: e.name, keys: [], facts: e.facts.slice(KEEP_MAIN), quotes: e.quotes ?? [] })),
            scenes: [],
        })),
        ...batches(scenes, SCENES_PER_CALL).map((b) => ({
            entities: [],
            scenes: b.map((s) => ({ start: s.start, title: s.title, facts: s.facts.slice(1), quotes: s.quotes ?? [] })),
        })),
    ];
    return [JSON.stringify(first), JSON.stringify({ entities: [], scenes: [] }), ...calls.map((c) => JSON.stringify(c))];
}

if (process.argv[1].endsWith('split-replies.js')) {
    const [inp, out] = process.argv.slice(2);
    const replies = JSON.parse(readFileSync(inp, 'utf8'));
    if (replies.length !== 1) throw new Error('expected one one-shot reply');
    writeFileSync(out, JSON.stringify(split(replies[0]), null, 2) + '\n');
}
