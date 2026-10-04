#!/usr/bin/env node
// Plants the damage in fixtures/story/audit/plant.json, for the audit gate
// (A12). Fixture preparation only: it doesn't judge anything.
//
//   node harness/plant.js replies <recorded replies.json> <plant.json> <out.json>
//       adds the plant's false facts to the recorded build reply, as if the
//       model had written them
//   node harness/plant.js book <run dir> <plant.json>
//       in <run dir>/book.json: adds the collision key to both entries and
//       deletes one entry, as a human would in the World Info editor. Writes
//       <run dir>/planted.json, the uids planted, and planted-book.json, a
//       copy of the book as planted, for the gate.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
};

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'replies') {
    const [from, plantPath, out] = args;
    const plant = readJson(plantPath);
    const replies = readJson(from);
    const reply = JSON.parse(replies[0].slice(replies[0].indexOf('{'), replies[0].lastIndexOf('}') + 1));
    for (const f of plant.falseFacts) {
        const e = reply.entities.find((x) => x.name === f.entity);
        if (!e) throw new Error(`the recorded reply has no entity '${f.entity}'`);
        e.facts.push({ text: f.text, messages: f.messages });
    }
    writeJson(out, [JSON.stringify(reply), ...replies.slice(1)]);
    console.log(`planted ${plant.falseFacts.length} false fact(s) -> ${out}`);
} else if (cmd === 'book') {
    const [dir, plantPath] = args;
    const plant = readJson(plantPath);
    const book = readJson(join(dir, 'book.json'));
    const byTitle = (t) => {
        const e = Object.values(book.entries).find((x) => x.comment === t);
        if (!e) throw new Error(`no entry titled '${t}'`);
        return e;
    };
    const collided = plant.collision.entries.map(byTitle);
    for (const e of collided) e.key = [...e.key, plant.collision.key];
    const gone = byTitle(plant.delete);
    delete book.entries[String(gone.uid)];
    const facts = plant.falseFacts.map((f) => ({ ...f, uid: byTitle(f.entity).uid }));
    writeJson(join(dir, 'book.json'), book);
    // The book as planted, so the gate can tell whether the audit wrote to it.
    writeJson(join(dir, 'planted-book.json'), book);
    writeJson(join(dir, 'planted.json'), {
        collision: { key: plant.collision.key, uids: collided.map((e) => e.uid) },
        deleted: { uid: gone.uid, title: gone.comment },
        falseFacts: facts,
    });
    console.log(`planted: '${plant.collision.key}' on uids ${collided.map((e) => e.uid).join(', ')}; deleted uid ${gone.uid} '${gone.comment}'`);
} else {
    throw new Error('usage: plant.js replies|book ...');
}
