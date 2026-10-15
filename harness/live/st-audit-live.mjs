// Live acceptance run for the audit live mode runs after each update, driven
// from outside the page. A fresh SillyTavern gets the extension from the repo
// URL, a writer profile, a cheap detector/claim-check profile and a roleplay
// connection that replays the transcript's narrator. Claim verification is
// ticked, the claim-check profile picked, live mode on. The transcript is then
// played one message at a time, as st-session.mjs plays it.
//
// After the first live update that wrote a book, two hand-made entries keyed
// 'Zedwin Varrocks' are saved to the chat's lorebook through SillyTavern's own
// World Info functions, as the editor saves them. Nobody clicks Audit or types
// /canon-audit. Checked from the chat file, read over SillyTavern's HTTP API:
//   LA1  the first update after the plant was audited (audit.ok)
//   LA2  its review queue holds the planted collision, open, with both uids
//   LA3  every audited cycle after the first kept earlier verdicts (reused > 0)
//        and checked fewer new claims than it holds
//   LA4  the collision, dismissed in the status view, is still dismissed after
//        the next audited update
//   LA6  with the chat past the last audit and the ledger, the panel shows no
//        stale line and a drop-fact fix accepted from the queue takes the
//        claim out of its entry, with no 'run /canon first' or 'audit again'
//        refusal (skipped, and passed, if no drop-fact finding is open)
// Writes evidence/<stamp>/: audit-live.log, screenshots, canon.json (the
// final chat_metadata.canonkeeper), chat.jsonl, book.json and
// audit-live-result.json. Exits 0 only if every check passes.
//
//   ST_DIR, ST_PAGE, ST_API, BROWSER_WS, PROXY_URL, OUT_DIR   as for st-session.mjs
//   TRANSCRIPT    a SillyTavern .jsonl (default fixtures/story/transcript.jsonl)
//   STOP_AT       stop after this many messages (default: the whole transcript)
//   WRITER_MODEL  default claude-sonnet-5-5
//   AUDIT_MODEL   scene detection and claim check, default claude-haiku-4-5-20251001
//   RP_PORT, CADENCE, PACE_MS   as for st-session.mjs (defaults 8124, 4, 10000)

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const env = (k, d) => process.env[k] ?? d;
const ST_DIR = env('ST_DIR');
const ST_PAGE = env('ST_PAGE', 'http://127.0.0.1:8000/');
const ST_API = env('ST_API', 'http://127.0.0.1:8000');
const BROWSER = env('BROWSER_WS');
const PROXY_URL = env('PROXY_URL');
const RP_PORT = Number(env('RP_PORT', '8124'));
const CADENCE = Number(env('CADENCE', '4'));
const PACE_MS = Number(env('PACE_MS', '10000'));
const WRITER_MODEL = env('WRITER_MODEL', 'claude-sonnet-5-5');
const AUDIT_MODEL = env('AUDIT_MODEL', 'claude-haiku-4-5-20251001');
const REPO_URL = 'https://github.com/phattbeats/canonkeeper';
const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const TRANSCRIPT = path.resolve(env('TRANSCRIPT', path.join(REPO, 'fixtures/story/transcript.jsonl')));
const WRITER = `Claude ${WRITER_MODEL} (anthropic-proxy)`;
const CHECKER = `Claude ${AUDIT_MODEL} (anthropic-proxy)`;
const ROLEPLAY = 'Roleplay (transcript replay)';
const CHAR = 'Narrator';
const PLANT_KEY = 'Zedwin Varrocks';
const PLANT_CONTENT = 'A human wrote this.';
const SETTLE_TIMEOUT = 30 * 60 * 1000;
const IDLE_TIMEOUT = 20 * 60 * 1000;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(env('OUT_DIR', path.join(REPO, '.run', 'live-audit-live')), stamp);
fs.mkdirSync(OUT, { recursive: true });
const logFile = fs.createWriteStream(path.join(OUT, 'audit-live.log'));
const log = (...parts) => {
    const line = `${new Date().toISOString()} ${parts.join(' ')}`;
    console.log(line);
    logFile.write(line + '\n');
};
const save = (name, value) => fs.writeFileSync(path.join(OUT, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The transcript: a header line (no 'mes'), then the messages. Message 0 is
// the character's greeting.
const story = fs.readFileSync(TRANSCRIPT, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((m) => 'mes' in m);
if (!story.length || story[0].is_user) throw new Error(`${TRANSCRIPT}: the first message must be the character's greeting`);
const STOP_AT = Math.min(Number(env('STOP_AT', String(story.length))), story.length);

// --- The roleplay model: answers with whichever narrator message is due -------
let pending = null;
let served = 0;
const rp = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
        if (req.method === 'GET' && req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ object: 'list', data: [{ id: 'transcript-narrator', object: 'model' }] }));
        }
        const data = JSON.parse(body || '{}');
        const text = pending ?? '(nothing is due)';
        served++;
        log(`[roleplay] request ${served}: answering with '${text.slice(0, 50)}...'${data.stream ? ' (streamed)' : ''}`);
        if (data.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            for (const w of text.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: w } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
            return res.end('data: [DONE]\n\n');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `rp-${served}`, object: 'chat.completion', model: 'transcript-narrator', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
    });
});

