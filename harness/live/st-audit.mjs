// Live acceptance run for Canonkeeper build step 6 (the audit), driven from
// outside the page. A fresh SillyTavern is driven through browserless as a
// user would: install from the repo URL, make two connection profiles (the
// writer and a cheap claim checker), type /canon, then /canon-audit on the
// book as built. Then the book is damaged as a user might damage it: one
// entry is deleted in SillyTavern's World Info editor, and two entries are
// given the same key. /canon-audit must catch both, /canon must leave the
// deleted entry deleted, and the fixes are accepted from the review queue in
// the status view. Every check reads SillyTavern's HTTP API from this
// process. Writes evidence/<stamp>/: audit.log, screenshots, the books and
// chat as the server holds them, and the gate's verdict (--audit).
//
// Environment as for st-live.mjs: ST_DIR, ST_PAGE, ST_API, BROWSER_WS,
// PROXY_URL, OUT_DIR. Needs playwright-core next to it.

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
const PLANT = JSON.parse(fs.readFileSync(path.join(REPO, 'fixtures/story/audit/plant.json'), 'utf8'));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(env('OUT_DIR', path.join(REPO, '.run', 'live-audit')), stamp);
fs.mkdirSync(path.join(OUT, 'clean'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'planted'), { recursive: true });
const logFile = fs.createWriteStream(path.join(OUT, 'audit.log'));
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

