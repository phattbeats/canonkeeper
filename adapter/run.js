// One /canon run, with SillyTavern injected. This is the only code that
// decides when a write reaches the lorebook. index.js supplies the real
// SillyTavern calls; the tests supply plain functions, so the whole run is
// checked offline.
//
// A run reads the open chat and its lorebook, brings the book up to date with
// the core's update() (a full build when the chat has no ledger yet), and
// applies only the plan's writes. The ledger and a record of the run go into
// the chat's own metadata (`chat_metadata.canonkeeper`), so they live and die
// with the chat and can be read from outside the page in the chat file.

import { update } from '../src/update.js';
import { describe } from '../src/plan.js';
import { hashOf } from '../src/fingerprint.js';

export const STATE_KEY = 'canonkeeper';
export const STATE_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
    profileId: '',
    contextTokens: 200000,
    maxOutputTokens: 64000,
});

/** The open chat as the core's messages: the same shape parseTranscript gives. */
export function toMessages(chat) {
    return chat.map((m, id) => {
        if (typeof m.mes !== 'string') throw new Error(`message ${id} has no text`);
        return { id, name: String(m.name ?? ''), isUser: !!m.is_user, text: m.mes };
    });
}

/** The lorebook a chat gets when it has none bound: one per chat. */
export function bookNameFor(chatId) {
    return `Canonkeeper - ${String(chatId).replace(/[^\w\s.@()-]/g, '_')}`.slice(0, 120);
}

/** A reply cut off at the output limit, in any API's terms. */
export function truncated(json) {
    if (!json || typeof json !== 'object') return false;
    if (json.stop_reason === 'max_tokens') return true;
    const reason = json.choices?.[0]?.finish_reason;
    return reason === 'length' || reason === 'max_tokens';
}

/**
 * The core's `generate`, from a SillyTavern connection profile. `send` is
 * ConnectionManagerRequestService.sendRequest and `extract` turns its raw
 * reply into text. A cut-off reply comes back empty, so the core counts it as
 * a bad reply rather than parsing the front half of a lorebook.
 */
export function profileGenerate({ send, extract, profileId, log = () => {} }) {
    return async ({ system, user, maxTokens }) => {
        const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
        log(`model call: ~${Math.ceil((system.length + user.length) / 3)} prompt tokens, up to ${maxTokens} out`);
        const started = Date.now();
        const json = await send(profileId, messages, maxTokens, { stream: false, extractData: false, includePreset: false, includeInstruct: true });
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        if (truncated(json)) {
            log(`model reply cut off at the output limit after ${seconds}s; counted as a bad reply`);
            return '';
        }
        const text = extract(json) ?? '';
        log(`model reply: ${text.length} chars in ${seconds}s`);
        return text;
    };
}

function summarize(result, bookName) {
    const counts = { add: 0, update: 0, remove: 0 };
    for (const o of result.plan) counts[o.op]++;
    const entries = Object.keys(result.book.entries).length;
    const writes = result.plan.length
        ? `${result.plan.length} writes (${Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')})`
        : 'no writes';
    return `Canonkeeper: '${bookName}' has ${entries} entries; ${writes}; ${result.calls} model call${result.calls === 1 ? '' : 's'}; ${result.held.length} held; ${result.ledger.review.length} for review.`;
}

/**
 * Runs /canon once. `st` is everything the run needs from SillyTavern:
 *
 *   chatId, chat, metadata         the open chat and its chat_metadata
 *   currentChatId()                to check the same chat is still open
 *   bookExists(name), loadBook(name), saveBook(name, data), createBook(name)
 *   saveMetadata()
 *   generate                       the core's generate (profileGenerate)
 *   settings                       { contextTokens, maxOutputTokens }
 *   profile                        { id, name, model } for the record
 *   log(line)
 *
 * Returns { summary, result }. Throws, with nothing written to the book, if
 * the run fails, the chat is switched mid-run or the book changes under it.
 */
export async function runCanon(st) {
    const started = Date.now();
    const lines = [];
    const log = (line) => {
        lines.push(`${new Date().toISOString()} ${line}`);
        st.log?.(line);
    };
    const state = st.metadata[STATE_KEY] ?? {};
    const record = (extra) => {
        st.metadata[STATE_KEY] = {
            ...state,
            ...extra,
            version: STATE_VERSION,
            lastRun: { at: new Date(started).toISOString(), ms: Date.now() - started, profile: st.profile ?? null, ...extra.lastRun, log: lines },
        };
    };

    try {
        const messages = toMessages(st.chat);
        if (!messages.length) throw new Error('the chat has no messages');
        log(`chat '${st.chatId}': ${messages.length} messages; ledger ${state.ledger ? `revision ${state.ledger.revision}` : 'none (full build)'}`);

        let bookName = st.metadata.world_info;
        if (!bookName) {
            bookName = bookNameFor(st.chatId);
            // SillyTavern hands back an empty book for a name it doesn't have,
            // so whether it exists comes from its list of books.
            if (!(await st.bookExists(bookName))) {
                await st.createBook(bookName);
                log(`created lorebook '${bookName}'`);
            }
            st.metadata.world_info = bookName;
            log(`bound lorebook '${bookName}' to the chat`);
        }
        const book = (await st.loadBook(bookName)) ?? { entries: {} };
        book.entries ??= {};
        const before = hashOf(book.entries);
        log(`lorebook '${bookName}': ${Object.keys(book.entries).length} entries`);

        const result = await update({
            book: structuredClone(book),
            ledger: state.ledger,
            messages,
            generate: st.generate,
            contextTokens: st.settings.contextTokens,
            maxOutputTokens: st.settings.maxOutputTokens,
        });

        if (st.currentChatId() !== st.chatId) throw new Error('the chat was switched during the run; nothing was written. Run /canon again');
        const now = (await st.loadBook(bookName)) ?? { entries: {} };
        if (hashOf(now.entries ?? {}) !== before) throw new Error('the lorebook changed during the run; nothing was written. Run /canon again');

        const plan = describe(result.plan);
        for (const line of plan) log(line);
        if (result.plan.length) {
            await st.saveBook(bookName, result.book);
            log(`wrote ${result.plan.length} changes to '${bookName}'`);
        } else log('plan is empty: zero writes');

        const summary = summarize(result, bookName);
        log(summary);
        record({
            book: bookName,
            ledger: result.ledger,
            lastRun: {
                ok: true,
                summary,
                calls: result.calls,
                revision: result.ledger.revision,
                plan,
                held: result.held,
                review: result.ledger.review,
                scenes: result.scenes.boundaries,
                entries: Object.keys(result.book.entries).length,
            },
        });
        await st.saveMetadata();
        return { summary, result, bookName };
    } catch (err) {
        log(`failed: ${err.message}`);
        record({ lastRun: { ok: false, error: err.message } });
        if (st.currentChatId() === st.chatId) await st.saveMetadata();
        throw err;
    }
}
