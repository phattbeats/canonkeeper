// The SillyTavern adapter: one command (/canon), one settings panel, one
// status view. Everything it uses from SillyTavern comes through the public
// SillyTavern.getContext() API, so it doesn't depend on where the extension
// is installed. The run itself is run.js; this file only wires it up.

import { runCanon, runLive, runAudit, runClip, recallInputs, recallSession, RECALL_PROMPT, acceptFinding, dismissFinding, auditIsCurrent, profileGenerate, DEFAULT_SETTINGS, STATE_KEY } from './run.js';

const NAME = 'canonkeeper';
const ctx = () => SillyTavern.getContext();
const log = (line) => console.info(`[Canonkeeper] ${line}`);

let running = false;
// Set while SillyTavern is writing a reply: live mode waits for it to finish.
let generating = false;
let liveTimer = null;

/** The one settings object, filled in place: handlers hold on to it. */
function settings() {
    const all = ctx().extensionSettings;
    all[NAME] ??= {};
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) all[NAME][k] ??= v;
    return all[NAME];
}

function profileOf(id) {
    return ctx().extensionSettings.connectionManager?.profiles?.find((p) => p.id === id) ?? null;
}

/** The model behind a connection profile, as the core's generate. */
function generateFor(c, profile) {
    const send = c.ConnectionManagerRequestService.sendRequest.bind(c.ConnectionManagerRequestService);
    const api = c.CONNECT_API_MAP[profile.api]?.selected;
    return profileGenerate({ send, extract: (json) => c.extractMessageFromData(json, api), profileId: profile.id, log });
}

/** A slash command's piped result, or '' if it fails. */
async function piped(c, command) {
    try {
        const out = await c.executeSlashCommandsWithOptions(command, { handleParserErrors: false, handleExecutionErrors: false });
        return out?.isError ? '' : String(out?.pipe ?? '');
    } catch {
        return '';
    }
}

const listOf = (text) => {
    try {
        const v = JSON.parse(text);
        return Array.isArray(v) ? v.map(String).filter(Boolean) : text ? [String(v)] : [];
    } catch {
        return text ? [text] : [];
    }
};

/** A card's embedded book (character_book, V2 spec) as World Info entries. Nothing is written back. */
function embeddedEntries(book) {
    return Object.fromEntries((book?.entries ?? []).map((e, i) => {
        const uid = e.id ?? i;
        return [String(uid), {
            uid,
            key: e.keys ?? [],
            keysecondary: e.secondary_keys ?? [],
            comment: e.comment || e.name || '',
            content: e.content ?? '',
            constant: !!e.constant,
            disable: e.enabled === false,
            caseSensitive: e.case_sensitive ?? null,
        }];
    }));
}

/**
 * Every other lorebook active for the open chat, as SillyTavern's own World
 * Info would read it: each character's linked and additional books and
 * embedded card book (every member, in a group), the global worlds and the
 * persona's book. Read through public calls only; never written. The chat's
 * own book is dropped by the run (run.js otherBooks).
 */
async function activeBooks(c) {
    const books = [];
    const load = async (name, via) => {
        if (!name || books.some((b) => b.name === name)) return;
        if (!c.getWorldInfoNames().includes(name)) return;
        const data = await c.loadWorldInfo(name);
        books.push({ name, via, entries: structuredClone(data?.entries ?? {}) });
    };
    const members = c.groupId
        ? (c.groups.find((g) => g.id == c.groupId)?.members ?? []).map((avatar) => c.characters.find((x) => x.avatar === avatar)).filter(Boolean)
        : [c.characters[c.characterId]].filter(Boolean);
    for (const ch of members) {
        for (const name of [ch.data?.extensions?.world, ...listOf(await piped(c, `/getcharbook type=additional ${JSON.stringify(ch.avatar)}`))]) await load(name, `character ${ch.name}`);
        if (ch.data?.character_book?.entries?.length) books.push({ name: `${ch.name}'s card (embedded)`, via: `character ${ch.name}`, entries: embeddedEntries(ch.data.character_book) });
    }
    for (const name of listOf(await piped(c, '/getglobalbooks'))) await load(name, 'global');
    await load(c.powerUserSettings?.persona_description_lorebook, 'persona');
    return books;
}

