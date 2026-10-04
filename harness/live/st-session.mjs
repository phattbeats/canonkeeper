// Live-mode acceptance run (build step 5), driven from outside the page. A
// fresh SillyTavern gets the extension from the repo URL, two connection
// profiles (the writer and a cheap detector) and live mode switched on in the
// panel. Then the fixture story is played as a session: every user line is
// typed into the chat box and sent, and the character's reply comes from a
// real generation. The roleplay model is a small OpenAI-compatible endpoint
// in this process that answers with the story's next narrator message, so the
// chat comes out as the fixture and the scene starts can be scored against
// its answer key. The page is never reloaded once the chat is open.
//
// Every check reads SillyTavern's HTTP API from this process: the live state
// store (cycles, call counts, scene starts) in the chat file, and the
// lorebook file. Writes evidence/<stamp>/: session.log, screenshots, the run
// directory the gate scores with --live, and the gate's verdict.
//
//   ST_DIR, ST_PAGE, ST_API, BROWSER_WS, PROXY_URL   as for st-live.mjs
//   RP_PORT     port for the roleplay endpoint (default 8124); SillyTavern's
//               server must reach it on 127.0.0.1
//   CADENCE     live mode's "check every" (default 4)
//   PACE_MS     pause after each reply, as a reader would (default 10000)

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { update } from '../../src/update.js';

const env = (k, d) => process.env[k] ?? d;
const ST_DIR = env('ST_DIR');
const ST_PAGE = env('ST_PAGE', 'http://127.0.0.1:8000/');
const ST_API = env('ST_API', 'http://127.0.0.1:8000');
const BROWSER = env('BROWSER_WS');
const PROXY_URL = env('PROXY_URL');
const RP_PORT = Number(env('RP_PORT', '8124'));
const CADENCE = Number(env('CADENCE', '4'));
const PACE_MS = Number(env('PACE_MS', '10000'));
const REPO_URL = 'https://github.com/phattbeats/canonkeeper';
const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const WRITER = 'Claude Sonnet 5 (anthropic-proxy)';
const DETECTOR = 'Claude Haiku 4.5 (anthropic-proxy)';
const ROLEPLAY = 'Roleplay (fixture replay)';
const CHAR = 'Narrator';
const SETTLE_TIMEOUT = 30 * 60 * 1000;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(env('OUT_DIR', path.join(REPO, '.run', 'live-session')), stamp);
fs.mkdirSync(OUT, { recursive: true });
const logFile = fs.createWriteStream(path.join(OUT, 'session.log'));
const log = (...parts) => {
    const line = `${new Date().toISOString()} ${parts.join(' ')}`;
    console.log(line);
    logFile.write(line + '\n');
};
const save = (name, value) => fs.writeFileSync(path.join(OUT, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const story = fs.readFileSync(path.join(REPO, 'fixtures/story/transcript.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).slice(1).map((l) => JSON.parse(l));

// --- The roleplay model: the story's narrator, one message per request ------
const narration = story.slice(1).filter((m) => !m.is_user).map((m) => m.mes);
let served = 0;
const rp = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
        if (req.method === 'GET' && req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ object: 'list', data: [{ id: 'saltwind-narrator', object: 'model' }] }));
        }
        const data = JSON.parse(body || '{}');
        const text = narration[served++] ?? '(the story is over)';
        log(`[roleplay] request ${served}: answering with narrator message '${text.slice(0, 50)}...'${data.stream ? ' (streamed)' : ''}`);
        if (data.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            const words = text.split(/(?<= )/);
            for (const w of words) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: w } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
            return res.end('data: [DONE]\n\n');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `rp-${served}`, object: 'chat.completion', model: 'saltwind-narrator', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
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
    await page.selectOption('#model_claude_select', model);
    await sleep(1500);
    await command(page, `/profile-create ${name}`);
    await sleep(3000);
    log(`[ui] connection profile '${name}': Chat Completion → Claude, proxy ${PROXY_URL}, model ${model}`);
}

let browser = null;