// --- SillyTavern's HTTP API, from outside the page ---------------------------
let cookie = '';
let token = '';
async function session() {
    const r = await fetch(`${ST_API}/csrf-token`);
    cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    token = (await r.json()).token;
}
async function api(route, body = {}) {
    const r = await fetch(`${ST_API}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie }, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${route} -> ${r.status} ${text.slice(0, 300)}`);
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
let chatFile = null;
const readChat = () => api('/api/chats/get', { ch_name: CHAR, file_name: chatFile, avatar_url: `${CHAR}.png` });
const readBook = (name) => api('/api/worldinfo/get', { name });
const stateOf = (chat) => chat?.[0]?.chat_metadata?.canonkeeper ?? null;

// --- The page ---------------------------------------------------------------
async function dismissDialogs(page) {
    for (let i = 0; i < 5; i++) {
        const dialog = await page.$('dialog.popup[open]');
        if (!dialog) return;
        log(`[ui] dialog on load: '${(await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 160)}': accepted`);
        const ok = await dialog.$('.popup-button-ok:visible');
        if (ok) await ok.click();
        else await page.keyboard.press('Escape');
        await sleep(1500);
    }
}

async function loadST(page) {
    await page.waitForSelector('#send_textarea', { timeout: 180000 });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.().onlineStatus !== undefined, null, { timeout: 120000 });
    await sleep(4000);
    await dismissDialogs(page);
}

async function command(page, text) {
    log(`[ui] typing '${text.length > 70 ? `${text.slice(0, 70)}...` : text}' into the chat box and pressing Enter`);
    await page.fill('#send_textarea', text);
    await page.press('#send_textarea', 'Enter');
}

/** A slash command run the way a script would, not typed: a typed command makes SillyTavern announce a generation it then drops. */
const slash = (page, text) => page.evaluate((t) => SillyTavern.getContext().executeSlashCommandsWithOptions(t), text);
// A bare '|' would end the /send and start a pipe.
const escapeSlash = (text) => text.replace(/\|/g, '\\|');

async function openDrawer(page, id) {
    const open = await page.$eval(`#${id} .drawer-content`, (el) => el.classList.contains('openDrawer'));
    if (!open) await page.click(`#${id} .drawer-toggle`);
    await sleep(800);
}

async function shot(page, name) {
    await page.screenshot({ path: path.join(OUT, name), fullPage: false });
    log(`[evidence] screenshot ${name}`);
}

/** Waits until the chat holds `n` messages and SillyTavern has stopped generating. */
async function waitForChat(page, n) {
    await page.waitForFunction((n) => SillyTavern.getContext().chat.length >= n && getComputedStyle(document.getElementById('mes_stop')).display === 'none', n, { timeout: 120000 });
}