/** Everything a run needs from SillyTavern, for the chat open now. */
function stFor(c, s, profile) {
    return {
        chatId: c.chatId,
        chat: c.chat,
        metadata: c.chatMetadata,
        currentChatId: () => ctx().chatId,
        bookExists: async (name) => c.getWorldInfoNames().includes(name),
        loadBook: async (name) => {
            const data = await c.loadWorldInfo(name);
            return data ? structuredClone(data) : null;
        },
        saveBook: async (name, data) => {
            await c.saveWorldInfo(name, data, true);
            c.reloadWorldInfoEditor(name, false);
        },
        createBook: async (name) => {
            await c.saveWorldInfo(name, { entries: {} }, true);
            await c.updateWorldInfoList();
        },
        otherBooks: () => activeBooks(c),
        saveMetadata: () => c.saveMetadata(),
        generate: generateFor(c, profile),
        // outputShare has no control in the panel: the live test sets it to
        // read the fixture story in parts on a small window.
        settings: {
            contextTokens: Number(s.contextTokens),
            maxOutputTokens: Number(s.maxOutputTokens),
            outputShare: Number(s.outputShare) || undefined,
            cadence: Number(s.cadence),
            detectContextTokens: Number(s.detectContextTokens),
        },
        profile: { id: profile.id, name: profile.name, model: profile.model ?? null },
        log,
    };
}

async function canon() {
    const c = ctx();
    const s = settings();
    const profile = profileOf(s.profileId);
    const refuse = running ? 'Canonkeeper is already running'
        : !c.chatId ? 'Open a chat first'
            : !profile ? 'Pick a connection profile in Extensions → Canonkeeper first' : null;
    if (refuse) {
        toastr.warning(refuse, 'Canonkeeper');
        throw new Error(refuse);
    }

    running = true;
    renderStatus('running');
    const toast = toastr.info('Reading the chat…', 'Canonkeeper', { timeOut: 0, extendedTimeOut: 0 });
    try {
        const { summary } = await runCanon(stFor(c, s, profile));
        toastr.success(summary, 'Canonkeeper');
        return summary;
    } catch (err) {
        toastr.error(err.message, 'Canonkeeper', { timeOut: 15000 });
        throw err;
    } finally {
        toastr.clear(toast);
        running = false;
        renderStatus();
    }
}

// --- The audit ------------------------------------------------------------------

/** Runs the audit on the open chat. Writes nothing to the book; fixes wait in the status view. */
async function canonAudit() {
    const c = ctx();
    const s = settings();
    const profile = profileOf(s.auditProfileId) ?? profileOf(s.detectProfileId) ?? profileOf(s.profileId);
    const verify = !!s.auditVerify;
    const refuse = running ? 'Canonkeeper is already running'
        : !c.chatId ? 'Open a chat first'
            : verify && !profile ? 'Pick a connection profile in Extensions → Canonkeeper first, or untick claim verification' : null;
    if (refuse) {
        toastr.warning(refuse, 'Canonkeeper');
        throw new Error(refuse);
    }
    running = true;
    renderStatus('running');
    const toast = toastr.info(verify ? 'Auditing the lorebook and checking its claims…' : 'Auditing the lorebook…', 'Canonkeeper', { timeOut: 0, extendedTimeOut: 0 });
    try {
        const st = profile ? stFor(c, s, profile) : { ...stFor(c, s, { id: '', name: '' }), generate: null };
        const { summary } = await runAudit(st, { verify });
        toastr.success(summary, 'Canonkeeper');
        return summary;
    } catch (err) {
        toastr.error(err.message, 'Canonkeeper', { timeOut: 15000 });
        throw err;
    } finally {
        toastr.clear(toast);
        running = false;
        renderStatus();
    }
}

/** Accept or dismiss one finding of the review queue. */
async function onFinding(action, id) {
    const c = ctx();
    if (running) return toastr.warning('Wait for the run to finish', 'Canonkeeper');
    running = true;
    try {
        const st = { ...stFor(c, settings(), { id: '', name: '' }), generate: null };
        if (action === 'accept') {
            const { writes } = await acceptFinding(st, id);
            toastr.success(writes.length ? writes.join('\n') : 'No change was needed', 'Canonkeeper: fix accepted');
        } else await dismissFinding(st, id);
    } catch (err) {
        toastr.error(err.message, 'Canonkeeper', { timeOut: 15000 });
    } finally {
        running = false;
        renderStatus();
    }
}

// --- Clips --------------------------------------------------------------------

