// The depth step of a two-step build. The first call reads the story for
// breadth: every entity, every scene, a few short facts each. This step then
// writes the depth over the same text, a few main characters or scenes per
// call, so a long profile never has to share a reply with the roster. What it
// writes is folded into the canon like any other reply (canon.js), but only
// for the entities and scenes it was asked about.
//
// A batch that fails (the model's reply unusable twice) costs that batch its
// depth and nothing else: the breadth stands and the review list says so.

import { estimateTokens } from './budget.js';
import { buildDepthPrompt } from './prompt.js';
import { readReply, ModelOutputError } from './parse.js';
import { absorb } from './canon.js';
import { ask } from './build.js';
import { checkQuotes } from './quotes.js';

export const MAINS_PER_CALL = 2;
export const SCENES_PER_CALL = 3;

/** A character named in at least this share of the scenes (and three) is a main character. */
export const MAIN_SHARE = 1 / 3;

const fold = (s) => s.toLowerCase();
const batches = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

/**
 * Deepens the main characters and scenes of `canon` that the messages
 * `from`..`to` establish something about. `starts` are all the scene starts
 * known so far (a scene runs to the next one, or to `to`). Mutates `canon`.
 */
export async function deepen({ messages, canon, from, to, starts, generate, budget, review, renamed }) {
    const inPart = (e) => e.facts.some((f) => f.messages.some((id) => id >= from && id <= to));
    const scenes = canon.filter((e) => e.kind === 'scene' && e.start >= from && e.start <= to).sort((a, b) => a.start - b.start);
    // The breadth call's `main` flag is a judgment made while listing dozens of entities. Anyone who is in
    // a third of the scenes, and at least three, is a main character whatever it said.
    for (const e of canon) {
        if (e.kind === 'scene' || e.main) continue;
        const names = [e.name, ...e.keys].map(fold);
        const inScenes = scenes.filter((sc) => (sc.who ?? []).some((w) => names.includes(fold(w)))).length;
        if (inScenes >= 3 && inScenes >= scenes.length * MAIN_SHARE) e.main = true;
    }
    const mains = canon.filter((e) => e.kind !== 'scene' && e.main && inPart(e));
    const sorted = [...new Set([...starts, ...scenes.map((e) => e.start)])].sort((a, b) => a - b);
    const spans = new Map(scenes.map((e) => [e.start, [e.start, Math.min(to, (sorted.find((s) => s > e.start) ?? to + 1) - 1)]]));

    // Keys other entries hold: a scene's own keys are asked for beside them.
    const taken = [...new Set(canon.filter((e) => e.kind !== 'scene').flatMap((e) => e.keys))].sort();
    let done = 0;
    const queue = [...batches(mains, MAINS_PER_CALL).map((m) => ({ mains: m, scenes: [] })), ...batches(scenes, SCENES_PER_CALL).map((s) => ({ mains: [], scenes: s }))];
    for (let i = 0; i < queue.length; i++) {
        const batch = queue[i];
        const names = [...batch.mains, ...batch.scenes].map((e) => e.name).join(', ');
        // A batch of scenes reads only its own stretch; the main characters read it all.
        const stretch = batch.mains.length ? [from, to] : [Math.min(...batch.scenes.map((e) => spans.get(e.start)[0])), Math.max(...batch.scenes.map((e) => spans.get(e.start)[1]))];
        const prompt = buildDepthPrompt(messages, { from: stretch[0], to: stretch[1], ...batch, spans, taken, outputTokens: budget.output });
        const needed = estimateTokens(prompt.system + prompt.user);
        if (needed > budget.input) {
            review.push({ name: names, reason: `the depth step needs ~${needed} prompt tokens but only ${budget.input} fit; left at breadth` });
            continue;
        }
        let reply;
        try {
            reply = await ask(generate, prompt, budget.output, messages.length);
        } catch (err) {
            if (!(err instanceof ModelOutputError)) throw err;
            review.push({ name: names, reason: `the depth step's reply could not be used (${err.message}); left at breadth` });
            continue;
        }
        review.push(...reply.review);
        // Only what was asked for: a name or a start that wasn't listed is not an entity to add.
        const asked = new Set(batch.mains.map((e) => fold(e.name)));
        const askedScenes = new Set(batch.scenes.map((e) => e.start));
        const found = reply.entities.filter((e) => {
            const ok = e.kind === 'scene' ? askedScenes.has(e.start) : asked.has(fold(e.name));
            if (!ok) review.push({ name: e.name, reason: 'the depth step reported something it was not asked about; left out' });
            return ok;
        });
        // A fact cites inside the span it was asked for; absorb checks the part, this narrows it to the scene.
        for (const e of found.filter((x) => x.kind === 'scene')) {
            const [a, b] = spans.get(e.start);
            e.facts = e.facts.map((f) => ({ ...f, messages: f.messages.filter((id) => id >= a && id <= b) })).filter((f) => f.messages.length);
            e.quotes = (e.quotes ?? []).filter((q) => q.message >= a && q.message <= b);
        }
        absorb(canon, found.filter((e) => e.facts.length), from, to, review, renamed);
        done++;
        // A main character is unfinished without lines to speak: once, the ones still short of two verified quotes are asked for again.
        const short = batch.mains.filter((e) => checkQuotes(e.quotes, messages).kept.length < 2);
        if (short.length && !batch.again) queue.splice(i + 1, 0, { mains: short, scenes: [], again: true });
    }
    return done;
}