async function claudeProfile(page, model, name) {
    await openDrawer(page, 'sys-settings-button');
    await page.selectOption('#main_api', 'openai');
    await sleep(1000);
    await page.selectOption('#chat_completion_source', 'claude');
    await sleep(1000);
    await page.evaluate((proxyUrl) => {
        $('#openai_reverse_proxy_name').val('anthropic-proxy').trigger('input');
        $('#openai_reverse_proxy').val(proxyUrl).trigger('input');
        $('#openai_proxy_access_key').val('x').trigger('input');
        $('#save_proxy').trigger('click');
    }, PROXY_URL);
    // A model this SillyTavern doesn't list yet is added to the list, as the
    // proxy passes any model id through.
    const added = await page.evaluate((m) => {
        const select = document.getElementById('model_claude_select');
        if ([...select.options].some((o) => o.value === m)) return false;
        select.add(new Option(m, m));
        return true;
    }, model);
    if (added) log(`[ui] '${model}' is not in SillyTavern's Claude model list: added it to the select`);
    await page.selectOption('#model_claude_select', model);
    await sleep(1500);
    await command(page, `/profile-create ${name}`);
    await sleep(3000);
    log(`[ui] connection profile '${name}': Chat Completion → Claude, proxy ${PROXY_URL}, model ${model}`);
}

/** The status view, scrolled into sight, with the review queue open. */
async function showStatus(page, name) {
    await openDrawer(page, 'extensions-settings-button');
    const open = await page.$eval('#canonkeeper_settings .inline-drawer-content', (el) => getComputedStyle(el).display !== 'none');
    if (!open) await page.click('#canonkeeper_settings .inline-drawer-toggle');
    await sleep(500);
    await page.evaluate(() => document.querySelectorAll('#canonkeeper_status details').forEach((d) => (d.open = /^(Review queue|Dismissed)/.test(d.querySelector('summary').textContent))));
    const queue = page.locator('#canonkeeper_status summary', { hasText: 'Review queue' });
    if (await queue.count()) await queue.first().scrollIntoViewIfNeeded();
    else await page.locator('#canonkeeper_status').scrollIntoViewIfNeeded();
    await sleep(500);
    await shot(page, name);
}

const busy = (page) => page.evaluate(() => !!document.querySelector('#canonkeeper_status .canonkeeper-running'));

/** Waits until no live tick is running in the page, seen twice in a row. */
async function waitIdle(page, label) {
    const until = Date.now() + IDLE_TIMEOUT;
    let quiet = 0;
    while (Date.now() < until) {
        quiet = (await busy(page)) ? 0 : quiet + 1;
        if (quiet >= 2) return;
        await sleep(2000);
    }
    throw new Error(`${label}: a live tick was still running after ${IDLE_TIMEOUT / 60000} min`);
}

const checks = [];
function check(id, ok, says = '') {
    checks.push({ id, ok: !!ok, says });
    log(`[check] ${ok ? 'PASS' : 'FAIL'}: ${id}${says ? ` (${says})` : ''}`);
}

// --- What the run has seen, cycle by cycle -----------------------------------
const seen = new Set();
const cycles = []; // every cycle with an update that worked, with its audit
let plant = null; // { at (page clock), messages, uids, book }
let collided = null; // the first audited update after the plant
let dismissed = null; // { at (page clock), id }
let afterDismiss = null;
let accepted = null; // LA6: { ledger, chat, audited, id, claim, uid } or { skipped }

const summary = (c) => ({ at: c.at, messages: c.messages, through: c.update.through, writes: c.update.writes, audit: c.audit ?? null });
const collisionOf = (audit) => audit?.findings?.find((f) => f.check === 'collision' && plant.uids.every((u) => f.uids?.map(Number).includes(u)));

