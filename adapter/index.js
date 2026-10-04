// The SillyTavern adapter: one command (/canon), one settings panel, one
// status view. Everything it uses from SillyTavern comes through the public
// SillyTavern.getContext() API, so it doesn't depend on where the extension
// is installed. The run itself is run.js; this file only wires it up.

import { runCanon, runLive, profileGenerate, DEFAULT_SETTINGS, STATE_KEY } from './run.js';

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
      </div>
      <hr>
      <label class="checkbox_label" for="canonkeeper_live">
        <input id="canonkeeper_live" type="checkbox">
        <span>Live mode: keep the lorebook up to date while you play</span>
      </label>
      <small>A cheap model checks for a new scene every few messages. When a scene ends, the book is brought up to date with it.</small>
      <label for="canonkeeper_detect_profile">Scene detection profile (a cheap, fast model)</label>
      <select id="canonkeeper_detect_profile" class="text_pole"></select>
      <div class="canonkeeper-row">
        <label>Check every (messages)
          <input id="canonkeeper_cadence" class="text_pole" type="number" min="1" step="1"></label>
        <label>Detection context (tokens)
          <input id="canonkeeper_detect_context" class="text_pole" type="number" min="2000" step="1000"></label>
      </div>
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
        if (last.plan?.length) parts.push(`<details><summary>Writes (${last.plan.length})</summary><pre>${esc(last.plan.join('\n'))}</pre></details>`);
        if (last.held?.length) parts.push(`<details><summary>Held (${last.held.length})</summary><pre>${esc(last.held.map((h) => `${h.title}: ${h.reason}`).join('\n'))}</pre></details>`);
        if (last.review?.length) parts.push(`<details><summary>For review (${last.review.length})</summary><pre>${esc(last.review.map((r) => (typeof r === 'string' ? r : `${r.name ?? r.key ?? ''}: ${r.reason ?? JSON.stringify(r)}`)).join('\n'))}</pre></details>`);
        if (last.log?.length) parts.push(`<details><summary>Run log</summary><pre>${esc(last.log.join('\n'))}</pre></details>`);
    }
    if (settings().live || state?.live) parts.push(liveStatus(state?.live));
    const bookName = state?.book;
    if (bookName && bookName === c.chatMetadata.world_info) {
        const book = await c.loadWorldInfo(bookName);
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
    renderStatus();
}

function registerCommand() {
    const c = ctx();
    c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
        name: 'canon',
        callback: async () => canon(),
        returns: 'a one-line summary of the run',
        helpString: 'Canonkeeper: brings this chat\'s lorebook up to date with the story. The first run builds it; later runs re-read only what changed. Pinned and hand-edited entries are never touched.',
    }));
}

jQuery(async () => {
    mountSettings();
    registerCommand();
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
            scheduleLive();
        });
    }
    for (const event of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) {
        c.eventSource.on(c.eventTypes[event], () => scheduleLive());
    }
    log('loaded');
});
