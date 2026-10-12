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
import { hashOf, fingerprint } from '../src/fingerprint.js';
import { seed, rewind, detect, updateTarget, logCycle, isLive, DEFAULT_CADENCE } from '../src/live.js';
import { audit, accept, checkHand, dismiss, openFindings } from '../src/audit.js';
import { clip } from '../src/clip.js';
import { recall, DEFAULT_RECALL } from '../src/recall.js';
import { record as recordHealth, emptyHealth, noteStall, classify, stalled, TimeoutError } from '../src/health.js';

export const STATE_KEY = 'canonkeeper';
export const STATE_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
    profileId: '',
    contextTokens: 200000,
    maxOutputTokens: 64000,
    // Live mode: off until turned on. The detector's profile defaults to the
    // writer's; a cheap fast model is the point.
    live: false,
    detectProfileId: '',
    cadence: DEFAULT_CADENCE,
    detectContextTokens: 32000,
    // The audit checks claims unless this is off, with its own profile, else
    // the detector's, else the writer's. A cheap model does well here too.
    auditVerify: true,
    auditProfileId: '',
    // Recall: off until turned on, because it adds to the roleplay prompt.
    recall: false,
    recallEntries: DEFAULT_RECALL.maxEntries,
    recallTokens: DEFAULT_RECALL.budgetTokens,
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
export function profileGenerate({ send, extract, profileId, log = () => {}, timeoutMs = 0 }) {
    return async ({ system, user, maxTokens }) => {
        const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
        log(`model call: ~${Math.ceil((system.length + user.length) / 3)} prompt tokens, up to ${maxTokens} out`);
        const started = Date.now();
        const call = send(profileId, messages, maxTokens, { stream: false, extractData: false, includePreset: false, includeInstruct: true });
        let timer;
        // The request itself can't be cancelled; the run just stops waiting for it.
        const json = await (timeoutMs ? Promise.race([call, new Promise((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(Math.round(timeoutMs / 1000))), timeoutMs); })]) : call).finally(() => clearTimeout(timer));
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
    // A book built in parts says so: it is not a one-shot result.
    const chunked = result.ledger.chunked ? ` Built in ${result.ledger.chunked.parts.length} parts (chunked): the chat was too long for one call.` : '';
    return `Canonkeeper: '${bookName}' has ${entries} entries; ${writes}; ${result.calls} model call${result.calls === 1 ? '' : 's'}; ${result.held.length} held; ${result.ledger.review.length} for review.${chunked}`;
}

/**
 * The other lorebooks active for the chat (the character's, global worlds,
 * the persona's), from `st.otherBooks()`, as the core's `foreign` entries:
 * every enabled entry, with its book's name. The chat's own book is never one
 * of them, whatever else it is bound as. Only read: nothing here writes them.
 */
export async function otherBooks(st, bookName, log = () => {}) {
    const books = [];
    const foreign = [];
    const seen = new Set([bookName]);
    for (const b of (await st.otherBooks?.()) ?? []) {
        if (!b?.name || seen.has(b.name)) continue;
        seen.add(b.name);
        const entries = Object.values(b.entries ?? {}).filter((e) => e && !e.disable);
        books.push({ name: b.name, via: b.via ?? null, entries: entries.length });
        foreign.push(...entries.map((entry) => ({ book: b.name, entry })));
    }
    if (books.length) log(`other active lorebooks, read only: ${books.map((b) => `'${b.name}' (${b.via ? `${b.via}, ` : ''}${b.entries} entries)`).join(', ')}`);
    else log('no other active lorebooks');
    return { books, foreign };
}

/** The chat's lorebook: the one bound to it, or a new one, created and bound. */
async function bindBook(st, log) {
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
    return bookName;
}

/**
 * Brings the chat's lorebook up to date with `messages` (the whole chat for
 * /canon, the finished scenes for live mode). Binds a book first if the chat
 * has none. Writes only the plan, and only if the same chat is still open and
 * the book didn't change while the model was working; otherwise throws.
 */
