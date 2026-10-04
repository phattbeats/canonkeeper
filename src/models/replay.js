// A `generate` that replays recorded replies in order. It lets CI run the
// whole builder, deterministically and with no model, on a reply recorded
// from a real run.

export function replay(replies) {
    const queue = [...replies];
    return async () => {
        if (!queue.length) throw new Error('replay: no recorded reply left');
        return queue.shift();
    };
}

/** Wraps a `generate` so every reply it gives is also kept. */
export function recording(generate, sink) {
    return async (req) => {
        const text = await generate(req);
        sink.push(text);
        return text;
    };
}