/**
 * The last passage highlighted inside a message, kept as it was selected:
 * opening the message's action menu to press the clip button clears the
 * selection on the page.
 */
let selection = null;

function trackSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    const mes = $(sel.anchorNode?.parentElement).closest('#chat .mes');
    const inText = $(sel.anchorNode?.parentElement).closest('.mes_text').length && $(sel.focusNode?.parentElement).closest('.mes').is(mes);
    if (text && mes.length && inText) selection = { at: Number(mes.attr('mesid')), text };
}

/** Clips a passage of message `at` (the whole message for empty `text`) into the chat's lorebook. */
async function canonClip(at, text) {
    const c = ctx();
    const s = settings();
    const profile = profileOf(s.profileId);
    const refuse = running ? 'Canonkeeper is already running'
        : generating ? 'Wait for the reply to finish'
            : !c.chatId ? 'Open a chat first'
                : !profile ? 'Pick a connection profile in Extensions → Canonkeeper first' : null;
    if (refuse) {
        toastr.warning(refuse, 'Canonkeeper');
        throw new Error(refuse);
    }
    running = true;
    renderStatus('running');
    const toast = toastr.info(`Clipping message ${at}…`, 'Canonkeeper', { timeOut: 0, extendedTimeOut: 0 });
    try {
        const { summary } = await runClip(stFor(c, s, profile), { at, text });
        toastr.success(summary, 'Canonkeeper');
        return summary;
    } catch (err) {
        toastr.error(err.message, 'Canonkeeper: nothing clipped', { timeOut: 15000 });
        throw err;
    } finally {
        toastr.clear(toast);
        running = false;
        renderStatus();
    }
}

function onClipButton() {
    const at = Number($(this).closest('.mes').attr('mesid'));
    const text = selection?.at === at ? selection.text : '';
    selection = null;
    canonClip(at, text).catch(() => {});
}

// --- Recall -------------------------------------------------------------------

/** SillyTavern's World Info scan depth, as its own settings panel shows it. */
function scanDepth() {
    const n = Number($('#world_info_depth').val());
    return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Recall's block is its own extension prompt (IN_PROMPT, as a system
 * message), never scanned by World Info. See recallSession in run.js.
 */
const recallState = recallSession({
    settings,
    inputs: () => {
        const c = ctx();
        return recallInputs({ chat: c.chat, metadata: c.chatMetadata, loadBook: c.loadWorldInfo, settings: settings(), scanDepth: scanDepth() });
    },
    setPrompt: (text) => ctx().setExtensionPrompt(RECALL_PROMPT, text, 0, 0, false, 0),
    log,
});

/** The generate interceptor (manifest.json): runs before SillyTavern scans World Info. Never aborts. */
globalThis.canonkeeperRecall = async (chat, contextSize, abort, type) => recallState.intercept(type);

// --- Live mode ----------------------------------------------------------------

/**
 * Runs a live tick soon. Called on every chat event; the tick itself decides
 * whether anything is due (src/live.js), so most make no call. It waits for
 * a reply being written and for a /canon run to finish.
 */
function scheduleLive(delay = 1000) {
    if (!settings().live) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => liveTick().catch((err) => log(`live tick failed: ${err.message}`)), delay);
}

async function liveTick() {
    const c = ctx();
    const s = settings();
    if (!s.live || !c.chatId || !c.chat?.length) return;
    if (running || generating || c.streamingProcessor) return scheduleLive(3000);
    const writer = profileOf(s.profileId);
    if (!writer) return log('live mode is on but no connection profile is picked');
    const detector = profileOf(s.detectProfileId) ?? writer;
    running = true;
    let cycle = null;
    try {
        cycle = await runLive({ ...stFor(c, s, writer), detectGenerate: generateFor(c, detector) });
        if (cycle?.update && !cycle.update.ok) toastr.warning(`Live update failed: ${cycle.update.error}`, 'Canonkeeper');
    } finally {
        running = false;
        renderStatus();
    }
    // Messages may have arrived meanwhile, or a long history may need more
    // than one detection: look again. A tick with nothing due costs nothing.
    if (cycle) scheduleLive(500);
}

// --- Settings panel and status view -----------------------------------------