async function syncBook(st, { messages, ledger, starts, log }) {
    const bookName = await bindBook(st, log);
    const book = (await st.loadBook(bookName)) ?? { entries: {} };
    book.entries ??= {};
    const before = hashOf(book.entries);
    log(`lorebook '${bookName}': ${Object.keys(book.entries).length} entries`);
    const { books, foreign } = await otherBooks(st, bookName, log);

    const result = await update({
        book: structuredClone(book),
        ledger,
        messages,
        generate: st.generate,
        contextTokens: st.settings.contextTokens,
        maxOutputTokens: st.settings.maxOutputTokens,
        outputShare: st.settings.outputShare,
        starts,
        foreign,
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
    return { result: { ...result, books }, bookName, plan };
}

/** The record of a run that wrote (or could have), for the status view. */
function runRecord(result, plan, summary) {
    return {
        ok: true,
        summary,
        calls: result.calls,
        revision: result.ledger.revision,
        plan,
        held: result.held,
        review: result.ledger.review,
        scenes: result.scenes.boundaries,
        entries: Object.keys(result.book.entries).length,
        books: result.books,
    };
}

function runLog(st) {
    const lines = [];
    const log = (line) => {
        lines.push(`${new Date().toISOString()} ${line}`);
        st.log?.(line);
    };
    return { lines, log };
}

/**
 * Runs /canon once. `st` is everything the run needs from SillyTavern:
 *
 *   chatId, chat, metadata         the open chat and its chat_metadata
 *   currentChatId()                to check the same chat is still open
 *   bookExists(name), loadBook(name), saveBook(name, data), createBook(name)
 *   saveMetadata()
 *   generate                       the core's generate (profileGenerate)
 *   settings                       { contextTokens, maxOutputTokens, outputShare? }
 *   profile                        { id, name, model } for the record
 *   log(line)
 *
 * Returns { summary, result }. Throws, with nothing written to the book, if
 * the run fails, the chat is switched mid-run or the book changes under it.
 */
export async function runCanon(st) {
    const started = Date.now();
    const { lines, log } = runLog(st);
    const state = st.metadata[STATE_KEY] ?? {};
    const record = (extra) => {
        st.metadata[STATE_KEY] = {
            ...state,
            ...extra,
            version: STATE_VERSION,
            lastRun: { at: new Date(started).toISOString(), ms: Date.now() - started, profile: st.profile ?? null, trigger: 'canon', ...extra.lastRun, log: lines },
        };
    };

    try {
        const messages = toMessages(st.chat);
        if (!messages.length) throw new Error('the chat has no messages');
        log(`chat '${st.chatId}': ${messages.length} messages; ledger ${state.ledger ? `revision ${state.ledger.revision}` : 'none (full build)'}`);
        const { result, bookName, plan } = await syncBook(st, { messages, ledger: state.ledger, log });
        const summary = summarize(result, bookName);
        log(summary);
        record({ book: bookName, ledger: result.ledger, lastRun: runRecord(result, plan, summary) });
        await st.saveMetadata();
        return { summary, result, bookName };
    } catch (err) {
        log(`failed: ${err.message}`);
        record({ lastRun: { ok: false, error: err.message } });
        if (st.currentChatId() === st.chatId) await st.saveMetadata();
        throw err;
    }
}

/**
 * Folds health events into the chat's state store (src/health.js) and hands
 * the ones to be told about to `st.notify`. Nothing is saved here: the caller
 * saves the metadata.
 */
export function noteHealth(st, events, stall) {
    const state = st.metadata[STATE_KEY] ?? {};
    let { health, notify } = recordHealth(state.health, events);
    if (stall) {
        const s = noteStall(health, stall.is, { waiting: stall.waiting });
        health = s.health;
        notify = [...notify, ...s.notify];
    }
    if (state.health || JSON.stringify(health) !== JSON.stringify(emptyHealth())) st.metadata[STATE_KEY] = { ...st.metadata[STATE_KEY], health };
    if (notify.length) st.notify?.(notify);
    return health;
}

/**
 * One live-mode tick (src/live.js), run whenever the chat changes. `st` is as
 * for runCanon, plus `detectGenerate` (the detector's model) and, in
 * `settings`, `cadence` and `detectContextTokens`.
 *
 * Most ticks make no call and save nothing. A tick that detects, updates the
 * book or has to re-judge edited messages appends a cycle to
 * `chat_metadata.canonkeeper.live.cycles` and saves it with the chat, so the
 * cycles can be read from outside the page. Returns the cycle, or null.
 * Never throws: a failure is the cycle's record, and is tried again later.
 */
export async function runLive(st) {
    const started = Date.now();
    const { lines, log } = runLog(st);
    const state = st.metadata[STATE_KEY] ?? {};
    const cadence = st.settings.cadence ?? DEFAULT_CADENCE;
    const messages = toMessages(st.chat);
    const fresh = !isLive(state.live);
    let { live, rewound } = rewind(fresh ? seed(state.ledger, messages) : state.live, messages);
    const cycle = { at: new Date(started).toISOString(), messages: messages.length };
    if (fresh) cycle.seeded = live.hashes.length;
    if (rewound != null) {
        cycle.rewound = rewound;
        log(`messages from ${rewound} changed: judging them again`);
    }

    // A tick that gets this far has a profile and ran: those two are well.
    const events = [{ where: 'profile', kind: 'profile', ok: true }, { where: 'tick', kind: 'tick', ok: true }];
    const d = await detect({ live, messages, generate: st.detectGenerate, cadence, contextTokens: st.settings.detectContextTokens });
    live = d.live;
    if (d.detection) {
        cycle.detection = d.detection;
        events.push({ where: 'detector', kind: classify('detector', d.detection.error), ok: d.detection.ok, error: d.detection.error, profile: st.detectProfile?.name });
        log(d.detection.ok
            ? `detection: judged ${d.detection.judged.join('-')}, scene starts ${d.detection.starts.join(', ') || 'none'}`
            : `detection failed: ${d.detection.error}; trying again after ${cadence} more messages`);
    }
    if (st.currentChatId() !== st.chatId) return null;

    const extra = {};
    const target = updateTarget(live, state.ledger, messages);
    if (target) {
        log(`scene ended: bringing the book up to message ${target - 1}`);
        try {
            const { result, bookName, plan } = await syncBook(st, { messages: messages.slice(0, target), ledger: state.ledger, starts: live.starts, log });
            const summary = summarize(result, bookName);
            log(summary);
            const { failedTarget, updateRetryAt, ...rest } = live;
            live = { ...rest, updates: live.updates + 1 };
            cycle.update = { ok: true, through: target - 1, calls: result.calls, writes: plan.length, revision: result.ledger.revision };
            events.push({ where: 'update', kind: 'update', ok: true });
            extra.book = bookName;
            extra.ledger = result.ledger;
            extra.lastRun = { at: new Date(started).toISOString(), ms: Date.now() - started, profile: st.profile ?? null, trigger: 'live', ...runRecord(result, plan, summary), log: lines };
        } catch (err) {
            if (st.currentChatId() !== st.chatId) return null;
            log(`update failed: ${err.message}`);
            live = { ...live, failedTarget: target, updateRetryAt: messages.length + cadence };
            cycle.update = { ok: false, through: target - 1, error: err.message };
            events.push({ where: 'update', kind: classify('update', err), ok: false, error: err, profile: st.profile?.name });
        }
    }
    // Stalled: messages are piling up unjudged. Checked on every tick, even
    // one that made no call, since a failing detector is retried only later.
    const stall = { is: stalled(live, messages.length, cadence), waiting: messages.length - live.hashes.length };
    if (!fresh && rewound == null && !cycle.detection && !cycle.update) {
        if (st.currentChatId() !== st.chatId) return null;
        const before = JSON.stringify(state.health);
        st.metadata[STATE_KEY] = { ...state, live };
        noteHealth(st, events, stall);
        if (JSON.stringify(st.metadata[STATE_KEY].health) === before) {
            st.metadata[STATE_KEY] = state;
            return null;
        }
        await st.saveMetadata();
        return null;
    }
    if (st.currentChatId() !== st.chatId) return null;

    // A book just written is checked at once: the technical pass always (no
    // model call), claims only if an audit model is given, and then only the
    // facts the update added or changed (the verdict cache in the last audit
    // record covers the rest). Findings wait in the review queue.
    if (cycle.update?.ok) {
        st.metadata[STATE_KEY] = { ...state, ...extra, version: STATE_VERSION, live };
        try {
            const { record } = await runAudit(st, { verify: !!st.auditGenerate, generate: st.auditGenerate, profile: st.auditProfile ?? null });
            cycle.audit = { ok: true, findings: openFindings(record).length, checked: record.claims.checked, reused: record.reused, calls: record.calls };
            events.push({ where: 'audit', kind: 'audit', ok: true });
        } catch (err) {
            log(`audit failed: ${err.message}`);
            if (st.currentChatId() !== st.chatId) return null;
            cycle.audit = { ok: false, error: err.message };
            events.push({ where: 'audit', kind: classify('audit', err), ok: false, error: err, profile: st.auditProfile?.name });
        }
        extra.audit = st.metadata[STATE_KEY].audit;
    }
    cycle.ms = Date.now() - started;
    st.metadata[STATE_KEY] = { ...state, ...extra, version: STATE_VERSION, live: logCycle(live, cycle) };
    noteHealth(st, events, stall);
    await st.saveMetadata();
    return cycle;
}

// --- The audit ------------------------------------------------------------------

function auditSummary(record, bookName) {
    const open = openFindings(record);
    const errors = open.filter((f) => f.severity === 'error').length;
    const fixes = open.filter((f) => f.fix || f.recite).length;
    const c = record.claims;
    const claims = c.total ? ` ${c.checked} of ${c.total} claims verified${record.reused ? ` (${record.reused} kept from the last audit)` : ''}${c.stale ? `, ${c.stale} stale` : ''}.` : '';
    return `Canonkeeper audit of '${bookName}': ${open.length ? `${open.length} finding${open.length === 1 ? '' : 's'} (${errors} error${errors === 1 ? '' : 's'}), ${fixes} with a fix to review` : 'nothing found'}.${claims}`;
}

/** Claims per claim-check call in the panel: small enough that the count moves while it runs. */
const AUDIT_BATCH_CLAIMS = 20;

/**
 * Audits the chat's lorebook (src/audit.js) and keeps the result, the review
 * queue, in `chat_metadata.canonkeeper.audit`. Writes nothing to the book.
 * With `verify`, the writer's model re-checks every claim against the
 * messages it cites; without, only the technical pass runs and earlier
 * verdicts carry over. Throws if the chat has no lorebook or is switched.
 */
export async function runAudit(st, { verify = true, recheck = false, onProgress = null, generate = st.generate, profile = st.profile ?? null } = {}) {
    const started = Date.now();
    const { lines, log } = runLog(st);
    const state = st.metadata[STATE_KEY] ?? {};
    const bookName = st.metadata.world_info;
    const keep = (audit) => {
        st.metadata[STATE_KEY] = { ...state, version: STATE_VERSION, audit: { ...audit, ms: Date.now() - started, profile: verify ? profile : null, log: lines } };
    };
    try {
        if (!bookName) throw new Error('the chat has no lorebook: run /canon first');
        const messages = toMessages(st.chat);
        if (!messages.length) throw new Error('the chat has no messages');
        const book = (await st.loadBook(bookName)) ?? { entries: {} };
        book.entries ??= {};
        // The ledger describes the book /canon writes to. A book bound since
        // then has no history: its deletions can't be known.
        const ledger = state.book === bookName ? state.ledger ?? null : null;
        log(`auditing '${bookName}': ${Object.keys(book.entries).length} entries, ${messages.length} messages; ledger ${ledger ? `revision ${ledger.revision}` : 'none'}; ${verify ? 'verifying claims' : 'technical pass only'}`);
        const previous = state.audit?.book === bookName ? state.audit : null;
        const { books, foreign } = await otherBooks(st, bookName, log);
        const record = await audit({ book, ledger, messages, foreign, generate: verify ? generate : null, contextTokens: st.settings.contextTokens, maxOutputTokens: st.settings.maxOutputTokens, previous, profile: profile?.id ?? null, recheck, onProgress, batchClaims: AUDIT_BATCH_CLAIMS });
        if (st.currentChatId() !== st.chatId) throw new Error('the chat was switched during the audit; nothing was kept');
        const summary = auditSummary(record, bookName);
        log(summary);
        keep({ ...record, book: bookName, books, summary, accepted: previous?.accepted ?? [] });
        await st.saveMetadata();
        return { summary, record };
    } catch (err) {
        log(`audit failed: ${err.message}`);
        if (st.currentChatId() !== st.chatId) throw err;
        keep({ ...(state.audit ?? {}), error: { at: new Date(started).toISOString(), message: err.message } });
        await st.saveMetadata();
        throw err;
    }
}

/**
 * Accepts one finding's fix from the review queue: writes it to the book
 * (and the ledger), then runs the technical pass again, with no model call,
 * so the queue matches the book. Refuses, writing nothing, if the chat or
 * the book changed since the audit.
 */
export async function acceptFinding(st, id, choice = 'fix', edit = null, checked = null) {
    const state = st.metadata[STATE_KEY] ?? {};
    const record = state.audit;
    if (!record?.findings) throw new Error('no audit on this chat yet: run /canon-audit');
    const bookName = record.book;
    if (bookName !== st.metadata.world_info) throw new Error('the audit was of another lorebook: audit again');
    const messages = toMessages(st.chat);
    const book = (await st.loadBook(bookName)) ?? { entries: {} };
    book.entries ??= {};
    const ledger = state.book === bookName ? state.ledger ?? null : null;
    const { foreign } = await otherBooks(st, bookName);
    const out = await accept({ book, ledger, messages, record, id, foreign, choice, edit, checked });
    if (st.currentChatId() !== st.chatId) throw new Error('the chat was switched; nothing was written');
    await st.saveBook(bookName, out.book);
    st.log?.(`accepted ${id}: ${out.writes.join('; ') || 'no writes'}`);
    const next = await audit({ book: out.book, ledger: out.ledger, messages, foreign, previous: out.record });
    const accepted = [...(record.accepted ?? []), { id, at: new Date().toISOString(), says: choice === 'hand' ? `by hand: ${handSays(out, edit)}` : record.findings.find((f) => f.id === id)[choice === 'recite' ? 'recite' : 'fix'].says, writes: out.writes }];
    st.metadata[STATE_KEY] = {
        ...state,
        version: STATE_VERSION,
        ...(out.ledger && out.ledger !== ledger ? { ledger: out.ledger } : {}),
        audit: { ...record, ...next, book: bookName, summary: auditSummary(next, bookName), accepted },
    };
    await st.saveMetadata();
    return { writes: out.writes };
}

const handSays = (out, edit) => [edit?.text != null ? 'reworded' : '', edit?.messages ? `cited ${edit.messages.map((m) => `#${m}`).join(', ')}` : ''].filter(Boolean).join(', ');

/**
 * Runs the claim check on a person's change to a flagged fact, before it is
 * saved (src/audit.js checkHand). One model call through `st.generate`;
 * nothing is written. Returns { ok, verdict, why, text, messages, profile }.
 */
export async function checkFinding(st, id, edit) {
    const record = st.metadata[STATE_KEY]?.audit;
    if (!record?.findings) throw new Error('no audit on this chat yet: run /canon-audit');
    if (!st.generate) throw new Error('pick a connection profile in Extensions → Canonkeeper to check a change');
    return checkHand({ messages: toMessages(st.chat), record, id, edit, generate: st.generate, contextTokens: st.settings.contextTokens, maxOutputTokens: st.settings.maxOutputTokens, profile: st.profile?.id ?? null });
}

/** Whether an audit record still describes this book and this chat: its fixes can be accepted. */
export function auditIsCurrent(record, book, chat) {
    try {
        return record.bookHash === hashOf(book?.entries ?? {}) && record.fingerprint === fingerprint(toMessages(chat));
    } catch {
        return false;
    }
}

/** Dismisses a finding: it stays listed, and later audits keep it dismissed. */
export async function dismissFinding(st, id) {
    const state = st.metadata[STATE_KEY] ?? {};
    if (!state.audit?.findings) throw new Error('no audit on this chat yet: run /canon-audit');
    const next = dismiss(state.audit, id);
    st.metadata[STATE_KEY] = { ...state, version: STATE_VERSION, audit: { ...next, summary: auditSummary(next, next.book) } };
    await st.saveMetadata();
}

// --- Clips --------------------------------------------------------------------

/** Clips kept in the record, newest last. */
const CLIP_RECORDS = 50;

/**
 * Clips the passage `text` of message `at` (src/clip.js): one model call,
 * then one new entry in the chat's lorebook, bound first if the chat has
 * none. `st` is as for runCanon. The record goes to
 * `chat_metadata.canonkeeper.clips`. Throws, with nothing written to the
 * book, if the clip fails, the chat is switched or the book changes under it.
 */
export async function runClip(st, { at, text }) {
    const started = Date.now();
    const { lines, log } = runLog(st);
    const state = st.metadata[STATE_KEY] ?? {};
    const keep = (record) => {
        const clips = [...(state.clips ?? []), { at: new Date(started).toISOString(), ms: Date.now() - started, message: at, ...record, log: lines }].slice(-CLIP_RECORDS);
        st.metadata[STATE_KEY] = { ...state, version: STATE_VERSION, clips };
    };
    try {
        const messages = toMessages(st.chat);
        const bookName = await bindBook(st, log);
        const book = (await st.loadBook(bookName)) ?? { entries: {} };
        book.entries ??= {};
        const before = hashOf(book.entries);
        const { foreign } = await otherBooks(st, bookName, log);
        const ledger = state.book === bookName ? state.ledger ?? null : null;
        log(`clipping ${String(text ?? '').trim() ? `${String(text).trim().length} characters` : 'the whole message'} of message ${at} into '${bookName}'`);
        const { entry, dropped } = await clip({ book, ledger, foreign, messages, at, text, generate: st.generate });
        for (const d of dropped) log(`key '${d.key}' dropped: ${d.reason}`);

        if (st.currentChatId() !== st.chatId) throw new Error('the chat was switched during the clip; nothing was written');
        const now = (await st.loadBook(bookName)) ?? { entries: {} };
        if (hashOf(now.entries ?? {}) !== before) throw new Error('the lorebook changed during the clip; nothing was written. Clip again');
        await st.saveBook(bookName, { ...book, entries: { ...book.entries, [String(entry.uid)]: entry } });
        const summary = `Canonkeeper: clipped message ${at} into '${bookName}' as '${entry.comment}', keys ${entry.key.join(', ')}`;
        log(summary);
        keep({ ok: true, book: bookName, uid: entry.uid, title: entry.comment, keys: entry.key, dropped, summary });
        await st.saveMetadata();
        return { summary, entry, bookName };
    } catch (err) {
        log(`clip failed: ${err.message}`);
        if (st.currentChatId() !== st.chatId) throw err;
        keep({ ok: false, error: err.message });
        await st.saveMetadata();
        throw err;
    }
}

// --- Recall -------------------------------------------------------------------

/** The extension prompt recall writes its block to. Nothing else uses it. */
export const RECALL_PROMPT = 'canonkeeper_recall';

/** How long recall may hold up a generation before it is skipped. */
export const RECALL_TIMEOUT_MS = 1000;

/**
 * What recall reads for one generation: the chat's bound lorebook, the chat,
 * and the scene starts Canonkeeper knows for that book. Reads only.
 */
export async function recallInputs({ chat, metadata, loadBook, settings, scanDepth }) {
    const bookName = metadata?.world_info;
    if (!bookName) return null;
    const book = (await loadBook(bookName)) ?? { entries: {} };
    const state = metadata[STATE_KEY] ?? {};
    const mine = state.book === bookName;
    return {
        book: bookName,
        entries: Object.values(book.entries ?? {}),
        messages: toMessages(chat),
        starts: mine ? [...(state.ledger?.scenes ?? []), ...(state.live?.starts ?? [])] : [],
        maxEntries: Number(settings.recallEntries) || DEFAULT_RECALL.maxEntries,
        budgetTokens: Number(settings.recallTokens) || DEFAULT_RECALL.budgetTokens,
        scanDepth: Number(scanDepth) || DEFAULT_RECALL.scanDepth,
    };
}

/** The picks for `inputs`, leaving out the uids in `exclude`, with their entries. */
export function recallPicks(inputs, exclude = new Set()) {
    const out = recall({ ...inputs, exclude });
    const byUid = new Map(inputs.entries.map((e) => [e.uid, e]));
    return { ...out, entries: out.picks.map((p) => byUid.get(p.uid)) };
}

/** The block recall adds: the picked entries' text, one per line, as World Info joins its own. */
export const recallBlock = (entries) => entries.map((e) => String(e.content).trim()).join('\n');

/**
 * Recall across one generation. SillyTavern calls `intercept` before it
 * scans World Info (the generate interceptor), `activated` with what that
 * scan activated (WORLD_INFO_ACTIVATED), and `end` when the reply is done.
 *
 *   intercept   clears the block first, then picks and writes it
 *   activated   picks again without what World Info already has (an entry
 *               another entry's text names comes in by recursion, which
 *               plain code can't see coming), and rewrites the block
 *   end         clears the block, so it never outlives its generation
 *
 * The block is its own extension prompt, never scanned by World Info, so
 * World Info comes out exactly as it would with recall off: recall can only
 * add. Any failure, or a pick slower than RECALL_TIMEOUT_MS, leaves the
 * block empty, which is the prompt recall off gives. Nothing is written.
 *
 * `deps`: settings() (the extension's), inputs() (recallInputs for the open
 * chat), setPrompt(text), log(line).
 */
export function recallSession({ settings, inputs, setPrompt, log = () => {}, timeoutMs = RECALL_TIMEOUT_MS }) {
    let pending = null;
    const session = { last: null };
    const clear = () => {
        pending = null;
        setPrompt('');
    };
    const fail = (at, err) => {
        session.last = { at, ok: false, error: err.message };
        log(`recall failed, nothing added: ${err.message}`);
        try {
            clear();
        } catch (e) {
            log(`recall could not clear its block: ${e.message}`);
        }
    };
    const write = (at, data, out, inPrompt) => {
        setPrompt(recallBlock(out.entries));
        session.last = { at, ok: true, book: data.book, scene: out.scene, considered: out.considered, picks: out.picks, inPrompt };
    };

    session.intercept = async (type) => {
        clear();
        if (!settings().recall || type === 'quiet') return;
        const at = Date.now();
        try {
            // A pick that arrives late is dropped, never handed to a later reply.
            const work = inputs();
            const data = await Promise.race([work, new Promise((r) => setTimeout(() => r(undefined), timeoutMs))]);
            if (data === undefined) {
                work.catch(() => {});
                throw new Error(`took longer than ${timeoutMs} ms; skipped`);
            }
            if (!data) {
                session.last = { at, ok: true, book: null, scene: null, considered: 0, picks: [] };
                return;
            }
            const out = recallPicks(data);
            write(at, data, out, 0);
            pending = { at, data };
        } catch (err) {
            fail(at, err);
        }
    };

    session.activated = (entries) => {
        if (!pending) return;
        const { at, data } = pending;
        try {
            const inPrompt = new Set((entries ?? []).filter((e) => e?.world === data.book).map((e) => e.uid));
            const out = recallPicks(data, inPrompt);
            write(at, data, out, inPrompt.size);
        } catch (err) {
            fail(at, err);
        }
    };

    session.end = () => {
        const ended = pending;
        try {
            clear();
        } catch (err) {
            log(`recall could not clear its block: ${err.message}`);
        }
        const r = session.last;
        if (ended && r?.ok && r.picks.length) log(`recall added ${r.picks.map((p) => `'${p.title}' (~${p.tokens} tokens)`).join(', ')}; ${r.inPrompt} entries were already in World Info`);
    };
    return session;
}
