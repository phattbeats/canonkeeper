// The SillyTavern adapter: one command (/canon), one settings panel, one
// status view. Everything it uses from SillyTavern comes through the public
// SillyTavern.getContext() API, so it doesn't depend on where the extension
// is installed. The run itself is run.js; this file only wires it up.

import { runCanon, profileGenerate, DEFAULT_SETTINGS, STATE_KEY } from './run.js';

const NAME = 'canonkeeper';
const ctx = () => SillyTavern.getContext();
const log = (line) => console.info(`[Canonkeeper] ${line}`);

let running = false;

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
        const send = c.ConnectionManagerRequestService.sendRequest.bind(c.ConnectionManagerRequestService);
        const api = c.CONNECT_API_MAP[profile.api]?.selected;
        const { summary } = await runCanon({
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
            generate: profileGenerate({ send, extract: (json) => c.extractMessageFromData(json, api), profileId: profile.id, log }),
            settings: { contextTokens: Number(s.contextTokens), maxOutputTokens: Number(s.maxOutputTokens) },
            profile: { id: profile.id, name: profile.name, model: profile.model ?? null },
            log,
        });
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
        if (last.plan?.length) parts.push(`<details><summary>Writes (${last.plan.length})</summary><pre>${esc(last.plan.join('\n'))}</pre></details>`);
        if (last.held?.length) parts.push(`<details><summary>Held (${last.held.length})</summary><pre>${esc(last.held.map((h) => `${h.title}: ${h.reason}`).join('\n'))}</pre></details>`);
        if (last.review?.length) parts.push(`<details><summary>For review (${last.review.length})</summary><pre>${esc(last.review.map((r) => (typeof r === 'string' ? r : `${r.name ?? r.key ?? ''}: ${r.reason ?? JSON.stringify(r)}`)).join('\n'))}</pre></details>`);
        if (last.log?.length) parts.push(`<details><summary>Run log</summary><pre>${esc(last.log.join('\n'))}</pre></details>`);
    }
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
    const c = ctx();
    const select = document.getElementById('canonkeeper_profile');
    if (!select) return;
    let profiles;
    try {
        profiles = c.ConnectionManagerRequestService.getSupportedProfiles();
    } catch (err) {
        select.innerHTML = `<option value="">${esc(err.message)}: enable Connection Profiles</option>`;
        return;
    }
    const chosen = settings().profileId;
    const options = [...profiles].sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => `<option value="${esc(p.id)}" ${p.id === chosen ? 'selected' : ''}>${esc(p.name)}</option>`);
    const missing = chosen && !profiles.some((p) => p.id === chosen) ? '<option value="" selected>(the chosen profile is gone: pick another)</option>' : '';
    select.innerHTML = `<option value="" ${chosen ? '' : 'selected'}>Pick a connection profile</option>${missing}${options.join('')}`;
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
    log('loaded');
});