const html = `
<div id="canonkeeper_settings" class="canonkeeper">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Canonkeeper</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label for="canonkeeper_profile">Connection profile (the model that writes the lorebook)</label>
      <select id="canonkeeper_profile" class="text_pole"></select>
      <div class="canonkeeper-row">
        <label>Context window (tokens)
          <input id="canonkeeper_context" class="text_pole" type="number" min="1000" step="1000"></label>
        <label>Max output (tokens)
          <input id="canonkeeper_output" class="text_pole" type="number" min="1000" step="1000"></label>
      </div>
      <div class="canonkeeper-row">
        <div id="canonkeeper_run" class="menu_button">Run /canon</div>
        <div id="canonkeeper_audit" class="menu_button">Audit</div>
      </div>
      <label class="checkbox_label" for="canonkeeper_audit_verify">
        <input id="canonkeeper_audit_verify" type="checkbox">
        <span>Audit also checks every claim against the messages it cites (one model call per batch)</span>
      </label>
      <label for="canonkeeper_audit_profile">Claim check profile (a cheap model does well)</label>
      <select id="canonkeeper_audit_profile" class="text_pole"></select>
      <hr>
      <label class="checkbox_label" for="canonkeeper_live">
        <input id="canonkeeper_live" type="checkbox">
        <span>Live mode: keep the lorebook up to date while you play</span>
      </label>
      <div><small>A cheap model checks for a new scene every few messages. When a scene ends, the book is brought up to date with it.</small></div>
      <label for="canonkeeper_detect_profile">Scene detection profile (a cheap, fast model)</label>
      <select id="canonkeeper_detect_profile" class="text_pole"></select>
      <div class="canonkeeper-row">
        <label>Check every (messages)
          <input id="canonkeeper_cadence" class="text_pole" type="number" min="1" step="1"></label>
        <label>Detection context (tokens)
          <input id="canonkeeper_detect_context" class="text_pole" type="number" min="2000" step="1000"></label>
      </div>
      <hr>
      <label class="checkbox_label" for="canonkeeper_recall">
        <input id="canonkeeper_recall" type="checkbox">
        <span>Recall: each turn, add a few more entries the open scene is about</span>
      </label>
      <div><small>On top of keyword activation: entries named earlier in the scene that the last messages no longer mention. No model call. If it fails, the reply goes ahead without it.</small></div>
      <div class="canonkeeper-row">
        <label>At most (entries)
          <input id="canonkeeper_recall_entries" class="text_pole" type="number" min="1" step="1"></label>
        <label>Within (tokens)
          <input id="canonkeeper_recall_tokens" class="text_pole" type="number" min="50" step="50"></label>
      </div>
      <div><small>Clips: highlight a passage in a message, then press <i class="fa-solid fa-scissors"></i> in its message actions (or type <code>/canon-clip at=&lt;message&gt; &lt;passage&gt;</code>). It becomes an entry with a blurb and keys.</small></div>
      <hr>
      <b>Status (this chat)</b>
      <div id="canonkeeper_status" class="canonkeeper-status"></div>
    </div>
  </div>
</div>`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