/** A sweep passage holds scenes up to about this many characters of transcript. */
export const SWEEP_CHARS = 60000;

/**
 * The passages a sweep reads: messages `from`..`to` cut at scene starts into
 * stretches of at most SWEEP_CHARS (one scene longer than that is cut by
 * message), as inclusive [from, to] pairs.
 */
export function sweepWindows(messages, from, to, starts) {
    const cuts = new Set(starts.filter((s) => s > from && s <= to));
    const out = [];
    let begin = from;
    let size = 0;
    for (let i = from; i <= to; i++) {
        const len = messages[i].text.length + messages[i].name.length + 8;
        // Cut before a scene start once the window is more than half full, or before any message that would overflow it.
        if (i > begin && ((cuts.has(i) && size > SWEEP_CHARS / 2) || size + len > SWEEP_CHARS)) {
            out.push([begin, i - 1]);
            begin = i;
            size = 0;
        }
        size += len;
    }
    out.push([begin, to]);
    return out;
}

/**
 * The breadth step: one call for the scenes and a short roster, then a sweep
 * over the story a passage at a time for what the roster missed (asked for
 * every entity of a whole story, a model stops short; reading a few scenes
 * at a time with the roster in hand it finds the plans, objects and events).
 * `prompts` gives the first prompt (the one the caller sized) and
 * `sweep(from, to, known)`. Returns what one call of the one-shot prompt
 * returns: { scenes, entities, review }.
 */
export async function askBreadth(generate, prompts, maxTokens, messageCount, { messages, from, to, known = [] }) {
    const first = await ask(generate, prompts.first, maxTokens, messageCount);
    const entities = [...first.entities];
    const review = [...first.review];
    const people = () => [...known, ...entities].filter((x) => x.kind !== 'scene');
    const listed = (e) => people().some((x) => [x.name, ...x.keys].some((k) => [e.name, ...e.keys].some((j) => fold(j) === fold(k))));
    for (const [a, b] of sweepWindows(messages, from, to, first.scenes)) {
        const more = await ask(generate, prompts.sweep(a, b, people()), maxTokens, messageCount);
        review.push(...more.review);
        for (const e of more.entities) {
            const facts = e.facts.map((f) => ({ ...f, messages: f.messages.filter((id) => id >= a && id <= b) })).filter((f) => f.messages.length);
            if (facts.length && !listed(e)) entities.push({ ...e, facts });
        }
    }
    return { scenes: first.scenes, entities, review };
}
