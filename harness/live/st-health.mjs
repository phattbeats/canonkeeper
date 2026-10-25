// Live acceptance run for failure visibility, driven from outside
// the page. A fresh SillyTavern, the extension installed from the repo URL,
// a good connection profile and one that points at a proxy that isn't there.
// Live mode is turned on with no profile (badge + sticky toast), then with a
// dead scene-detection profile (same, within one cadence; no second toast on
// a retry; the badge survives a reload), then the profile is fixed and the
// badge and the toast must go on the next success. Everything about the
// badge and toasts is read from the page's DOM; the chat file is read from
// SillyTavern's HTTP API. Writes evidence/<stamp>/: health.log, screenshots,
// health.json and health-result.json.
//
// Environment as for st-hand.mjs, plus DEAD_URL (default http://127.0.0.1:9/v1).

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const env = (k, d) => process.env[k] ?? d;
const ST_DIR = env('ST_DIR');
const ST_PAGE = env('ST_PAGE', 'http://127.0.0.1:8000/');
const ST_API = env('ST_API', 'http://127.0.0.1:8000');
const BROWSER = env('BROWSER_WS');
const PROXY_URL = env('PROXY_URL');
const REPO_URL = 'https://github.com/phattbeats/canonkeeper';
const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const WRITER = 'Claude Sonnet 5 (anthropic-proxy)';
const CHECKER = 'Claude Haiku 4.5 (anthropic-proxy)';
const CHAR = 'Narrator';
const CHAT = 'Saltwind';
const RUN_TIMEOUT = 20 * 60 * 1000;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(env('OUT_DIR', path.join(REPO, '.run', 'live-health')), stamp);
fs.mkdirSync(OUT, { recursive: true });
const logFile = fs.createWriteStream(path.join(OUT, 'health.log'));
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
const titled = (book, t) => Object.values(book.entries).find((e) => e.comment === t);

/** Waits until the chat file records something newer than `after`, read by `pick`. */
async function waitFor(after, label, page, pick) {
    const until = Date.now() + RUN_TIMEOUT;
    let beat = 0;
    while (Date.now() < until) {
        const toast = await page.$('#toast-container .toast-error');
        if (toast) throw new Error(`${label}: error toast: ${(await toast.innerText()).replace(/\s+/g, ' ')}`);
        const chat = await readChat();
        const got = pick(stateOf(chat));
        if (got && new Date(got.at).getTime() >= after) {
            log(`[server] ${label}: the chat file records it at ${got.at}`);
            for (const line of got.log ?? []) log(`[server]   ${line}`);
            return { chat, got };
        }
        if (++beat % 6 === 0) log(`[server] ${label}: nothing recorded in the chat file yet (${Math.round((Date.now() - after) / 1000)}s)`);
        await sleep(5000);
    }
    throw new Error(`${label}: nothing recorded within ${RUN_TIMEOUT / 60000} min`);
}
const waitForRun = (after, label, page) => waitFor(after, label, page, (s) => s?.lastRun);
const waitForAudit = (after, label, page) => waitFor(after, label, page, (s) => (s?.audit?.findings ? s.audit : null));

function logFindings(audit) {
    log(`[server] audit summary: ${audit.summary}`);
    for (const f of audit.findings) log(`[server]   ${f.dismissed ? '(dismissed) ' : ''}${f.severity} ${f.id}: ${f.message}${f.fix ? ` [fix: ${f.fix.says}]` : ''}`);
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

/** The status view, scrolled into sight, with the review queue open. */
async function showStatus(page, name) {
    await openDrawer(page, 'extensions-settings-button');
    const open = await page.$eval('#canonkeeper_settings .inline-drawer-content', (el) => getComputedStyle(el).display !== 'none');
    if (!open) await page.click('#canonkeeper_settings .inline-drawer-toggle');
    await sleep(500);
    await page.evaluate(() => document.querySelectorAll('#canonkeeper_status details').forEach((d) => (d.open = /^Review queue/.test(d.querySelector('summary').textContent))));
    const queue = page.locator('#canonkeeper_status summary', { hasText: 'Review queue' });
    if (await queue.count()) await queue.first().scrollIntoViewIfNeeded();
    else await page.locator('#canonkeeper_status').scrollIntoViewIfNeeded();
    await sleep(500);
    await shot(page, name);
}

const results = [];
function check(label, ok, detail = '') {
    results.push({ label, ok: !!ok, detail });
    log(`[check] ${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`);
}

let browser = null;
const GOOD = 'Claude Sonnet 5 (anthropic-proxy)';
const DEAD = 'Dead proxy';
const DEAD_URL = env('DEAD_URL', 'http://127.0.0.1:9/v1');
const FIRST = 8;

const badges = (page) => page.evaluate(() => ({
    wand: [...document.querySelectorAll('#extensionsMenuButton .canonkeeper-badge')].map((b) => b.dataset.level),
    head: [...document.querySelectorAll('#canonkeeper_settings .canonkeeper-badge-head')].map((b) => `${b.dataset.level}:${b.textContent}`),
    toasts: [...document.querySelectorAll('#toast-container .toast-error')].map((t) => t.innerText.replace(/\s+/g, ' ')),
}));
/** A message into the chat the way a script would, not typed: a typed command makes SillyTavern announce a generation it then drops. */
const send = (page, text) => page.evaluate((t) => SillyTavern.getContext().executeSlashCommandsWithOptions(`/send ${t}`), text);
const stateNow = () => readChat().then(stateOf);
/** Waits for the DOM (not the server) to show `ok(badges)`. */
async function waitDom(page, label, ok, ms = 90000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const b = await badges(page);
        if (ok(b)) {
            log(`[dom] ${label}: after ${Math.round((Date.now() - t0) / 1000)}s ${JSON.stringify(b)}`);
            return { b, s: (Date.now() - t0) / 1000 };
        }
        await sleep(1000);
    }
    log(`[dom] ${label}: not seen within ${ms / 1000}s ${JSON.stringify(await badges(page))}`);
    return null;
}