async function renderStatus(phase) {
    const el = document.getElementById('canonkeeper_status');
    if (!el) return;
    const c = ctx();
    if (!c.chatId) {
        el.innerHTML = '<i>No chat open.</i>';
        return;
    }
    const state = c.chatMetadata?.[STATE_KEY];
    const last = state?.lastRun;
    const parts = [];
    if (phase === 'running' || running) parts.push('<div class="canonkeeper-running">Running…</div>');
    if (!last) parts.push('<i>Not run on this chat yet. Run /canon.</i>');
    else {
        parts.push(`<div>Last run: ${esc(new Date(last.at).toLocaleString())}, ${esc(Math.round(last.ms / 1000))}s, ${esc(last.profile?.name ?? '?')}${last.profile?.model ? ` (${esc(last.profile.model)})` : ''}</div>`);
        if (last.ok) parts.push(`<div class="canonkeeper-ok">${esc(last.summary)}</div>`);
        else parts.push(`<div class="canonkeeper-error">Failed: ${esc(last.error)}</div>`);
        if (state.ledger) parts.push(`<div>Ledger revision ${esc(state.ledger.revision)}, ${esc(state.ledger.messageCount)} messages, ${esc(state.ledger.scenes.length + 1)} scenes</div>`);
        if (state.ledger?.chunked) parts.push(`<div class="canonkeeper-chunked">Chunked build: read in ${esc(state.ledger.chunked.parts.length)} parts (${esc(state.ledger.chunked.parts.map((p) => `${p.from}–${p.to}`).join(', '))}), then reconciled. Not a one-shot result.</div>`);
        if (last.books) parts.push(`<div>Other lorebooks consulted (read only): ${last.books.length ? last.books.map((b) => `${esc(b.name)} <small>(${esc(b.via ?? '?')}, ${esc(b.entries)} entries)</small>`).join(', ') : 'none'}</div>`);
        if (last.plan?.length) parts.push(`<details><summary>Writes (${last.plan.length})</summary><pre>${esc(last.plan.join('\n'))}</pre></details>`);
        if (last.held?.length) parts.push(`<details><summary>Held (${last.held.length})</summary><pre>${esc(last.held.map((h) => `${h.title}: ${h.reason}`).join('\n'))}</pre></details>`);
        if (last.review?.length) parts.push(`<details><summary>For review (${last.review.length})</summary><pre>${esc(last.review.map((r) => (typeof r === 'string' ? r : `${r.name ?? r.key ?? ''}: ${r.reason ?? JSON.stringify(r)}`)).join('\n'))}</pre></details>`);
        if (last.log?.length) parts.push(`<details><summary>Run log</summary><pre>${esc(last.log.join('\n'))}</pre></details>`);
    }
    if (settings().live || state?.live) parts.push(liveStatus(state?.live));
    if (settings().recall || recallState.last) parts.push(recallStatus());
    if (state?.clips?.length) parts.push(clipStatus(state.clips));
    const bookName = state?.book;
    const bound = c.chatMetadata.world_info;
    const boundBook = bound ? await c.loadWorldInfo(bound) : null;
    if (state?.audit) parts.push(auditStatus(state.audit, state.audit.book === bound && auditIsCurrent(state.audit, boundBook, c.chat)));
    if (bookName && bookName === bound) {
        const book = boundBook;
        const entries = Object.values(book?.entries ?? {}).filter((e) => e.canonkeeper).sort((a, b) => a.uid - b.uid);
        if (entries.length) {
            const rows = entries.map((e) => `<label class="canonkeeper-entry"><input type="checkbox" data-uid="${esc(e.uid)}" ${e.canonkeeper.pinned ? 'checked' : ''}> ${esc(e.comment)} <small>${esc((e.key ?? []).join(', '))}</small></label>`);
            parts.push(`<details><summary>Entries in '${esc(bookName)}' (${entries.length}); tick to pin</summary>${rows.join('')}</details>`);
        }
    }
    // Re-rendering keeps open whichever sections were open, so ticking one
    // pin doesn't fold the list away.
    const open = new Set([...el.querySelectorAll('details[open] > summary')].map((x) => x.textContent.split(' ')[0]));
    el.innerHTML = parts.join('');
    el.querySelectorAll('details > summary').forEach((x) => {
        if (open.has(x.textContent.split(' ')[0])) x.parentElement.open = true;
    });
    el.querySelectorAll('input[data-uid]').forEach((box) => box.addEventListener('change', () => setPin(bookName, box.dataset.uid, box.checked)));
    el.querySelectorAll('[data-finding]').forEach((b) => b.addEventListener('click', () => onFinding(b.dataset.action, b.dataset.finding)));
}

/**
 * The review queue: the last audit's open findings, each with its fix to
 * accept and a dismiss button. Nothing in it is applied until accepted, and
 * a fix can only be accepted while the audit still matches the book and chat.
 */