/** Reads the chat file, logs new cycles, and does whatever the run is due to do next. */
async function watch(page) {
    const chat = await readChat();
    const state = stateOf(chat);
    const live = state?.live;
    if (!live) return;
    for (const c of live.cycles ?? []) {
        if (seen.has(c.at)) continue;
        seen.add(c.at);
        log(`[server] cycle @${c.messages}: ${JSON.stringify({ detection: c.detection && { ok: c.detection.ok, starts: c.detection.starts, error: c.detection.error }, update: c.update, audit: c.audit })}`);
        if (c.update?.ok) cycles.push(summary(c));
    }

    // 1. The first book: plant the collision.
    if (!plant && cycles.length && state.book) {
        const book = await readBook(state.book);
        if (Object.keys(book.entries ?? {}).length) await plantCollision(page, state.book);
        return;
    }
    // 2. The first update that started after the plant.
    const after = (t) => (live.cycles ?? []).find((c) => c.update?.ok && new Date(c.at).getTime() > t);
    if (plant && !collided) {
        const c = after(plant.at);
        if (!c) return;
        collided = c;
        log(`[server] first update after the plant: cycle @${c.messages} (${c.at}); audit ${JSON.stringify(c.audit)}`);
        const book = await readBook(state.book);
        const intact = plant.uids.every((u) => book.entries[u]?.content === PLANT_CONTENT && book.entries[u]?.key?.includes(PLANT_KEY));
        log(`[server] planted entries ${plant.uids.join(', ')} intact in the lorebook file after that update: ${intact}`);
        for (const f of state.audit?.findings ?? []) log(`[server]   ${f.dismissed ? '(dismissed) ' : ''}${f.severity} ${f.id}: ${f.message}`);
        check('LA1', c.audit?.ok === true, `cycle @${c.messages}: audit ${JSON.stringify(c.audit)}`);
        const f = collisionOf(state.audit);
        check('LA2', f && !f.dismissed, f ? `'${f.id}' ${f.dismissed ? 'dismissed' : 'open'}, uids ${JSON.stringify(f.uids)}; planted ${JSON.stringify(plant.uids)}; no Audit click` : `no collision finding holding uids ${JSON.stringify(plant.uids)}`);
        await showStatus(page, '03-queue-after-plant.png');
        if (f) await dismissCollision(page, f.id);
        return;
    }
    // 3. The first update that started after the dismiss.
    if (dismissed && !afterDismiss) {
        const c = after(dismissed.at);
        if (!c?.audit) return;
        afterDismiss = c;
        const f = state.audit?.findings?.find((x) => x.id === dismissed.id);
        log(`[server] first update after the dismiss: cycle @${c.messages} (${c.at}); audit ${JSON.stringify(c.audit)}; '${dismissed.id}' ${f ? (f.dismissed ? 'dismissed' : 'OPEN') : 'not in the findings'}`);
        check('LA4', c.audit.ok && f?.dismissed === true && (state.audit.dismissed ?? []).includes(dismissed.id), `cycle @${c.messages}: ${f ? `dismissed=${!!f.dismissed}` : 'finding gone'}; audit.dismissed ${JSON.stringify(state.audit?.dismissed)}`);
        await showStatus(page, '05-queue-after-next-update.png');
        return;
    }
    // 4. Once the chat has grown past the last audit (and the ledger): accept a fix.
    if (afterDismiss && !accepted) {
        const last = (live.cycles ?? []).filter((c) => c.audit?.ok).at(-1);
        const length = await page.evaluate(() => SillyTavern.getContext().chat.length);
        if (!last || length <= last.messages) return;
        await acceptMidChat(page);
    }
}

/**
 * LA6: a drop-fact fix accepted from the live queue while the chat is ahead
 * of the audit and of the ledger (live mode keeps the book a scene behind).
 * No stale line in the panel, no 'run /canon first' or 'audit again' toast.
 */
