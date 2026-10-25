// Fixture loaders. Every loader throws FixtureError when its file is missing
// or malformed. The gate treats that as a hard failure (exit 2): a harness
// with nothing to check must never report green.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export class FixtureError extends Error {}

function readJson(path) {
    if (!existsSync(path)) throw new FixtureError(`missing fixture: ${path}`);
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        throw new FixtureError(`unparseable fixture: ${path}: ${err.message}`);
    }
}

/**
 * SillyTavern chat JSONL: line 1 is the chat header, every later line is one
 * message. Message ids are 0-based positions among the messages (header excluded).
 */
export function loadTranscript(path) {
    if (!existsSync(path)) throw new FixtureError(`missing fixture: ${path}`);
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
    if (lines.length < 2) throw new FixtureError(`transcript has no messages: ${path}`);
    return lines.slice(1).map((line, id) => {
        let m;
        try {
            m = JSON.parse(line);
        } catch (err) {
            throw new FixtureError(`${path}: message ${id} is not JSON: ${err.message}`);
        }
        if (typeof m.mes !== 'string') throw new FixtureError(`${path}: message ${id} has no 'mes' text`);
        return { id, name: m.name, isUser: !!m.is_user, text: m.mes };
    });
}

/**
 * A SillyTavern World Info file ({ entries: { [uid]: entry } }), flattened to
 * the fields the checks read. `raw` keeps the untouched entry for I5's
 * byte-level comparison. Provenance and pins live under `entry.canonkeeper`.
 */
export function loadBook(path) {
    const data = readJson(path);
    if (!data || typeof data.entries !== 'object' || data.entries === null) {
        throw new FixtureError(`not a World Info file (no 'entries' object): ${path}`);
    }
    return Object.values(data.entries).map(normalizeEntry);
}

export function normalizeEntry(raw) {
    const ck = raw.canonkeeper ?? {};
    return {
        uid: raw.uid,
        title: raw.comment ?? '',
        keys: (raw.key ?? []).map((k) => String(k).trim()).filter(Boolean),
        content: raw.content ?? '',
        caseSensitive: raw.caseSensitive ?? null,
        matchWholeWords: raw.matchWholeWords ?? null,
        constant: !!raw.constant,
        disabled: !!raw.disable,
        sources: Array.isArray(ck.sources) ? ck.sources : [],
        kind: ck.kind ?? null,
        start: Number.isInteger(ck.start) ? ck.start : null,
        quotes: Array.isArray(ck.quotes) ? ck.quotes : [],
        pinned: !!ck.pinned,
        raw,
    };
}

export function loadAnswerKey(path) {
    const key = readJson(path);
    if (!Array.isArray(key.entities) || !Array.isArray(key.boundaries)) {
        throw new FixtureError(`answer key needs 'entities' and 'boundaries' arrays: ${path}`);
    }
    return key;
}

/**
 * A run directory is one builder's output for the transcript:
 *   book.json   the lorebook after the first run
 *   rerun.json  the lorebook after re-running on the unchanged transcript,
 *               starting from book.json (pins included)
 *   scenes.json { boundaries: [messageId, ...] } — ids that start a new scene
 */
export function loadRun(dir) {
    const scenes = readJson(join(dir, 'scenes.json'));
    if (!Array.isArray(scenes.boundaries)) throw new FixtureError(`${dir}/scenes.json has no 'boundaries' array`);
    return {
        book: loadBook(join(dir, 'book.json')),
        rerun: loadBook(join(dir, 'rerun.json')),
        boundaries: scenes.boundaries,
    };
}

/** The run's ledger.json, which only a chunked run is asked for. */
export function loadLedger(dir) {
    return readJson(join(dir, 'ledger.json'));
}

/** The run's live.json (a live session's state store), which only --live asks for. */
export function loadLive(dir) {
    return readJson(join(dir, 'live.json'));
}

/**
 * Edit fixtures: `<story>/edits/<name>/transcript.jsonl`, the story with one
 * scene edited. A run answers each with `<run>/edits/<name>/book.json`, its
 * book.json brought up to date with the edited transcript.
 */
export function loadEdits(storyDir, runDir) {
    const root = join(storyDir, 'edits');
    if (!existsSync(root)) throw new FixtureError(`no edit fixtures: ${root}`);
    const names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    if (!names.length) throw new FixtureError(`no edit fixtures: ${root}`);
    return names.map((name) => ({
        name,
        transcript: loadTranscript(join(root, name, 'transcript.jsonl')),
        book: loadBook(join(runDir, 'edits', name, 'book.json')),
    }));
}

/**
 * An audit run (`--audit`): `<dir>/clean/audit.json`, the audit of the book
 * as built, and `<dir>/planted/`, a book with damage planted by
 * harness/plant.js: planted.json, planted-book.json (before the audit),
 * book.json, audit.json and rerun.json.
 */
export function loadAudit(dir) {
    const p = join(dir, 'planted');
    const planted = readJson(join(p, 'planted.json'));
    if (!planted.collision || !planted.deleted || !Array.isArray(planted.falseFacts)) throw new FixtureError(`${p}/planted.json needs collision, deleted and falseFacts`);
    const before = loadBook(join(p, 'planted-book.json'));
    // The plant itself must be there, or A12 would test nothing.
    for (const uid of planted.collision.uids) {
        const e = before.find((x) => x.uid === uid);
        if (!e?.keys.some((k) => k.toLowerCase() === planted.collision.key.toLowerCase())) throw new FixtureError(`the planted collision key is not on uid ${uid}`);
    }
    if (before.some((e) => e.uid === planted.deleted.uid)) throw new FixtureError(`the planted deletion (uid ${planted.deleted.uid}) is still in the book`);
    return {
        clean: { audit: readJson(join(dir, 'clean', 'audit.json')) },
        planted: {
            planted,
            before,
            book: loadBook(join(p, 'book.json')),
            audit: readJson(join(p, 'audit.json')),
            rerun: existsSync(join(p, 'rerun.json')) ? loadBook(join(p, 'rerun.json')) : null,
        },
    };
}

/**
 * The other lorebooks active for a run's chat (`--books`):
 * `<dir>/others.json`, { books: [{ name, via, before, after: [...] }] }.
 * `before` is the book file exactly as the server sent it before the first
 * run, and `after` the same file after each run, as text, so the check
 * compares bytes. Their entries, read from `before`, get uids prefixed with
 * the book's name so they never meet a uid of the chat's book.
 */
export function loadOthers(dir) {
    const data = readJson(join(dir, 'others.json'));
    if (!Array.isArray(data.books) || !data.books.length) throw new FixtureError(`${dir}/others.json lists no other books`);
    return data.books.map((b) => {
        if (typeof b.before !== 'string' || !Array.isArray(b.after) || !b.after.length) throw new FixtureError(`${dir}/others.json: '${b.name}' needs before and after as file text`);
        const file = JSON.parse(b.before);
        const entries = Object.values(file.entries ?? {}).map((e) => ({ ...normalizeEntry(e), uid: `${b.name}:${e.uid}`, book: b.name }));
        return { name: b.name, via: b.via ?? null, before: b.before, after: b.after, entries };
    });
}

/**
 * An extras run (`--extras`, harness/live/st-extras.mjs): `<dir>/extras.json`,
 * the prompts the roleplay model got with recall off, on and broken, and the
 * lorebook files around a failed and a working clip.
 */
export function loadExtras(dir) {
    const x = readJson(join(dir, 'extras.json'));
    if (!x.recall || !x.clip) throw new FixtureError(`${dir}/extras.json needs recall and clip`);
    return x;
}