function auditStatus(a, current) {
    const head = `<b>Audit</b>${a.at ? ` ${esc(new Date(a.at).toLocaleString())}` : ''}`;
    if (!a.findings) return `<div>${head}: <span class="canonkeeper-error">failed: ${esc(a.error?.message)}</span></div>`;
    const open = a.findings.filter((f) => !f.dismissed);
    const line = (f) => {
        const buttons = [
            f.fix && current ? `<div class="menu_button canonkeeper-fix" data-action="accept" data-finding="${esc(f.id)}" title="${esc(f.fix.says)}">Accept: ${esc(f.fix.says)}</div>` : '',
            `<div class="menu_button" data-action="dismiss" data-finding="${esc(f.id)}">Dismiss</div>`,
        ].join('');
        return `<div class="canonkeeper-finding canonkeeper-${f.severity}" data-id="${esc(f.id)}"><span>${f.severity === 'error' ? '✖' : '⚠'} ${esc(f.check)}: ${esc(f.message)}</span>${f.held ? ` <small>(held: ${esc(f.held)})</small>` : ''}<div class="canonkeeper-row">${buttons}</div></div>`;
    };
    const parts = [`<div>${head}: ${esc(a.summary ?? '')}</div>`];
    if (a.books?.length) parts.push(`<div><small>Also read for key clashes: ${esc(a.books.map((b) => b.name).join(', '))}</small></div>`);
    if (a.error) parts.push(`<div class="canonkeeper-error">Last audit failed: ${esc(a.error.message)}</div>`);
    if (!current && open.some((f) => f.fix)) parts.push('<div class="canonkeeper-chunked">The book or the chat changed since this audit: audit again to accept a fix.</div>');
    if (open.length) parts.push(`<details open><summary>Review queue (${open.length})</summary>${open.map(line).join('')}</details>`);
    const dismissed = a.findings.filter((f) => f.dismissed);
    if (dismissed.length) parts.push(`<details><summary>Dismissed (${dismissed.length})</summary><pre>${esc(dismissed.map((f) => `${f.check}: ${f.message}`).join('\n'))}</pre></details>`);
    if (a.accepted?.length) parts.push(`<details><summary>Accepted (${a.accepted.length})</summary><pre>${esc(a.accepted.map((x) => `${new Date(x.at).toLocaleString()} ${x.says}: ${x.writes.join('; ') || 'no writes'}`).join('\n'))}</pre></details>`);
    if (a.log?.length) parts.push(`<details><summary>Audit log</summary><pre>${esc(a.log.join('\n'))}</pre></details>`);
    return parts.join('');
}

/** What recall added to the last reply's prompt. */
function recallStatus() {
    const head = `<b>Recall ${settings().recall ? 'on' : 'off'}</b>`;
    const r = recallState.last;
    if (!r) return `<div>${head}: no reply generated since the page loaded.</div>`;
    const when = new Date(r.at).toLocaleTimeString();
    if (!r.ok) return `<div>${head}: last reply (${esc(when)}) <span class="canonkeeper-error">failed, nothing added: ${esc(r.error)}</span></div>`;
    const what = r.picks.length ? `added ${r.picks.map((p) => `<span class="canonkeeper-recalled" data-uid="${esc(p.uid)}">${esc(p.title)}</span> <small>(~${esc(p.tokens)} tokens, last named at ${esc(p.last)})</small>`).join(', ')}` : 'nothing to add';
    return `<div>${head}: last reply (${esc(when)}), scene ${esc(r.scene?.join('–') ?? '?')}: ${what}${r.inPrompt ? ` <small>(${esc(r.inPrompt)} entries of the book were already in World Info)</small>` : ''}</div>`;
}

/** The clips made on this chat, newest first. */
function clipStatus(clips) {
    const line = (x) => `${new Date(x.at).toLocaleString()} #${x.message}: ${x.ok ? `${x.title} (keys ${x.keys.join(', ')})${x.dropped?.length ? `; dropped ${x.dropped.map((d) => `${d.key}: ${d.reason}`).join('; ')}` : ''}` : `failed: ${x.error}`}`;
    return `<details><summary>Clips (${clips.length})</summary><pre>${esc(clips.slice().reverse().map(line).join('\n'))}</pre></details>`;
}

/** The live state store, for the status view: counts, scene starts, recent cycles. */
function liveStatus(live) {
    const head = `<b>Live mode ${settings().live ? 'on' : 'off'}</b>`;
    if (!live?.cycles) return `<div>${head}: no cycles yet on this chat.</div>`;
    const cycleLine = (x) => {
        const d = x.detection;
        const u = x.update;
        return [
            `${new Date(x.at).toLocaleTimeString()} @${x.messages}`,
            x.seeded != null ? `started (${x.seeded} already covered)` : '',
            x.rewound != null ? `re-judging from ${x.rewound}` : '',
            d ? (d.ok ? `judged ${d.judged.join('–')}: ${d.starts.length ? `scene starts ${d.starts.join(', ')}` : 'no new scene'}` : `detection failed: ${d.error}`) : '',
            u ? (u.ok ? `book updated through ${u.through} (${u.writes} writes, revision ${u.revision})` : `update failed: ${u.error}`) : '',
        ].filter(Boolean).join(' · ');
    };
    const recent = live.cycles.slice(-30).reverse().map(cycleLine);
    return `<div>${head}: ${esc(live.hashes.length)} messages judged, ${esc(live.starts.length + 1)} scenes (starts ${esc(live.starts.join(', ') || 'none yet')}), ${esc(live.detectCalls)} detection calls, ${esc(live.updates)} updates, ${esc(live.cycles.length)} cycles</div>`
        + `<details><summary>Cycles (${live.cycles.length})</summary><pre>${esc(recent.join('\n'))}</pre></details>`;
}

