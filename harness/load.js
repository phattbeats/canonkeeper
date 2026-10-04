// Fixture loaders. Every loader throws FixtureError when its file is missing
// or malformed. The gate treats that as a hard failure (exit 2): a harness
// with nothing to check must never report green.

import { readFileSync, existsSync } from 'node:fs';
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