/** Deletes an entry in SillyTavern's own World Info editor, as a user would. */
async function deleteInEditor(page, bookName, uid) {
    await openDrawer(page, 'WI-SP-button');
    await page.evaluate((name) => {
        const i = SillyTavern.getContext().getWorldInfoNames().indexOf(name);
        $('#world_editor_select').val(i).trigger('change');
    }, bookName);
    const entry = page.locator(`#world_popup_entries_list .world_entry[uid="${uid}"]`);
    await entry.waitFor({ timeout: 30000 });
    await entry.scrollIntoViewIfNeeded();
    await shot(page, '04-editor-before-delete.png');
    await entry.locator('.delete_entry_button').click();
    log(`[ui] World Info editor: clicked delete on entry uid ${uid}`);
    try {
        const confirm = page.locator('dialog.popup[open]');
        await confirm.waitFor({ timeout: 5000 });
        log(`[ui] confirm dialog: '${(await confirm.innerText()).replace(/\s+/g, ' ').slice(0, 120)}': confirmed`);
        await confirm.locator('.popup-button-ok').click();
    } catch {
        log('[ui] no confirm dialog');
    }
    await sleep(3000);
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
    const lines = fs.readFileSync(path.join(REPO, 'fixtures/story/transcript.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    await api('/api/characters/create', { ch_name: CHAR, description: 'Narrator of The Saltwind Chart.', first_mes: '', personality: '', scenario: '', mes_example: '', creator_notes: '', talkativeness: 0.5, fav: false, tags: [] });
    await api('/api/chats/save', { ch_name: CHAR, file_name: CHAT, avatar_url: `${CHAR}.png`, chat: lines });
    log(`[setup] character '${CHAR}' and chat '${CHAT}' (${lines.length - 1} messages) saved to the server`);

    browser = await chromium.connectOverCDP(BROWSER, { timeout: 600000 });
    const page = await openST(browser);
    log('[ui] SillyTavern loaded');

    // 1. Install from the repo URL.
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
    log(`[server] extension on disk at ${path.relative(ST_DIR, extDir)}: ${installed}`);
    if (!installed.startsWith(head)) throw new Error('installed commit is not the repo HEAD');
    await sleep(3000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#send_textarea', { timeout: 180000 });
    await page.waitForSelector('#canonkeeper_settings', { timeout: 60000, state: 'attached' });
    await sleep(4000);
    await dismissDialogs(page);
    log('[ui] page reloaded; Canonkeeper panel present');

    // 2. Two connection profiles: the writer, and a cheap model to check claims.
    await claudeProfile(page, 'claude-haiku-4-5', CHECKER);
    await claudeProfile(page, 'claude-sonnet-5', WRITER);

    // 3. Canonkeeper settings: the writer, and the claim checker.
    await openDrawer(page, 'extensions-settings-button');
    await page.click('#canonkeeper_settings .inline-drawer-toggle');
    await sleep(500);
    await page.selectOption('#canonkeeper_profile', { label: WRITER });
    await page.selectOption('#canonkeeper_audit_profile', { label: CHECKER });
    await sleep(2000);
    const verify = await page.isChecked('#canonkeeper_audit_verify');
    log(`[ui] Canonkeeper panel: writer '${WRITER}', claim check '${CHECKER}'; claim verification ticked: ${verify}`);
    await page.locator('#canonkeeper_audit').scrollIntoViewIfNeeded();
    await shot(page, '01-settings.png');

    // 4. Open the chat and build the book.
    await page.evaluate(async ({ CHAR, CHAT }) => {
        const c = SillyTavern.getContext();
        const id = c.characters.findIndex((x) => x.name === CHAR);
        await c.selectCharacterById(id);
        await c.openCharacterChat(CHAT);
    }, { CHAR, CHAT });
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 50, null, { timeout: 60000 });
    log(`[ui] opened chat '${CHAT}': ${await page.evaluate(() => SillyTavern.getContext().chat.length)} messages`);
    const t1 = Date.now();
    await command(page, '/canon');
    const run1 = await waitForRun(t1, '/canon', page);
    if (!run1.got.ok) throw new Error(`/canon failed: ${run1.got.error}`);
    const name = stateOf(run1.chat).book;
    const built = await readBook(name);
    log(`[server] lorebook '${name}': ${Object.keys(built.entries).length} entries`);
    save('book-built.json', built);

    // 5. Audit the book as built: nothing technical should come up.
    const t2 = Date.now();
    await command(page, '/canon-audit');
    const clean = await waitForAudit(t2, '/canon-audit (as built)', page);
    logFindings(clean.got);
    save('clean/audit.json', clean.got);
    await showStatus(page, '02-audit-as-built.png');

    // 6. Damage the book as a user might: delete one entry in the World Info
    //    editor, and give two entries the same key (through SillyTavern's own
    //    World Info save, which the editor uses).
    const gone = titled(built, PLANT.delete);
    if (!gone) throw new Error(`the built book has no '${PLANT.delete}' to delete`);
    await deleteInEditor(page, name, gone.uid);
    let now = await readBook(name);
    if (String(gone.uid) in now.entries) throw new Error(`entry uid ${gone.uid} is still in the lorebook file after deleting it in the editor`);
    log(`[server] '${gone.comment}' (uid ${gone.uid}) is gone from the lorebook file`);
    const collided = PLANT.collision.entries.map((t) => titled(now, t));
    if (collided.some((e) => !e)) throw new Error(`the book lacks one of ${PLANT.collision.entries.join(', ')}`);
    await page.evaluate(async ({ name, uids, key }) => {
        const c = SillyTavern.getContext();
        const book = await c.loadWorldInfo(name);
        for (const uid of uids) book.entries[uid].key.push(key);
        await c.saveWorldInfo(name, book, true);
        c.reloadWorldInfoEditor(name, false);
    }, { name, uids: collided.map((e) => e.uid), key: PLANT.collision.key });
    now = await readBook(name);
    log(`[server] '${PLANT.collision.key}' is now a key of ${collided.map((e) => `'${e.comment}' (${JSON.stringify(now.entries[e.uid].key)})`).join(' and ')}`);
    await shot(page, '03-editor-after-edits.png');
    save('planted/planted.json', { collision: { key: PLANT.collision.key, uids: collided.map((e) => e.uid) }, deleted: { uid: gone.uid, title: gone.comment }, falseFacts: [] });
    save('planted/planted-book.json', now);

    // 7. Audit again: both must be caught, and nothing written.
    const t3 = Date.now();
    await command(page, '/canon-audit');
    const planted = await waitForAudit(t3, '/canon-audit (damaged)', page);
    logFindings(planted.got);
    save('planted/audit.json', planted.got);
    const afterAudit = await readBook(name);
    save('planted/book.json', afterAudit);
    log(`[server] lorebook file unchanged by the audit: ${JSON.stringify(afterAudit.entries) === JSON.stringify(now.entries)}`);
    await showStatus(page, '05-review-queue.png');

    // 8. /canon on the damaged book: the deleted entry stays deleted, and the
    //    two edited entries are held.
    const t4 = Date.now();
    await command(page, '/canon');
    const run2 = await waitForRun(t4, '/canon (damaged)', page);
    const rerun = await readBook(name);
    save('planted/rerun.json', rerun);
    log(`[server] /canon: ok=${run2.got.ok}, writes=${run2.got.plan?.length}, held=${JSON.stringify(run2.got.held)}; '${gone.comment}' back in the book: ${String(gone.uid) in rerun.entries}`);

    // 9. Accept the fixes from the review queue, by clicking them.
    for (const id of [`deleted:${gone.uid}`, `collision:${PLANT.collision.key.toLowerCase()}`]) {
        await showStatus(page, `06-before-accept-${id.split(':')[0]}.png`);
        const button = page.locator(`#canonkeeper_status [data-action="accept"][data-finding="${id}"]`);
        if (!(await button.count())) throw new Error(`no Accept button for ${id} in the status view`);
        log(`[ui] clicking '${(await button.innerText()).trim()}'`);
        const t = Date.now();
        await button.click();
        await waitFor(t, `accept ${id}`, page, (s) => {
            const a = s?.audit?.accepted?.find((x) => x.id === id);
            return a ? { at: a.at, log: [`${a.says}: ${a.writes.join('; ')}`] } : null;
        });
    }
    const fixed = await readBook(name);
    save('book-after-fixes.json', fixed);
    log(`[server] after the fixes: '${gone.comment}' restored on uid ${gone.uid}: ${fixed.entries[gone.uid]?.comment === gone.comment}; '${PLANT.collision.key}' on ${collided.map((e) => `'${e.comment}': ${fixed.entries[e.uid].key.includes(PLANT.collision.key)}`).join(', ')}`);
    await showStatus(page, '07-after-fixes.png');

    // 10. A last audit, technical pass only: nothing left.
    await page.locator('#canonkeeper_audit_verify').uncheck();
    const t5 = Date.now();
    await page.click('#canonkeeper_audit');
    log('[ui] unticked claim verification and clicked Audit');
    const last = await waitForAudit(t5, 'Audit (after fixes)', page);
    logFindings(last.got);
    save('audit-after-fixes.json', last.got);
    await showStatus(page, '08-final-audit.png');
    save('chat.jsonl', (await readChat()).map((l) => JSON.stringify(l)).join('\n') + '\n');

    await browser.close();

    const gate = spawnSync('node', [path.join(REPO, 'harness/gate.js'), '--story', path.join(REPO, 'fixtures/story'), '--run', OUT, '--audit'], { encoding: 'utf8' });
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