async function acceptMidChat(page) {
    await waitIdle(page, 'before the accept');
    const state = stateOf(await readChat());
    const length = await page.evaluate(() => SillyTavern.getContext().chat.length);
    const lastAudited = state.live.cycles.filter((c) => c.audit?.ok).at(-1);
    accepted = { ledger: state.ledger?.messageCount, chat: length, audited: lastAudited?.messages };
    log(`[server] before the accept: chat ${length} messages, ledger covers ${accepted.ledger}, last audited cycle @${accepted.audited}${accepted.ledger === length ? ' (ledger and chat do NOT differ)' : ''}`);
    await showStatus(page, '07-before-accept.png');
    const staleShown = /audit again to accept a fix/.test(await page.locator('#canonkeeper_status').innerText());
    log(`[ui] stale line ('audit again to accept a fix') shown: ${staleShown}`);

    const f = state.audit?.findings?.find((x) => x.check === 'claim' && !x.dismissed && x.fix?.op === 'drop-fact');
    if (!f) {
        accepted.skipped = true;
        check('LA6', true, `skipped: no drop-fact finding (stale line ${staleShown ? 'SHOWN' : 'absent'})`);
        return;
    }
    accepted.id = f.id;
    accepted.claim = f.claim;
    accepted.uid = f.uids[0];
    log(`[server] accepting '${f.id}': '${f.titles?.[0]}': "${f.claim}" (${f.fix.says})`);
    const button = page.locator(`#canonkeeper_status [data-action="accept"][data-fix="fix"][data-finding="${f.id}"]`);
    const toasts = () => page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map((t) => t.innerText.replace(/\s+/g, ' ')));
    const seenToasts = [];
    let record = null;
    for (let attempt = 1; attempt <= 5 && !record; attempt++) {
        await waitIdle(page, 'before the accept');
        await showStatus(page, '07-before-accept.png');
        if (!(await button.count())) {
            log(`[ui] no Accept button for '${f.id}' in the status view`);
            break;
        }
        const t0 = Date.now();
        await button.first().click();
        log(`[ui] clicked '${(await button.first().innerText().catch(() => '')).trim()}' (attempt ${attempt})`);
        while (Date.now() - t0 < 90000 && !record) {
            await sleep(3000);
            for (const t of await toasts()) if (!seenToasts.includes(t)) {
                seenToasts.push(t);
                log(`[ui] toast: ${t}`);
            }
            record = stateOf(await readChat())?.audit?.accepted?.find((x) => x.id === f.id) ?? null;
            if (seenToasts.some((t) => /Wait for the run|run \/canon first|audit again/i.test(t))) break;
        }
        if (seenToasts.some((t) => /run \/canon first|audit again/i.test(t))) break;
    }
    if (record) log(`[server] accepted: ${record.says}: ${record.writes.join('; ')}`);
    const book = await readBook(state.book);
    save('book-after-accept.json', book);
    const entry = book.entries[accepted.uid];
    const kept = !!entry && (entry.content?.includes(f.claim) || (entry.canonkeeper?.facts ?? []).some((x) => x.text === f.claim));
    log(`[server] entry uid ${accepted.uid} after the accept: ${entry ? `still there; holds the claim: ${kept}` : 'gone'}`);
    const refused = seenToasts.filter((t) => /run \/canon first|audit again/i.test(t));
    await showStatus(page, '08-after-accept.png');
    check('LA6', !!record && !kept && !refused.length && !staleShown && accepted.ledger !== length,
        `chat ${length}, ledger ${accepted.ledger}, audited @${accepted.audited}; stale line ${staleShown ? 'SHOWN' : 'absent'}; '${f.id}' ${record ? 'accepted' : 'NOT accepted'}; claim ${kept ? 'STILL in' : 'gone from'} the entry; refusal toasts ${JSON.stringify(refused)}`);
}

/** Two hand-made entries on one key, saved as SillyTavern's World Info editor saves them. */
async function plantCollision(page, name) {
    await waitIdle(page, 'before the plant');
    const out = await page.evaluate(async ({ name, key, content }) => {
        // The same module SillyTavern loaded: its cache is the one the
        // extension reads the book from.
        const { createWorldInfoEntry } = await import(new URL('/scripts/world-info.js', location.href).href);
        const c = SillyTavern.getContext();
        const book = await c.loadWorldInfo(name);
        const uids = [];
        for (const tag of ['first', 'second']) {
            const e = createWorldInfoEntry(name, book);
            Object.assign(e, { key: [key], keysecondary: [], comment: `${key} (${tag} hand-made entry)`, content });
            uids.push(e.uid);
        }
        await c.saveWorldInfo(name, book, true);
        c.reloadWorldInfoEditor(name, false);
        return { uids, at: Date.now(), messages: c.chat.length };
    }, { name, key: PLANT_KEY, content: PLANT_CONTENT });
    plant = { ...out, book: name };
    const book = await readBook(name);
    const there = plant.uids.every((u) => book.entries[u]?.key?.includes(PLANT_KEY));
    log(`[setup] planted two entries keyed '${PLANT_KEY}' in '${name}' at ${plant.messages} messages: uids ${plant.uids.join(', ')}; in the lorebook file: ${there}`);
    if (!there) throw new Error('the planted entries are not in the lorebook file');
    save('planted.json', { ...plant, key: PLANT_KEY, content: PLANT_CONTENT, at: new Date(plant.at).toISOString() });
    save('book-planted.json', book);
}

