// The one-shot core: transcript in, complete lorebook out, in one model call.
//
// Pure: no SillyTavern imports, no file or network access. The model comes in
// as `generate({ system, user, maxTokens }) -> Promise<string>` and the
// context window as a number, so the same code runs offline from a file and,
// later, inside SillyTavern behind the adapter.

import { planBudget, estimateTokens, TooLongError } from './budget.js';
import { buildPrompt, retryPrompt } from './prompt.js';
import { readReply, ModelOutputError } from './parse.js';
import { compile } from './compile.js';
import { fingerprint, messageHash } from './fingerprint.js';
import { entryHash } from './plan.js';

/** v2: the ledger holds the canon, message hashes and written-entry hashes. */
export const LEDGER_VERSION = 2;

export async function ask(generate, prompt, maxTokens, messageCount) {
    const first = await generate({ ...prompt, maxTokens });
    try {
        return readReply(first, messageCount);
    } catch (err) {
        if (!(err instanceof ModelOutputError)) throw err;
        // Strict JSON with one retry, then give up. Never repair by guessing.
        const second = await generate({ ...retryPrompt(prompt, err.message), maxTokens });
        return readReply(second, messageCount);
    }
}

/** Plain-object view of a World Info file: { entries: { [uid]: entry } }. */
export function toBook(entries) {
    return { entries: Object.fromEntries(entries.map((e) => [String(e.uid), e])) };
}

/**
 * The ledger: the per-chat state a later run starts from. The lorebook is
 * output; this is the record. `revision` counts the runs that wrote.
 */
export function makeLedger({ messages, budget, scenes, compiled, review, revision, held = [], previous = {} }) {
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
        review,
    };
}

/**
 * Builds the whole book in one call.
 *
 * Returns { book, scenes, ledger }: `book` is a SillyTavern World Info file,
 * `scenes` the ids that start a new scene, and `ledger` the state a later run
 * starts from (what was built, from which text, and every decision made).
 * `pinned` entries are kept verbatim; `uids` and `nextUid` keep entities on
 * the uids they had (see compile).
 */
export async function build({ messages, generate, contextTokens, maxOutputTokens, pinned = [], uids, nextUid }) {
    if (!messages.length) throw new Error('empty transcript');
    const budget = planBudget({ contextTokens, maxOutputTokens });
    const prompt = buildPrompt(messages, budget.output);
    const needed = estimateTokens(prompt.system + prompt.user);
    if (needed > budget.input) throw new TooLongError(needed, budget.input);

    const reply = await ask(generate, prompt, budget.output, messages.length);
    const compiled = compile(reply.entities, messages, { pinned, uids, nextUid });
    return {
        book: toBook(compiled.entries),
        scenes: { boundaries: reply.scenes },
        ledger: makeLedger({
            messages,
            budget: { ...budget, promptEstimate: needed },
            scenes: reply.scenes,
            compiled,
            review: [...reply.review, ...compiled.review],
            revision: 1,
            held: pinned,
        }),
    };
}