async function main() {
    for (const k of ['ST_DIR', 'BROWSER_WS', 'PROXY_URL']) if (!process.env[k]) throw new Error(`set ${k}`);
    await new Promise((r) => rp.listen(RP_PORT, '127.0.0.1', r));
    log(`[setup] roleplay endpoint on 127.0.0.1:${RP_PORT}: ${narration.length} narrator messages to serve`);
    const head = execFileSync('git', ['ls-remote', REPO_URL, 'HEAD'], { encoding: 'utf8' }).split('\t')[0];
    log(`[setup] ${REPO_URL} HEAD is ${head}`);
    const extDir = path.join(ST_DIR, 'data', 'default-user', 'extensions', 'canonkeeper');
    log(`[setup] SillyTavern ${JSON.parse(fs.readFileSync(path.join(ST_DIR, 'package.json'), 'utf8')).version}; canonkeeper installed before the run: ${fs.existsSync(extDir)}`);
    if (fs.existsSync(extDir)) throw new Error('not a fresh install: the extension is already there');

    await session();
    await api('/api/characters/create', { ch_name: CHAR, description: 'Narrator of The Saltwind Chart.', first_mes: story[0].mes, personality: '', scenario: '', mes_example: '', creator_notes: '', talkativeness: 0.5, fav: false, tags: [] });
    log(`[setup] character '${CHAR}' saved to the server; its greeting is message 0 of the story`);

    browser = await chromium.connectOverCDP(BROWSER, { timeout: 120000 });
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1600, height: 1000 });
    page.on('console', (m) => {
        const t = m.text();
        if (t.includes('[Canonkeeper]') || m.type() === 'error') log(`[page console.${m.type()}] ${t.slice(0, 400)}`);
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
    await page.click('dialog.popup[open] .popup-button-ok');
    log(`[ui] Install extension: entered ${REPO_URL}`);
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

    // 2. Profiles: the writer, the detector, and the roleplay connection.
    await claudeProfile(page, 'claude-sonnet-5', WRITER);
    await claudeProfile(page, 'claude-haiku-4-5', DETECTOR);
    await openDrawer(page, 'sys-settings-button');
    await page.selectOption('#chat_completion_source', 'custom');
    await sleep(1000);
    await page.evaluate((url) => {
        $('#custom_api_url_text').val(url).trigger('input');
        $('#custom_model_id').val('saltwind-narrator').trigger('input');
    }, `http://127.0.0.1:${RP_PORT}/v1`);
    await sleep(1500);
    await command(page, `/profile-create ${ROLEPLAY}`);
    await sleep(3000);
    log(`[ui] roleplay connection: Chat Completion → Custom (OpenAI-compatible), http://127.0.0.1:${RP_PORT}/v1; saved as '${ROLEPLAY}' and left active`);
    await shot(page, '01-connection.png');

    // 3. Canonkeeper: writer, detector, cadence, live mode on.
    await openDrawer(page, 'extensions-settings-button');
    await page.click('#canonkeeper_settings .inline-drawer-toggle');
    await sleep(500);
    await page.selectOption('#canonkeeper_profile', { label: WRITER });
    await page.selectOption('#canonkeeper_detect_profile', { label: DETECTOR });
    await page.fill('#canonkeeper_cadence', String(CADENCE));
    await page.dispatchEvent('#canonkeeper_cadence', 'change');
    await page.locator('#canonkeeper_live').check();
    await sleep(2000);
    log(`[ui] Canonkeeper panel: writer '${WRITER}', detector '${DETECTOR}', check every ${CADENCE} messages, live mode ticked`);
    await page.locator('#canonkeeper_settings').scrollIntoViewIfNeeded();
    await shot(page, '02-live-settings.png');

    // 4. A new chat with the narrator: message 0 is its greeting.
    await page.evaluate(async (CHAR) => {
        const c = SillyTavern.getContext();
        await c.selectCharacterById(c.characters.findIndex((x) => x.name === CHAR));
    }, CHAR);
    await waitForChat(page, 1);
    chatFile = await page.evaluate(() => SillyTavern.getContext().getCurrentChatId());
    const origin = await page.evaluate(() => performance.timeOrigin);
    let loads = 0;
    page.on('load', () => loads++);
    log(`[ui] new chat '${chatFile}' with ${CHAR}; page origin ${origin}. From here the page is never reloaded`);

    // 5. The session: each user line typed and sent; the narrator answers.
    let turns = 0;
    let lastCycles = 0;
    for (let i = 1; i < story.length; ) {
        if (story[i].is_user) {
            // A user line the story doesn't answer goes in with /send, which
            // adds it without asking the character for a reply.
            const answered = story[i + 1] && !story[i + 1].is_user;
            await command(page, answered ? story[i].mes : `/send ${story[i].mes}`);
            turns++;
            const n = answered ? i + 2 : i + 1;
            await waitForChat(page, n);
            i = n;
        } else {
            // Two narrator messages in a row: ask for the next one.
            await command(page, '/trigger');
            await waitForChat(page, i + 1);
            i++;
        }
        await sleep(PACE_MS);
        const live = stateOf(await readChat())?.live;
        if (live && live.cycles.length !== lastCycles) {
            for (const c of live.cycles.slice(lastCycles - live.cycles.length)) log(`[server] cycle @${c.messages}: ${JSON.stringify({ detection: c.detection && { ok: c.detection.ok, judged: c.detection.judged, starts: c.detection.starts, error: c.detection.error }, update: c.update })}`);
            lastCycles = live.cycles.length;
        }
        log(`[session] turn ${turns}: chat has ${i} messages; state store: ${live ? `${live.cycles.length} cycles, ${live.detectCalls} detection calls, ${live.updates} updates, starts ${JSON.stringify(live.starts)}` : 'no live state yet'}`);
        if (turns === 15 && story[i - 1] && !story[i - 1].is_user) {
            await page.locator('#canonkeeper_status').scrollIntoViewIfNeeded();
            await shot(page, '03-mid-session.png');
        }
    }
    log(`[session] story played: ${turns} turns, ${story.length} messages`);

    // 6. Let live mode catch up: every message but the newest judged, the
    // book up to the last scene start, and no tick running in the page.
    const until = Date.now() + SETTLE_TIMEOUT;
    for (;;) {
        await sleep(15000);
        const live = stateOf(await readChat())?.live;
        const through = live?.cycles.filter((c) => c.update?.ok).at(-1)?.update.through;
        const busy = await page.evaluate(() => !!document.querySelector('#canonkeeper_status .canonkeeper-running'));
        const judged = live?.hashes.length ?? 0;
        log(`[server] settling: ${live?.cycles.length} cycles, ${judged} messages judged, book through ${through}, last start ${live?.starts.at(-1)}, tick running in the page: ${busy}`);
        if (!busy && judged >= story.length - CADENCE && through === (live.starts.at(-1) ?? 0) - 1) break;
        if (Date.now() > until) throw new Error(`live mode did not catch up within ${SETTLE_TIMEOUT / 60000} min`);
    }
    const endOrigin = await page.evaluate(() => performance.timeOrigin);
    log(`[ui] page origin at the end ${endOrigin}; same page as the start: ${endOrigin === origin}; load events since the chat opened: ${loads}`);
    if (endOrigin !== origin || loads) throw new Error('the page was reloaded during the session');

    const chat = await readChat();
    save('chat.jsonl', chat.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const messages = chat.slice(1);
    const sameText = messages.length === story.length && messages.every((m, i) => m.mes === story[i].mes && !!m.is_user === !!story[i].is_user);
    log(`[server] chat file: ${messages.length} messages; texts identical to the fixture: ${sameText}`);
    if (!sameText) throw new Error('the session did not reproduce the fixture story');
    const state = stateOf(chat);
    const live = state.live;
    for (const c of live.cycles.slice(lastCycles - live.cycles.length)) log(`[server] cycle @${c.messages}: ${JSON.stringify({ detection: c.detection && { ok: c.detection.ok, judged: c.detection.judged, starts: c.detection.starts }, update: c.update })}`);
    log(`[server] live state store in the chat file: ${live.cycles.length} cycles, ${live.detectCalls} detection calls for ${messages.length} messages (cadence ${CADENCE}), ${live.updates} updates, starts ${JSON.stringify(live.starts)}`);
    const book = await readBook(state.book);
    log(`[server] lorebook '${state.book}': ${Object.keys(book.entries).length} entries; ledger covers messages 0-${state.ledger.messageCount - 1}, revision ${state.ledger.revision}`);

    await openDrawer(page, 'extensions-settings-button');
    await page.locator('#canonkeeper_status').scrollIntoViewIfNeeded();
    await page.evaluate(() => document.querySelectorAll('#canonkeeper_status details').forEach((d) => (d.open = d.querySelector('summary').textContent.startsWith('Cycles'))));
    await sleep(1000);
    await shot(page, '04-status-cycles.png');
    await browser.close();

    // 7. The run directory, from the files the server holds. rerun.json is
    // the core's re-run on the same finished scenes with two entries pinned.
    save('book.json', book);
    save('ledger.json', state.ledger);
    save('scenes.json', { boundaries: live.starts });
    save('live.json', { cadence: CADENCE, messageCount: messages.length, turns, ...live });
    const pinned = structuredClone(book);
    for (const e of Object.values(pinned.entries).slice(0, 2)) e.canonkeeper.pinned = true;
    save('book.json', pinned);
    const rerun = await update({
        book: pinned,
        ledger: state.ledger,
        messages: messages.slice(0, state.ledger.messageCount).map((m, id) => ({ id, name: String(m.name ?? ''), isUser: !!m.is_user, text: m.mes })),
        generate: async () => {
            throw new Error('the re-run on unchanged scenes made a model call');
        },
        contextTokens: 200000,
        starts: live.starts,
    });
    save('rerun.json', rerun.book);

    const gate = spawnSync('node', [path.join(REPO, 'harness/gate.js'), '--story', path.join(REPO, 'fixtures/story'), '--run', OUT, '--live'], { encoding: 'utf8' });
    save('gate.txt', gate.stdout + gate.stderr);
    for (const line of (gate.stdout + gate.stderr).trim().split('\n')) log(`[gate] ${line}`);
    log(`[gate] exit ${gate.status}`);
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