/** Clicks Dismiss on the collision in the review queue, when no tick is running. */
async function dismissCollision(page, id) {
    const button = page.locator(`#canonkeeper_status [data-action="dismiss"][data-finding="${id}"]`);
    for (let attempt = 1; attempt <= 5; attempt++) {
        await waitIdle(page, 'before the dismiss');
        await showStatus(page, '04-before-dismiss.png');
        if (!(await button.count())) throw new Error(`no Dismiss button for '${id}' in the status view`);
        const at = await page.evaluate(() => Date.now());
        await button.first().click();
        log(`[ui] clicked Dismiss on '${id}' (attempt ${attempt})`);
        await sleep(4000);
        const warned = await page.$('#toast-container .toast-warning');
        if (warned) log(`[ui] warning toast: ${(await warned.innerText()).replace(/\s+/g, ' ')}`);
        const f = stateOf(await readChat())?.audit?.findings?.find((x) => x.id === id);
        if (f?.dismissed) {
            dismissed = { at, id };
            log(`[server] '${id}' is dismissed in the chat file`);
            await showStatus(page, '04-after-dismiss.png');
            return;
        }
        log(`[server] '${id}' is not dismissed in the chat file yet`);
    }
    throw new Error(`could not dismiss '${id}'`);
}

let browser = null;

