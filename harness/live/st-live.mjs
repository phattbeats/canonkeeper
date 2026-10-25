// Live acceptance run for Canonkeeper build step 3, driven from outside the
// page. A fresh SillyTavern (no extensions, no characters, no profiles) is
// driven through browserless like a user would: install from the repo URL,
// make a connection profile, pick it in the Canonkeeper panel, type /canon.
// Every check reads SillyTavern's own HTTP API from this process, never the
// page's word for it. Writes evidence/<stamp>/: live.log, screenshots, the
// lorebook and chat as the server holds them, and the gate's verdict.

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// Everything about the environment comes from the environment:
//   ST_DIR        the SillyTavern checkout the server runs from (fresh: no
//                 data/default-user/extensions/canonkeeper)
//   ST_PAGE       the URL the browser opens
//   ST_API        the URL this process reads, outside the page
//   BROWSER_WS    a Chrome DevTools websocket (e.g. browserless)
//   PROXY_URL     a Claude-compatible endpoint for the connection profile
//   OUT_DIR       where evidence/<stamp>/ goes (default: .run/live)
//   CONTEXT       the window typed into the panel (default 200000)
//   DEEP          set (to anything) to also require scene entries and the
//                 Timeline in the book the server holds (PHA-4527), and to
//                 run the gate with --deep (D17-D19). A real model's profiles
//                 can fall short of D18's 1,000 characters, so read it
//                 beside the book
//   OUTPUT_SHARE  set with CONTEXT to read the story in parts: the share of
//                 the window kept for output. It has no control in the panel,
//                 so it goes into the extension's settings, and the gate then
//                 runs with --chunked (K10)
// Needs playwright-core, which the repo doesn't depend on: install it next
// to wherever you run this from.
const env = (k, d) => process.env[k] ?? d;
const ST_DIR = env('ST_DIR');
const ST_PAGE = env('ST_PAGE', 'http://127.0.0.1:8000/');
const ST_API = env('ST_API', 'http://127.0.0.1:8000');
const BROWSER = env('BROWSER_WS');
const PROXY_URL = env('PROXY_URL');
const REPO_URL = 'https://github.com/phattbeats/canonkeeper';
const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const PROFILE = 'Claude Sonnet 5 (anthropic-proxy)';
const CHAR = 'Narrator';
const CHAT = 'Saltwind';
const RUN_TIMEOUT = 20 * 60 * 1000;
const CONTEXT = env('CONTEXT', '200000');
const OUTPUT_SHARE = env('OUTPUT_SHARE');
const DEEP = !!env('DEEP');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(env('OUT_DIR', path.join(REPO, '.run', 'live')), stamp);
fs.mkdirSync(OUT, { recursive: true });
const logFile = fs.createWriteStream(path.join(OUT, 'live.log'));
const log = (...parts) => {
    const line = `${new Date().toISOString()} ${parts.join(' ')}`;
    console.log(line);
    logFile.write(line + '\n');
};
const save = (name, value) => fs.writeFileSync(path.join(OUT, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const readChat = () => api('/api/chats/get', { ch_name: CHAR, file_name: CHAT, avatar_url: `${CHAR}.png` });
const readBook = (name) => api('/api/worldinfo/get', { name });
const stateOf = (chat) => chat?.[0]?.chat_metadata?.canonkeeper ?? null;

async function waitForRun(after, label, page) {
    const until = Date.now() + RUN_TIMEOUT;
    let beat = 0;
    while (Date.now() < until) {
        const toast = await page.$('#toast-container .toast-error');
        if (toast) throw new Error(`${label}: error toast: ${(await toast.innerText()).replace(/\s+/g, ' ')}`);
        const chat = await readChat();
        const last = stateOf(chat)?.lastRun;
        if (last && new Date(last.at).getTime() >= after) {
            log(`[server] ${label}: chat file now records a run at ${last.at}, ok=${last.ok}, ${Math.round(last.ms / 1000)}s`);
            for (const line of last.log ?? []) log(`[server]   ${line}`);
            return { chat, last };
        }
        if (++beat % 6 === 0) log(`[server] ${label}: no run recorded in the chat file yet (${Math.round((Date.now() - after) / 1000)}s)`);
        await sleep(5000);
    }
    throw new Error(`${label}: no run recorded within ${RUN_TIMEOUT / 60000} min`);
}

// --- The page ---------------------------------------------------------------
async function openST(browser) {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1600, height: 1000 });
    page.on('console', (m) => {
        const t = m.text();
        if (t.includes('[Canonkeeper]') || m.type() === 'error') log(`[page console.${m.type()}] ${t.slice(0, 500)}`);
    });
    page.on('pageerror', (e) => log(`[page error] ${e.message}`));
    await page.goto(ST_PAGE, { timeout: 180000, waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#send_textarea', { timeout: 180000 });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.().onlineStatus !== undefined, null, { timeout: 120000 });
    await sleep(4000);
    await dismissDialogs(page);
    return page;
}

// A fresh SillyTavern greets a new user with dialogs (welcome, persona):
// accept each, as a user would, and log what it said.
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

async function command(page, text) {
    log(`[ui] typing '${text}' into the chat box and pressing Enter`);
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

let browser = null;

async function main() {
    for (const k of ['ST_DIR', 'BROWSER_WS', 'PROXY_URL']) if (!process.env[k]) throw new Error(`set ${k}`);
    const head = execFileSync('git', ['ls-remote', REPO_URL, 'HEAD'], { encoding: 'utf8' }).split('\t')[0];
    log(`[setup] ${REPO_URL} HEAD is ${head}`);
    const extDir = path.join(ST_DIR, 'data', 'default-user', 'extensions', 'canonkeeper');
    log(`[setup] SillyTavern ${JSON.parse(fs.readFileSync(path.join(ST_DIR, 'package.json'), 'utf8')).version}; canonkeeper installed before the run: ${fs.existsSync(extDir)}`);
    if (fs.existsSync(extDir)) throw new Error('not a fresh install: the extension is already there');

    await session();
    // A character and the fixture chat, put on the server through its API.
    const lines = fs.readFileSync(path.join(REPO, 'fixtures/story/transcript.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    await api('/api/characters/create', { ch_name: CHAR, description: 'Narrator of The Saltwind Chart.', first_mes: '', personality: '', scenario: '', mes_example: '', creator_notes: '', talkativeness: 0.5, fav: false, tags: [] });
    await api('/api/chats/save', { ch_name: CHAR, file_name: CHAT, avatar_url: `${CHAR}.png`, chat: lines });
    log(`[setup] character '${CHAR}' and chat '${CHAT}' (${lines.length - 1} messages) saved to the server`);

    browser = await chromium.connectOverCDP(BROWSER, { timeout: 120000 });
    let page = await openST(browser);
    log('[ui] SillyTavern loaded');

    // 1. Install from the repo URL, through the Extensions panel.
    await openDrawer(page, 'extensions-settings-button');
    await page.click('#third_party_extension_button');
    await page.waitForSelector('dialog.popup[open] .popup-input', { timeout: 30000 });
    await page.fill('dialog.popup[open] .popup-input', REPO_URL);
    await shot(page, '01-install-dialog.png');
    await page.click('dialog.popup[open] .popup-button-ok');
    log(`[ui] Install extension: entered ${REPO_URL}`);
    // The third-party warning comes up once the install dialog has closed.
    try {
        const warning = page.locator('dialog.popup[open]', { hasText: /third-party/i });
        await warning.waitFor({ timeout: 15000 });
        await shot(page, '01b-third-party-warning.png');
        await warning.locator('.popup-button-ok').click();
        log('[ui] third-party extension warning: confirmed');
    } catch {
        log('[ui] no third-party warning shown');
    }
    for (let i = 0; i < 60 && !fs.existsSync(path.join(extDir, 'manifest.json')); i++) await sleep(2000);
    const installed = execFileSync('git', ['-C', extDir, 'log', '-1', '--format=%H %s'], { encoding: 'utf8' }).trim();
    log(`[server] extension on disk at ${path.relative(ST_DIR, extDir)}: ${installed}`);
    if (!installed.startsWith(head)) throw new Error('installed commit is not the repo HEAD');
    await sleep(3000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#send_textarea', { timeout: 180000 });
    await page.waitForSelector('#canonkeeper_settings', { timeout: 60000, state: 'attached' });
    await sleep(4000);
    await dismissDialogs(page);
    log('[ui] page reloaded; Canonkeeper panel present');

    // 2. A connection profile: Chat Completion, Claude, through the proxy.
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
    await page.selectOption('#model_claude_select', 'claude-sonnet-5');
    await sleep(1500);
    log(`[ui] API: Chat Completion → Claude, proxy preset anthropic-proxy (${PROXY_URL}), model claude-sonnet-5`);
    await command(page, `/profile-create ${PROFILE}`);
    await sleep(3000);
    await shot(page, '02-connection.png');

    // 3. Canonkeeper settings: pick the profile.
    await openDrawer(page, 'extensions-settings-button');
    await page.click('#canonkeeper_settings .inline-drawer-toggle');
    await sleep(500);
    await page.selectOption('#canonkeeper_profile', { label: PROFILE });
    await page.fill('#canonkeeper_context', CONTEXT);
    await page.dispatchEvent('#canonkeeper_context', 'change');
    if (OUTPUT_SHARE) {
        await page.evaluate((share) => {
            const c = SillyTavern.getContext();
            c.extensionSettings.canonkeeper.outputShare = Number(share);
            c.saveSettingsDebounced();
        }, OUTPUT_SHARE);
        log(`[setup] extension setting outputShare = ${OUTPUT_SHARE} (no panel control)`);
    }
    await sleep(2000);
    log(`[ui] Canonkeeper panel: profile '${PROFILE}', context ${CONTEXT}`);
    await page.locator('#canonkeeper_settings').scrollIntoViewIfNeeded();
    await shot(page, '03-settings.png');

    // 4. Open the chat.
    await page.evaluate(async ({ CHAR, CHAT }) => {
        const c = SillyTavern.getContext();
        const id = c.characters.findIndex((x) => x.name === CHAR);
        await c.selectCharacterById(id);
        await c.openCharacterChat(CHAT);
    }, { CHAR, CHAT });
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 50, null, { timeout: 60000 });
    log(`[ui] opened chat '${CHAT}': ${await page.evaluate(() => SillyTavern.getContext().chat.length)} messages`);

    // 5. First run.
    const t1 = Date.now();
    await command(page, '/canon');
    await sleep(3000);
    await shot(page, '04-running.png');
    const run1 = await waitForRun(t1, 'run 1', page);
    if (!run1.last.ok) throw new Error(`run 1 failed: ${run1.last.error}`);
    const name = stateOf(run1.chat).book;
    const book1 = await readBook(name);
    log(`[server] lorebook '${name}' on the server: ${Object.keys(book1.entries).length} entries; bound to the chat: ${run1.chat[0].chat_metadata.world_info === name}`);
    save('book-run1.json', book1);
    if (DEEP) {
        const scenes = Object.values(book1.entries).filter((e) => e.canonkeeper?.kind === 'scene');
        const timeline = Object.values(book1.entries).find((e) => e.canonkeeper?.kind === 'timeline');
        log(`[server] scene entries in the lorebook file: ${scenes.length} ${JSON.stringify(scenes.map((e) => e.comment))}`);
        log(`[server] Timeline: ${timeline ? `uid ${timeline.uid}, constant=${timeline.constant}, ${timeline.content.split('\n').length} lines` : 'MISSING'}`);
        log(`[check] ${scenes.length >= 5 && timeline?.constant ? 'PASS' : 'FAIL'}: scene entries and the Timeline are in the book`);
    }
    save('scenes.json', { boundaries: stateOf(run1.chat).ledger.scenes });
    save('ledger.json', stateOf(run1.chat).ledger);
    const chunked = stateOf(run1.chat).ledger.chunked;
    log(`[server] ledger in the chat file: ${chunked ? `chunked, ${chunked.parts.length} parts ${JSON.stringify(chunked.parts.map((p) => [p.from, p.to]))}, reconciliation ran=${chunked.reconciliation.ran}` : 'one-shot'}`);
    save('chat-after-run1.jsonl', run1.chat.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await sleep(2000);
    await page.locator('#canonkeeper_status').scrollIntoViewIfNeeded();
    await page.evaluate(() => document.querySelectorAll('#canonkeeper_status details').forEach((d, i) => { if (i < 1) d.open = true; }));
    await shot(page, '05-status-after-run1.png');

    // 6. Pin two entries in the status view, as a user would.
    const pins = ['Brother Saul', 'The Undercroft'].filter((t) => Object.values(book1.entries).some((e) => e.comment === t));
    await page.evaluate(() => document.querySelectorAll('#canonkeeper_status details').forEach((d) => (d.open = d.querySelector('summary').textContent.startsWith('Entries'))));
    for (const title of pins) {
        await page.locator('#canonkeeper_status label.canonkeeper-entry', { hasText: title }).first().locator('input').check();
        log(`[ui] ticked pin on '${title}'`);
        await sleep(1500);
    }
    const pinnedNow = Object.values((await readBook(name)).entries).filter((e) => e.canonkeeper?.pinned).map((e) => e.comment);
    log(`[server] pinned in the lorebook file: ${JSON.stringify(pinnedNow)}`);
    await shot(page, '06-pins.png');

    // 7. Second run on the unchanged chat: zero writes, no model call, pins kept.
    // The gate's book.json is the book the re-run starts from: pins in place.
    const pinnedBook = await readBook(name);
    save('book.json', pinnedBook);
    const before2 = JSON.stringify(pinnedBook.entries);
    const t2 = Date.now();
    await command(page, '/canon');
    const run2 = await waitForRun(t2, 'run 2', page);
    const book2 = await readBook(name);
    save('rerun.json', book2);
    log(`[server] run 2: ok=${run2.last.ok}, model calls=${run2.last.calls}, writes=${run2.last.plan?.length}, held=${run2.last.held?.length}; book file byte-identical to before: ${JSON.stringify(book2.entries) === before2}`);
    await page.locator('#canonkeeper_status').scrollIntoViewIfNeeded();
    await shot(page, '07-status-after-run2.png');

    // 8. The lorebook in SillyTavern's own World Info editor.
    await openDrawer(page, 'WI-SP-button');
    await page.evaluate((name) => {
        const i = SillyTavern.getContext().getWorldInfoNames().indexOf(name);
        $('#world_editor_select').val(i).trigger('change');
    }, name);
    await sleep(3000);
    await shot(page, '08-world-info-editor.png');

    await browser.close();

    // 9. The gate, on the files the server holds.
    const gate = spawnSync('node', [path.join(REPO, 'harness/gate.js'), '--story', path.join(REPO, 'fixtures/story'), '--run', OUT, ...(OUTPUT_SHARE ? ['--chunked'] : []), ...(DEEP ? ['--deep'] : [])], { encoding: 'utf8' });
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
    logFile.end(() => process.exit());
});
