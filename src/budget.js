// Sizing from the context window. Nothing in the core is a fixed chunk size:
// the window is the input, and everything else is derived from it.

/**
 * A deliberately pessimistic token estimate. English prose runs about 4
 * characters per token; 3 leaves room for names, punctuation and non-English
 * text, so a story we say fits really does.
 */
export function estimateTokens(text) {
    return Math.ceil(text.length / 3);
}

/**
 * Splits the window into prompt and output. The output reserve scales with
 * the window (a book for a long story is long) but is capped by what the
 * model can actually emit.
 */
export function planBudget({ contextTokens, maxOutputTokens = 64000, outputShare = 0.25 }) {
    if (!(outputShare > 0 && outputShare < 1)) throw new Error('outputShare must be between 0 and 1');
    if (!Number.isInteger(contextTokens) || contextTokens <= 0) throw new Error('contextTokens must be a positive integer');
    const output = Math.min(maxOutputTokens, Math.floor(contextTokens * outputShare));
    return { contextTokens, output, input: contextTokens - output };
}

export class TooLongError extends Error {
    constructor(needed, available) {
        super(`the prompt needs ~${needed} tokens but only ${available} fit in the window`);
        this.needed = needed;
        this.available = available;
    }
}