/** A pin is the human's: Canonkeeper never changes a pinned entry. */
async function setPin(bookName, uid, pinned) {
    const c = ctx();
    if (running) {
        toastr.warning('Wait for the run to finish', 'Canonkeeper');
        return renderStatus();
    }
    const book = structuredClone(await c.loadWorldInfo(bookName));
    const entry = book?.entries?.[uid];
    if (!entry?.canonkeeper) return renderStatus();
    entry.canonkeeper = { ...entry.canonkeeper, pinned };
    await c.saveWorldInfo(bookName, book, true);
    c.reloadWorldInfoEditor(bookName, false);
    log(`${pinned ? 'pinned' : 'unpinned'} '${entry.comment}'`);
    renderStatus();
}

/**
 * The profile list, rebuilt from scratch whenever a profile is created,
 * changed or deleted, so a profile made after install shows up at once.
 */
function renderProfiles() {
    renderProfileSelect('canonkeeper_profile', 'profileId', 'Pick a connection profile');
    renderProfileSelect('canonkeeper_detect_profile', 'detectProfileId', 'Same as the profile above');
    renderProfileSelect('canonkeeper_audit_profile', 'auditProfileId', 'Same as scene detection');
}

function renderProfileSelect(id, setting, none) {
    const c = ctx();
    const select = document.getElementById(id);
    if (!select) return;
    let profiles;
    try {
        profiles = c.ConnectionManagerRequestService.getSupportedProfiles();
    } catch (err) {
        select.innerHTML = `<option value="">${esc(err.message)}: enable Connection Profiles</option>`;
        return;
    }
    const chosen = settings()[setting];
    const options = [...profiles].sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => `<option value="${esc(p.id)}" ${p.id === chosen ? 'selected' : ''}>${esc(p.name)}</option>`);
    const missing = chosen && !profiles.some((p) => p.id === chosen) ? '<option value="" selected>(the chosen profile is gone: pick another)</option>' : '';
    select.innerHTML = `<option value="" ${chosen ? '' : 'selected'}>${none}</option>${missing}${options.join('')}`;
}

function mountSettings() {
    const c = ctx();
    const s = settings();
    $('#extensions_settings2').append(html);
    $('#canonkeeper_context').val(s.contextTokens).on('change', function () {
        s.contextTokens = Math.max(1000, Math.floor(Number(this.value) || DEFAULT_SETTINGS.contextTokens));
        this.value = s.contextTokens;
        c.saveSettingsDebounced();
    });
    $('#canonkeeper_output').val(s.maxOutputTokens).on('change', function () {
        s.maxOutputTokens = Math.max(1000, Math.floor(Number(this.value) || DEFAULT_SETTINGS.maxOutputTokens));
        this.value = s.maxOutputTokens;
        c.saveSettingsDebounced();
    });
    $('#canonkeeper_profile').on('change', function () {
        s.profileId = String(this.value);
        c.saveSettingsDebounced();
    });
    $('#canonkeeper_detect_profile').on('change', function () {
        s.detectProfileId = String(this.value);
        c.saveSettingsDebounced();
    });
    $('#canonkeeper_audit_profile').on('change', function () {
        s.auditProfileId = String(this.value);
        c.saveSettingsDebounced();
    });
    $('#canonkeeper_live').prop('checked', !!s.live).on('change', function () {
        s.live = !!this.checked;
        c.saveSettingsDebounced();
        renderStatus();
        scheduleLive();
    });
    $('#canonkeeper_cadence').val(s.cadence).on('change', function () {
        s.cadence = Math.max(1, Math.floor(Number(this.value) || DEFAULT_SETTINGS.cadence));
        this.value = s.cadence;
        c.saveSettingsDebounced();
    });
    $('#canonkeeper_detect_context').val(s.detectContextTokens).on('change', function () {
        s.detectContextTokens = Math.max(2000, Math.floor(Number(this.value) || DEFAULT_SETTINGS.detectContextTokens));
        this.value = s.detectContextTokens;
        c.saveSettingsDebounced();
    });
    renderProfiles();
    for (const event of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']) {
        if (c.eventTypes[event]) c.eventSource.on(c.eventTypes[event], () => setTimeout(renderProfiles));
    }
    $('#canonkeeper_run').on('click', () => canon().catch(() => {}));
    $('#canonkeeper_audit').on('click', () => canonAudit().catch(() => {}));
    $('#canonkeeper_audit_verify').prop('checked', !!s.auditVerify).on('change', function () {
        s.auditVerify = !!this.checked;
        c.saveSettingsDebounced();
    });
    $('#canonkeeper_recall').prop('checked', !!s.recall).on('change', function () {
        s.recall = !!this.checked;
        c.saveSettingsDebounced();
        renderStatus();
    });
    $('#canonkeeper_recall_entries').val(s.recallEntries).on('change', function () {
        s.recallEntries = Math.max(1, Math.floor(Number(this.value) || DEFAULT_SETTINGS.recallEntries));
        this.value = s.recallEntries;
        c.saveSettingsDebounced();
    });
    $('#canonkeeper_recall_tokens').val(s.recallTokens).on('change', function () {
        s.recallTokens = Math.max(50, Math.floor(Number(this.value) || DEFAULT_SETTINGS.recallTokens));
        this.value = s.recallTokens;
        c.saveSettingsDebounced();
    });
    renderStatus();
}