async function main() {
    for (const k of ['ST_DIR', 'BROWSER_WS', 'PROXY_URL']) if (!process.env[k]) throw new Error(`set ${k}`);
    log(`[setup] transcript ${TRANSCRIPT}: ${story.length} messages; playing ${STOP_AT}`);
    await new Promise((r) => rp.listen(RP_PORT, '127.0.0.1', r));
    log(`[setup] roleplay endpoint on 127.0.0.1:${RP_PORT}`);
    const head = execFileSync('git', ['ls-remote', REPO_URL, 'HEAD'], { encoding: 'utf8' }).split('\t')[0];
    log(`[setup] ${REPO_URL} HEAD is ${head}`);
    const extDir = path.join(ST_DIR, 'data', 'default-user', 'extensions', 'canonkeeper');
    log(`[setup] SillyTavern ${JSON.parse(fs.readFileSync(path.join(ST_DIR, 'package.json'), 'utf8')).version}; canonkeeper installed before the run: ${fs.existsSync(extDir)}`);
    if (fs.existsSync(extDir)) throw new Error('not a fresh install: the extension is already there');

    await session();
    await api('/api/characters/create', { ch_name: CHAR, description: 'Narrator of the story.', first_mes: story[0].mes, personality: '', scenario: '', mes_example: '', creator_notes: '', talkativeness: 0.5, fav: false, tags: [] });
    log(`[setup] character '${CHAR}' saved to the server; its greeting is message 0 of the transcript`);

    browser = await chromium.connectOverCDP(BROWSER, { timeout: 600000 });
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1600, height: 1000 });
    page.on('console', (m) => {
        const t = m.text();
        if (t.includes('[Canonkeeper]') || m.type() === 'error') log(`[page console.${m.type()}] ${t.slice(0, 500)}`);
    });
    page.on('pageerror', (e) => log(`[page error] ${e.message}`));
    await page.goto(ST_PAGE, { timeout: 180000, waitUntil: 'domcontentloaded' });
    await loadST(page);
    log('[ui] SillyTavern loaded');

    // 1. Install from the repo URL, then reload once so it loads.
    await openDrawer(page, 'extensions-settings-button');
    await page.click('#third_party_extension_button');
    await page.waitForSelector('dialog.popup[open] .popup-input', { timeout: 30000 });
    await page.fill('dialog.popup[open] .popup-input', REPO_URL);
    await sleep(1000);
    await page.click('dialog.popup[open] .popup-button-ok');
    log(`[ui] Install extension: entered ${REPO_URL}`);
    // The warning is a second dialog: wait for the install dialog to go first.
    await page.locator('dialog.popup[open] .popup-input').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
    try {
        const warning = page.locator('dialog.popup[open]', { hasText: /third-party/i });
        await warning.waitFor({ timeout: 15000 });
        await warning.locator('.popup-button-ok').click();
        log('[ui] third-party extension warning: confirmed');
    } catch {
        log('[ui] no third-party warning shown');
    }
    for (let i = 0; i < 60 && !fs.existsSync(path.join(extDir, 'manifest.json')); i++) await sleep(2000);
    const installed = execFileSync('git', ['-C', extDir, 'log', '-1', '--format=%H %s'], { encoding: 'utf8' }).trim();
    log(`[server] extension on disk: ${installed}`);
    if (!installed.startsWith(head)) throw new Error('installed commit is not the repo HEAD');
    await sleep(3000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await loadST(page);
    await page.waitForSelector('#canonkeeper_settings', { timeout: 60000, state: 'attached' });
    log('[ui] page reloaded after install; Canonkeeper panel present');

    // 2. Profiles: the writer, the detector/claim checker, and the roleplay connection.
    await claudeProfile(page, WRITER_MODEL, WRITER);
    await claudeProfile(page, AUDIT_MODEL, CHECKER);
    await openDrawer(page, 'sys-settings-button');
    await page.selectOption('#chat_completion_source', 'custom');
    await sleep(1000);
    await page.evaluate((url) => {
        $('#custom_api_url_text').val(url).trigger('input');
        $('#custom_model_id').val('transcript-narrator').trigger('input');
    }, `http://127.0.0.1:${RP_PORT}/v1`);
    await sleep(1500);
    await command(page, `/profile-create ${ROLEPLAY}`);
    await sleep(3000);
    log(`[ui] roleplay connection: Chat Completion → Custom (OpenAI-compatible), http://127.0.0.1:${RP_PORT}/v1; saved as '${ROLEPLAY}' and left active`);

    // 3. Canonkeeper: writer, detector, claim check on with its profile, cadence, live on.
    await openDrawer(page, 'extensions-settings-button');
    await page.click('#canonkeeper_settings .inline-drawer-toggle');
    await sleep(500);
    await page.selectOption('#canonkeeper_profile', { label: WRITER });
    await page.selectOption('#canonkeeper_detect_profile', { label: CHECKER });
    await page.selectOption('#canonkeeper_audit_profile', { label: CHECKER });
    await page.locator('#canonkeeper_audit_verify').check();
    await page.fill('#canonkeeper_cadence', String(CADENCE));
    await page.dispatchEvent('#canonkeeper_cadence', 'change');
    await page.locator('#canonkeeper_live').check();
    await sleep(2000);
    const set = await page.evaluate(() => ({ verify: $('#canonkeeper_audit_verify').prop('checked'), live: $('#canonkeeper_live').prop('checked'), audit: $('#canonkeeper_audit_profile option:selected').text() }));
    log(`[ui] Canonkeeper panel: writer '${WRITER}', detector '${CHECKER}', claim check '${set.audit}' (verify ticked: ${set.verify}), check every ${CADENCE} messages, live mode ticked: ${set.live}`);
    if (!set.verify || !set.live) throw new Error('claim verification or live mode did not stay ticked');
    await page.locator('#canonkeeper_settings').scrollIntoViewIfNeeded();
    await shot(page, '01-settings.png');

    // 4. A new chat with the narrator: message 0 is its greeting.
    await page.evaluate(async (CHAR) => {
        const c = SillyTavern.getContext();
        await c.selectCharacterById(c.characters.findIndex((x) => x.name === CHAR));
    }, CHAR);
    await waitForChat(page, 1);
    chatFile = await page.evaluate(() => SillyTavern.getContext().getCurrentChatId());
    log(`[ui] new chat '${chatFile}' with ${CHAR}`);

    // 5. The session: user lines with /send, narrator lines from a generation.
    for (let i = 1; i < STOP_AT; i++) {
        if (story[i].is_user) {
            await slash(page, `/send ${escapeSlash(story[i].mes)}`);
        } else {
            pending = story[i].mes;
            await slash(page, '/trigger await=true');
        }
        await waitForChat(page, i + 1);
        pending = null;
        await sleep(PACE_MS);
        await watch(page);
        const live = stateOf(await readChat())?.live;
        log(`[session] chat has ${i + 1} messages; ${live ? `${live.updates} updates, ${cycles.filter((c) => c.audit?.ok).length} audited, starts ${JSON.stringify(live.starts)}` : 'no live state yet'}`);
        if (i + 1 === Math.floor(STOP_AT / 2)) {
            await page.locator('#canonkeeper_status').scrollIntoViewIfNeeded();
            await shot(page, '02-mid-session.png');
        }
    }
    log(`[session] played ${STOP_AT} messages`);

    // 6. Let live mode catch up: every message but the newest judged, the
    // book up to the last scene start, and no tick running in the page.
    const until = Date.now() + SETTLE_TIMEOUT;
    for (;;) {
        await sleep(15000);
        await watch(page);
        const live = stateOf(await readChat())?.live;
        const through = live?.cycles.filter((c) => c.update?.ok).at(-1)?.update.through;
        const judged = live?.hashes.length ?? 0;
        const running = await busy(page);
        log(`[server] settling: ${judged} messages judged, book through ${through}, last start ${live?.starts.at(-1)}, tick running in the page: ${running}`);
        if (!running && judged >= STOP_AT - CADENCE && through === (live?.starts.at(-1) ?? 0) - 1) break;
        if (Date.now() > until) {
            log(`[server] live mode did not catch up within ${SETTLE_TIMEOUT / 60000} min: checking what there is`);
            break;
        }
    }
    await watch(page);
    // LA6 needs the chat past the last audit: if the transcript ended right
    // at it, one more line is sent.
    let extra = 0;
    if (afterDismiss && !accepted) {
        const n = await page.evaluate(() => SillyTavern.getContext().chat.length);
        await slash(page, '/send Tamsin rolls the chart up and listens to the rain.');
        await waitForChat(page, n + 1);
        extra = 1;
        log('[session] one line past the transcript sent, so the chat is ahead of the last audit');
        await sleep(PACE_MS);
        await watch(page);
    }

    // 7. The checks still open, and LA3 over every audited cycle.
    if (!accepted) check('LA6', false, afterDismiss ? 'the chat never got past the last audit' : 'LA4 never completed: no accept tried');
    if (!plant) check('LA1', false, 'no live update wrote a book: nothing was planted');
    else if (!collided) check('LA1', false, `planted at ${plant.messages} messages, but no update came after it`);
    if (!collided) check('LA2', false, 'no audited update after the plant');
    if (!afterDismiss) check('LA4', false, dismissed ? `dismissed '${dismissed.id}', but no update came after it` : 'the collision was never dismissed');
    const audited = cycles.filter((c) => c.audit?.ok);
    for (const c of cycles) log(`[server] update @${c.messages} through ${c.through}: audit ${c.audit ? (c.audit.ok ? `checked ${c.audit.checked}, reused ${c.audit.reused}, newly checked ${c.audit.checked - c.audit.reused}, ${c.audit.calls} calls, ${c.audit.findings} open findings` : `FAILED: ${c.audit.error}`) : 'none'}`);
    const later = audited.slice(1);
    const bad = later.filter((c) => !(c.audit.reused > 0 && c.audit.checked - c.audit.reused < c.audit.checked));
    check('LA3', audited.length >= 2 && !bad.length, audited.length < 2
        ? `${audited.length} audited cycle(s): nothing to carry verdicts over to`
        : `${later.length} audited cycles after the first; ${bad.length ? `no verdicts kept at ${bad.map((c) => `@${c.messages} (checked ${c.audit.checked}, reused ${c.audit.reused})`).join(', ')}` : `reused ${later.map((c) => c.audit.reused).join(', ')}; calls ${later.map((c) => c.audit.calls).join(', ')}`}`);

    await showStatus(page, '06-final.png');
    const chat = await readChat();
    const state = stateOf(chat);
    save('canon.json', state);
    save('chat.jsonl', chat.map((l) => JSON.stringify(l)).join('\n') + '\n');
    if (state?.book) save('book.json', await readBook(state.book));
    const messages = chat.slice(1, 1 + STOP_AT);
    const sameText = chat.length - 1 === STOP_AT + extra && messages.every((m, i) => m.mes === story[i].mes && !!m.is_user === !!story[i].is_user);
    log(`[server] chat file: ${messages.length} messages; texts identical to the transcript: ${sameText}`);

    await browser.close();
    const order = ['LA1', 'LA2', 'LA3', 'LA4', 'LA6'];
    checks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const ok = order.every((id) => checks.some((c) => c.id === id)) && checks.every((c) => c.ok);
    save('audit-live-result.json', { checks, ok, plant: plant && { ...plant, at: new Date(plant.at).toISOString() }, dismissed: dismissed && { ...dismissed, at: new Date(dismissed.at).toISOString() }, accepted, cycles });
    log(`[result] ${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
    if (!ok) process.exitCode = 1;
    log('done');
}

// browserless is shared: a run that fails must still give its session back.
main().catch((err) => {
    log(`FAILED: ${err.stack ?? err}`);
    process.exitCode = 1;
}).finally(async () => {
    await browser?.close().catch(() => {});
    rp.close();
    logFile.end(() => process.exit());
});
