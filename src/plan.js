// Diff and plan: what a run would change in the book, before anything is
// written. Pure, like the rest of the core. The adapter shows the plan and
// applies it; nothing here touches SillyTavern.
//
// Canonkeeper owns a few fields of each entry it writes (OWNED). Everything
// else (order, position, depth, disable, probability...) belongs to the user:
// an update rewrites the owned fields and leaves the rest as the user set it.
//
// The ledger keeps a content hash of the owned fields of every entry as
// Canonkeeper last wrote it. An entry whose owned fields no longer match was
// edited by hand, and is held exactly like a pinned one.

import { hashOf } from './fingerprint.js';

export const OWNED = ['key', 'comment', 'content', 'caseSensitive', 'preventRecursion', 'cooldown', 'canonkeeper'];

/** The fields Canonkeeper writes. The pin is the human's, so it isn't one. */
export function owned(entry) {
    const out = {};
    for (const f of OWNED) out[f] = entry[f] ?? null;
    if (out.canonkeeper) {
        const { pinned, ...rest } = out.canonkeeper;
        out.canonkeeper = rest;
    }
    return out;
}

export const entryHash = (entry) => hashOf(owned(entry));

/**
 * The entries a run must keep exactly as they are, each with the reason:
 * pinned by a human, clipped by one (clip.js), edited by hand since
 * Canonkeeper wrote it, or never written by Canonkeeper at all.
 */
export function heldEntries(book, written = {}) {
    const held = [];
    for (const e of Object.values(book.entries)) {
        let reason = null;
        if (e.canonkeeper?.pinned) reason = 'pinned';
        else if (e.canonkeeper?.clip) reason = 'clip';
        else if (!(String(e.uid) in written)) reason = 'not written by Canonkeeper';
        else if (entryHash(e) !== written[String(e.uid)]) reason = 'edited by hand';
        if (reason) held.push({ entry: e, reason });
    }
    return held;
}

/**
 * The writes that turn `book` into `entries`: add, update (owned fields
 * only, listed) and remove, in uid order. An empty plan means zero writes.
 */
export function plan(book, entries) {
    const before = new Map(Object.values(book.entries).map((e) => [e.uid, e]));
    const after = new Map(entries.map((e) => [e.uid, e]));
    const ops = [];
    for (const [uid, next] of after) {
        const prev = before.get(uid);
        if (!prev) {
            ops.push({ op: 'add', uid, title: next.comment, entry: next });
            continue;
        }
        const a = owned(prev);
        const b = owned(next);
        const fields = OWNED.filter((f) => hashOf(a[f]) !== hashOf(b[f]));
        if (fields.length) ops.push({ op: 'update', uid, title: next.comment, fields, entry: next });
    }
    for (const [uid, prev] of before) if (!after.has(uid)) ops.push({ op: 'remove', uid, title: prev.comment });
    return ops.sort((x, y) => x.uid - y.uid);
}

/** Applies a plan to a copy of the book. The input book is never mutated. */
export function apply(book, ops) {
    const out = structuredClone(book);
    for (const o of ops) {
        const id = String(o.uid);
        if (o.op === 'remove') delete out.entries[id];
        else if (o.op === 'add') out.entries[id] = structuredClone(o.entry);
        else {
            const prev = out.entries[id];
            const next = owned(o.entry);
            for (const f of OWNED) if (f !== 'canonkeeper') prev[f] = structuredClone(next[f]);
            prev.canonkeeper = { ...structuredClone(next.canonkeeper), pinned: prev.canonkeeper?.pinned ?? false };
        }
    }
    return out;
}

/** One line per write, for the CLI and, later, the adapter's status view. */
export function describe(ops) {
    return ops.map((o) => `${o.op} ${o.uid} '${o.title}'${o.fields ? ` (${o.fields.join(', ')})` : ''}`);
}