function registerCommand() {
    const c = ctx();
    c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
        name: 'canon',
        callback: async () => canon(),
        returns: 'a one-line summary of the run',
        helpString: 'Canonkeeper: brings this chat\'s lorebook up to date with the story. The first run builds it; later runs re-read only what changed. Pinned and hand-edited entries are never touched, and the other active lorebooks (character, global, persona) are only read: what they already cover gets no second entry.',
    }));
    c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
        name: 'canon-audit',
        callback: async () => canonAudit(),
        returns: 'a one-line summary of the audit',
        helpString: 'Canonkeeper: audits this chat\'s lorebook. Finds keys claimed by two entries, entries with no keys, keys that fire on nearly everything, settings that stop an entry firing, and deleted entries; optionally checks every claim against the messages it cites. Writes nothing: fixes wait in Extensions → Canonkeeper for you to accept.',
    }));
    c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
        name: 'canon-clip',
        callback: async (args, text) => {
            const at = args.at === undefined || args.at === '' ? c.chat.length - 1 : Number(args.at);
            return canonClip(at, String(text ?? ''));
        },
        returns: 'a one-line summary of the clip',
        namedArgumentList: [
            c.SlashCommandNamedArgument.fromProps({ name: 'at', description: 'the message id to clip from (default: the last message)', typeList: [c.ARGUMENT_TYPE.NUMBER] }),
        ],
        unnamedArgumentList: [
            c.SlashCommandArgument.fromProps({ description: 'the passage to clip, as it appears in the message (default: the whole message)', typeList: [c.ARGUMENT_TYPE.STRING] }),
        ],
        helpString: 'Canonkeeper: clips a passage of a message into this chat\'s lorebook as a new entry, with a short blurb and keys that bring it back when the story returns to it. One model call. /canon never rewrites a clip.',
    }));
}

/** The clip button, in every message's action menu. */
function mountClipButton() {
    const button = '<div title="Canonkeeper: clip the highlighted passage (or the whole message) into the lorebook" class="mes_button canonkeeper_clip fa-solid fa-scissors"></div>';
    $('#message_template .mes_buttons .extraMesButtons').prepend(button);
    $(document).on('click', '.canonkeeper_clip', onClipButton);
    document.addEventListener('selectionchange', trackSelection);
}

jQuery(async () => {
    mountSettings();
    registerCommand();
    mountClipButton();
    const c = ctx();
    c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => renderStatus());
    // Live mode looks at the chat after anything that changes it. A reply
    // being written is waited out; a message is judged once it's complete.
    c.eventSource.on(c.eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
        if (!dryRun) generating = true;
    });
    for (const event of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        c.eventSource.on(c.eventTypes[event], () => {
            generating = false;
            recallState.end();
            scheduleLive();
            if (recallState.last) renderStatus();
        });
    }
    c.eventSource.on(c.eventTypes.WORLD_INFO_ACTIVATED, (entries) => recallState.activated(entries));
    for (const event of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) {
        c.eventSource.on(c.eventTypes[event], () => scheduleLive());
    }
    log('loaded');
});
