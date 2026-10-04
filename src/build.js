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
import { fingerprint } from './fingerprint.js';

export const LEDGER_VERSION = 1;

async function ask(generate, prompt, maxTokens, messageCount) {
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
 * Builds the whole book in one call.
 *
 * Returns { book, scenes, ledger }: `book` is a SillyTavern World Info file,
 * `scenes` the ids that start a new scene, and `ledger` the state a later run
 * starts from (what was built, from which text, and every decision made).
 */
export async function build({ messages, generate, contextTokens, maxOutputTokens, pinned = [] }) {
    if (!messages.length) throw new Error('empty transcript');
    const budget = planBudget({ contextTokens, maxOutputTokens });
    const prompt = buildPrompt(messages, budget.output);
    const needed = estimateTokens(prompt.system + prompt.user);
    if (needed > budget.input) throw new TooLongError(needed, budget.input);

    const reply = await ask(generate, prompt, budget.output, messages.length);
    const { entries, ledger, review, contested } = compile(reply.entities, messages, { pinned });
    return {
        book: toBook(entries),
        scenes: { boundaries: reply.scenes },
        ledger: {
            version: LEDGER_VERSION,
            fingerprint: fingerprint(messages),
            messageCount: messages.length,
            budget: { ...budget, promptEstimate: needed },
            scenes: reply.scenes,
            entities: ledger,
            contested,
            review: [...reply.review, ...review],
        },
    };
}

/**
 * Re-running a book. An unchanged transcript writes nothing: the book comes
 * back exactly as it went in, pins and human edits included, with no model
 * call. A changed transcript is rebuilt with every pinned entry kept as is
 * (build step 2 replaces this with an incremental update).
 */
export async function rerun({ book, ledger, messages, generate, contextTokens, maxOutputTokens }) {
    if (ledger?.version === LEDGER_VERSION && ledger.fingerprint === fingerprint(messages)) {
        return { book: structuredClone(book), ledger, wrote: false };
    }
    const pinned = Object.values(book.entries).filter((e) => e.canonkeeper?.pinned);
    const next = await build({ messages, generate, contextTokens, maxOutputTokens, pinned });
    return { ...next, wrote: true };
}