async function main() {
    for (const k of ['ST_DIR', 'BROWSER_WS', 'PROXY_URL']) if (!process.env[k]) throw new Error(`set ${k}`);
    const head = execFileSync('git', ['ls-remote', REPO_URL, 'HEAD'], { encoding: 'utf8' }).split('\t')[0];
    log(`[setup] ${REPO_URL} HEAD is ${head}`);
    const extDir = path.join(ST_DIR, 'data', 'default-user', 'extensions', 'canonkeeper');
    if (fs.existsSync(extDir)) throw new Error('not a fresh install: the extension is already there');

    await session();
    const lines = fs.readFileSync(path.join(REPO, 'fixtures/story/transcript.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    await api('/api/characters/create', { ch_name: CHAR, description: 'Narrator of The Saltwind Chart.', first_mes: '', personality: '', scenario: '', mes_example: '', creator_notes: '', talkativeness: 0.5, fav: false, tags: [] });
    await api('/api/chats/save', { ch_name: CHAR, file_name: CHAT, avatar_url: `${CHAR}.png`, chat: lines.slice(0, 1 + FIRST) });
    log(`[setup] chat '${CHAT}' saved with its first ${FIRST} messages`);

    browser = await chromium.connectOverCDP(BROWSER, { timeout: 600000 });
    const page = await openST(browser);

    // Install from the repo URL.
    await openDrawer(page, 'extensions-settings-button');
    await page.click('#third_party_extension_button');
    await page.waitForSelector('dialog.popup[open] .popup-input', { timeout: 30000 });
    await page.fill('dialog.popup[open] .popup-input', REPO_URL);
    await sleep(1000);
    await page.click('dialog.popup[open] .popup-button-ok');
    await page.locator('dialog.popup[open] .popup-input').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
    try {
        const warning = page.locator('dialog.popup[open]', { hasText: /third-party/i });
        await warning.waitFor({ timeout: 15000 });
        await warning.locator('.popup-button-ok').click();
    } catch {}
    for (let i = 0; i < 60 && !fs.existsSync(path.join(extDir, 'manifest.json')); i++) await sleep(2000);
    const installed = execFileSync('git', ['-C', extDir, 'log', '-1', '--format=%H %s'], { encoding: 'utf8' }).trim();
    log(`[server] extension on disk: ${installed}`);
    if (!installed.startsWith(head)) throw new Error('installed commit is not the repo HEAD');
    await sleep(3000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#canonkeeper_settings', { timeout: 60000, state: 'attached' });
    await sleep(4000);
    await dismissDialogs(page);

    // One working profile, one pointing at a proxy that is not there.
    await claudeProfile(page, 'claude-sonnet-5', GOOD);
    // Its own proxy preset: editing the shared one would kill the good profile too.
    await page.evaluate((u) => { $('#openai_reverse_proxy_name').val('dead-proxy').trigger('input'); $('#openai_reverse_proxy').val(u).trigger('input'); $('#save_proxy').trigger('click'); }, DEAD_URL);
    await command(page, `/profile-create ${DEAD}`);
    await sleep(3000);
    await openDrawer(page, 'extensions-settings-button');
    await page.click('#canonkeeper_settings .inline-drawer-toggle');
    await page.evaluate(async ({ CHAR, CHAT }) => {
        const c = SillyTavern.getContext();
        await c.selectCharacterById(c.characters.findIndex((x) => x.name === CHAR));
        await c.openCharacterChat(CHAT);
    }, { CHAR, CHAT });
    await page.waitForFunction((n) => SillyTavern.getContext().chat.length >= n, FIRST, { timeout: 60000 });
    check('healthy to begin with: no badge', (await badges(page)).wand.length === 0);

    // 1. Live on, no profile picked: badge and a sticky toast.
    await page.check('#canonkeeper_live');
    const noProfile = await waitDom(page, 'live on, no profile', (b) => b.wand.length && b.toasts.length);
    check('no profile: red badge on the wand and the panel header', noProfile?.b.wand[0] === 'red' && noProfile.b.head[0]?.startsWith('red'), JSON.stringify(noProfile?.b));
    check('no profile: sticky toast names the fix', /Pick a connection profile/.test(noProfile?.b.toasts[0] ?? ''), noProfile?.b.toasts[0]);
    await shot(page, '01-no-profile.png');

    // 2. Writer fine, detector dead. Cadence 4: eight messages are due at once.
    await page.selectOption('#canonkeeper_profile', { label: GOOD });
    await page.selectOption('#canonkeeper_detect_profile', { label: DEAD });
    await page.fill('#canonkeeper_cadence', '4');
    await page.press('#canonkeeper_cadence', 'Tab');
    await page.evaluate(() => $('#canonkeeper_detect_profile').trigger('change'));
    await send(page, 'Tamsin looks up from the chart.');
    const dead = await waitDom(page, 'dead detector', (b) => b.wand.length && b.toasts.some((t) => /Scene detection/i.test(t)), 120000);
    check('dead detector: badge and sticky toast within one cadence, read from the DOM', !!dead, JSON.stringify(dead?.b));
    await shot(page, '02-dead-detector.png');
    const stuck = await badges(page);
    await sleep(25000);
    const later = await badges(page);
    check('the toast is sticky: still there 25s later (the default ones go in 15)', later.toasts.some((t) => /Scene detection/.test(t)), `${stuck.toasts.length} then ${later.toasts.length}`);
    const s1 = await stateNow();
    log(`[server] health: ${JSON.stringify(s1?.health?.failing)}`);
    check('the failure is in the chat file, with cause and fix', !!s1?.health?.failing?.detector?.fix, JSON.stringify(s1?.health?.failing?.detector));

    const detToasts = (b) => b.toasts.filter((t) => /Scene detection/.test(t)).length;
    // 3. Four more messages: a retry, the same failure, no second toast.
    const before = detToasts(await badges(page));
    for (let i = 0; i < 4; i++) { await send(page, `Another line ${i}.`); await sleep(1500); }
    await sleep(15000);
    const retried = await stateNow();
    log(`[server] after the retry: ${retried?.health?.consecutive} failures in a row, ${retried.live.detectCalls} detection calls`);
    check('a retry of the same failure adds no scene-detection toast (the stall warning is a new kind)', detToasts(await badges(page)) === before, `${before} -> ${detToasts(await badges(page))}`);
    check('the stall warning is raised once messages pile up', /stalled/i.test((await badges(page)).toasts.join(' ')));
    check('...but it is counted', retried?.health?.consecutive >= 2, String(retried?.health?.consecutive));
    await openDrawer(page, 'extensions-settings-button');
    await page.locator('#canonkeeper_status').scrollIntoViewIfNeeded();
    const statusText = await page.locator('#canonkeeper_status').innerText();
    check('the status view lists the failure with its fix', /Failures \(\d+\)/.test(statusText) && /Fix:/.test(statusText), statusText.slice(0, 200).replace(/\s+/g, ' '));
    await shot(page, '03-status-failures.png');

    // 4. A reload does not lose it.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#canonkeeper_settings', { timeout: 60000, state: 'attached' });
    await sleep(5000);
    await dismissDialogs(page);
    await page.evaluate(async ({ CHAR, CHAT }) => {
        const c = SillyTavern.getContext();
        await c.selectCharacterById(c.characters.findIndex((x) => x.name === CHAR));
        await c.openCharacterChat(CHAT);
    }, { CHAR, CHAT });
    const reloaded = await waitDom(page, 'after reload', (b) => b.wand.length, 30000);
    check('the badge survives a reload', !!reloaded, JSON.stringify(reloaded?.b));

    // 5. Fix the profile; after the next cadence the badge and toast go.
    await openDrawer(page, 'extensions-settings-button');
    const drawer = await page.$eval('#canonkeeper_settings .inline-drawer-content', (el) => getComputedStyle(el).display !== 'none');
    if (!drawer) await page.click('#canonkeeper_settings .inline-drawer-toggle');
    await page.selectOption('#canonkeeper_detect_profile', { label: GOOD });
    for (let i = 0; i < 4; i++) { await send(page, `After the fix ${i}.`); await sleep(1500); }
    const fixed = await waitDom(page, 'after the fix', (b) => b.wand.length === 0 && b.toasts.length === 0, 180000);
    check('after the profile is fixed the badge and the toast clear on the next success', !!fixed, JSON.stringify(fixed?.b));
    const s2 = await stateNow();
    check('the chat file agrees: nothing failing, history kept', Object.keys(s2.health.failing).length === 0 && s2.health.history.length >= 2, `${s2.health.history.length} in history`);
    await shot(page, '04-recovered.png');
    save('health.json', s2.health);
    save('chat.jsonl', (await readChat()).map((l) => JSON.stringify(l)).join('\n') + '\n');

    await browser.close();
    save('health-result.json', results);
    const failed = results.filter((r) => !r.ok);
    log(`[result] ${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) process.exitCode = 1;
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
