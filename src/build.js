// The one-shot core: transcript in, complete lorebook out, in one model call
// (or, for a story too long for the window, in parts: chunked.js).
//
// Pure: no SillyTavern imports, no file or network access. The model comes in
// as `generate({ system, user, maxTokens }) -> Promise<string>` and the
// context window as a number, so the same code runs offline from a file and,
// later, inside SillyTavern behind the adapter.

import { planBudget, estimateTokens } from './budget.js';
import { buildPrompt, buildSweepPrompt, retryPrompt } from './prompt.js';
import { readReply, ModelOutputError } from './parse.js';
import { compile } from './compile.js';
import { fingerprint, messageHash } from './fingerprint.js';
import { entryHash } from './plan.js';
import { buildChunked } from './chunked.js';
import { deepen, askBreadth } from './deepen.js';

/** v2: the ledger holds the canon, message hashes and written-entry hashes. */
export const LEDGER_VERSION = 2;

/** One model call, read by `read` (readReply by default). */
export async function ask(generate, prompt, maxTokens, messageCount, read = readReply) {
    const first = await generate({ ...prompt, maxTokens });
    try {
        return read(first, messageCount);
    } catch (err) {
        if (!(err instanceof ModelOutputError)) throw err;
        // Strict JSON with one retry, then give up. Never repair by guessing.
        const second = await generate({ ...retryPrompt(prompt, err.message), maxTokens });
        return read(second, messageCount);
    }
}

/** Plain-object view of a World Info file: { entries: { [uid]: entry } }. */
export function toBook(entries) {
    return { entries: Object.fromEntries(entries.map((e) => [String(e.uid), e])) };
}

/**
 * The ledger: the per-chat state a later run starts from. The lorebook is
 * output; this is the record. `revision` counts the runs that wrote.
 * `chunked`, set when the book was built in parts (chunked.js), says so for
 * as long as the ledger lives. `deleted`, when there is any, lists the
 * entries a human deleted, which later runs leave out (compile).
 */
export function makeLedger({ messages, budget, scenes, compiled, review, revision, held = [], previous = {}, chunked }) {
    const heldUids = new Set(held.map((e) => String(e.uid)));
    const written = {};
    for (const e of compiled.entries) {
        const uid = String(e.uid);
        if (!heldUids.has(uid)) written[uid] = entryHash(e);
        else if (uid in previous) written[uid] = previous[uid];
    }
    return {
        version: LEDGER_VERSION,
        revision,
        fingerprint: fingerprint(messages),
        messageCount: messages.length,
        hashes: messages.map(messageHash),
        budget,
        scenes,
        entities: compiled.ledger,
        nextUid: compiled.nextUid,
        written,
        contested: compiled.contested,
        ...(compiled.timeline != null ? { timeline: compiled.timeline } : {}),
        review,
        ...(Object.keys(compiled.deleted ?? {}).length ? { deleted: compiled.deleted } : {}),
        ...(chunked ? { chunked } : {}),
    };
}

/**
 * Builds the whole book in one call, or, for a story that doesn't fit the
 * window, in parts (chunked.js), and then the ledger says so.
 *
 * Returns { book, scenes, ledger }: `book` is a SillyTavern World Info file,
 * `scenes` the ids that start a new scene, and `ledger` the state a later run
 * starts from (what was built, from which text, and every decision made).
 * `pinned` entries are kept verbatim, `foreign` entries (other active books)
 * are only read; `uids` and `nextUid` keep entities on the uids they had
 * (see compile).
 */
export async function build({ messages, generate, contextTokens, maxOutputTokens, outputShare, pinned = [], foreign = [], uids, nextUid, depth = false }) {
    if (!messages.length) throw new Error('empty transcript');
    const budget = planBudget({ contextTokens, maxOutputTokens, outputShare });
    const prompt = buildPrompt(messages, budget.output, { depth, focus: 'entities' });
    const needed = estimateTokens(prompt.system + prompt.user);
    if (needed > budget.input) return buildChunked({ messages, generate, budget, pinned, foreign, uids, nextUid, depth });

    const reply = depth
        ? await askBreadth(generate, { scenes: buildPrompt(messages, budget.output, { depth, focus: 'scenes' }), entities: prompt, sweep: (from, to, known) => buildSweepPrompt(messages, { from, to, known, outputTokens: budget.output }) }, budget.output, messages.length, { messages, from: 0, to: messages.length - 1 })
        : await ask(generate, prompt, budget.output, messages.length);
    const review = [...reply.review];
    if (depth) await deepen({ messages, canon: reply.entities, from: 0, to: messages.length - 1, starts: reply.scenes, generate, budget, review, renamed: [] });
    const compiled = compile(reply.entities, messages, { pinned, foreign, uids, nextUid });
    return {
        book: toBook(compiled.entries),
        scenes: { boundaries: reply.scenes },
        ledger: makeLedger({
            messages,
            budget: { ...budget, promptEstimate: needed },
            scenes: reply.scenes,
            compiled,
            review: [...review, ...compiled.review],
            revision: 1,
            held: pinned,
        }),
    };
}
