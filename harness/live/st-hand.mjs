// Live acceptance run for fixing a flagged fact by hand (PHA-3999), driven
// from outside the page. A fresh SillyTavern is driven through browserless as
// a user would: install from the repo URL, make the writer and claim-checker
// connection profiles, type /canon. Then three facts are given the wrong
// message to cite (through the ledger, as a mis-citing model would), and
// /canon-audit must flag them. In the status view:
//   A  "Pick the message myself": the right message is typed in. The fact is
//      saved, and a full re-check (/canon-audit recheck=true) no longer flags it.
//   B  "Edit this fact" with a wording the messages don't support: the warning
//      appears with the checker's reason; Cancel leaves the lorebook as it was.
//   C  the same, then Save anyway: the new wording is saved and stays flagged.
// Every check reads SillyTavern's HTTP API from this process. Writes
// evidence/<stamp>/: hand.log, screenshots, the books and chat as the server
// holds them, and hand-result.json (the checks, pass or fail).
//
// Environment as for st-audit.mjs: ST_DIR, ST_PAGE, ST_API, BROWSER_WS,
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

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(env('OUT_DIR', path.join(REPO, '.run', 'live-hand')), stamp);
fs.mkdirSync(OUT, { recursive: true });
const logFile = fs.createWriteStream(path.join(OUT, 'hand.log'));
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

    // 5. Give three facts the wrong message to cite, as a mis-citing model
    //    would: in the ledger, then the book is compiled from it with no model.
    const planted = await page.evaluate(async () => {
        const base = new URL('/scripts/extensions/third-party/canonkeeper/', location.href).href;
        const { update } = await import(base + 'src/update.js');
        const { toMessages, STATE_KEY } = await import(base + 'adapter/run.js');
        const c = SillyTavern.getContext();
        const state = c.chatMetadata[STATE_KEY];
        const ledger = structuredClone(state.ledger);
        const messages = toMessages(c.chat);
        const out = [];
        for (const e of ledger.entities) {
            if (out.length >= 3) break;
            const fact = e.facts.find((f) => f.messages.length === 1);
            if (!fact || e.facts.length < 2) continue;
            const was = fact.messages[0];
            const now = (was + Math.floor(messages.length / 2)) % messages.length;
            out.push({ uid: e.uid, entity: e.name, text: fact.text, was: [was], now: [now] });
            fact.messages = [now];
        }
        const book = await c.loadWorldInfo(state.book);
        const res = await update({ book, ledger, messages, generate: async () => { throw new Error('no model call expected'); }, contextTokens: 200000 });
        await c.saveWorldInfo(state.book, res.book, true);
        state.ledger = res.ledger;
        await c.saveMetadata();
        return out;
    });
    if (planted.length < 2) throw new Error(`could only plant ${planted.length} mis-citations`);
    for (const p of planted) log(`[setup] planted: '${p.entity}': "${p.text}" now cites ${p.now.map((m) => `#${m}`)} instead of ${p.was.map((m) => `#${m}`)}`);
    save('planted.json', planted);
    save('book-planted.json', await readBook(name));

    // 6. Audit: the planted facts must be flagged, each with hand-edit buttons.
    const t2 = Date.now();
    await command(page, '/canon-audit');
    const audited = await waitForAudit(t2, '/canon-audit (planted)', page);
    logFindings(audited.got);
    save('audit-planted.json', audited.got);
    // A finding's id is 'claim:' + the claim's id, which keys the verdicts.
    const claimKey = (id) => id.replace(/^claim:/, '');
    const flaggedOf = (audit, p) => audit.findings.find((f) => f.check === 'claim' && f.claim === p.text);
    const flagged = planted.filter((p) => flaggedOf(audited.got, p));
    log(`[server] the audit flagged ${flagged.length} of ${planted.length} planted facts`);
    check('the audit flags the planted mis-citations', flagged.length >= 2, `${flagged.length} of ${planted.length}`);
    const [A, B, C] = flagged;
    await showStatus(page, '02-flagged.png');

    const button = (id, fix) => page.locator(`#canonkeeper_status [data-action="hand"][data-fix="${fix}"][data-finding="${id}"]`);
    const factIn = (book, p) => titled(book, p.entity)?.canonkeeper?.facts?.find((f) => f.text === p.text);
    const dialog = page.locator('dialog.popup[open]');

    // 7. A: pick the right message by hand.
    const idA = flaggedOf(audited.got, A).id;
    check('a flagged fact has both hand buttons', (await button(idA, 'pick').count()) === 1 && (await button(idA, 'edit').count()) === 1);
    await button(idA, 'pick').click();
    await dialog.waitFor({ timeout: 15000 });
    log(`[ui] 'Pick the message myself': dialog '${(await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 200)}'`);
    await shot(page, '03-pick-dialog.png');
    await dialog.locator('.popup-input').fill(A.was.join(', '));
    const tA = Date.now();
    await dialog.locator('.popup-button-ok').click();
    log(`[ui] typed ${A.was.map((m) => `#${m}`)} and pressed OK`);
    const accA = await waitFor(tA, 'hand pick', page, (s) => {
        const a = s?.audit?.accepted?.find((x) => x.id === idA && /by hand/.test(x.says));
        return a ? { at: a.at, log: [`${a.says}: ${a.writes.join('; ')}`] } : null;
    });
    const afterA = await readBook(name);
    save('book-after-pick.json', afterA);
    const factA = factIn(afterA, A);
    log(`[server] '${A.entity}' fact now cites ${JSON.stringify(factA?.sources)}`);
    check('A is saved citing the message the person typed', JSON.stringify(factA?.sources) === JSON.stringify(A.was.map((m) => [m, m])), JSON.stringify(factA?.sources));
    check('A is no longer in the queue', !stateOf(accA.chat).audit.findings.some((f) => f.id === idA && !f.dismissed));
    // The next audit, with the checker asked about everything again.
    const t3 = Date.now();
    await command(page, '/canon-audit recheck=true');
    const re = await waitForAudit(t3, '/canon-audit recheck (after pick)', page);
    logFindings(re.got);
    save('audit-after-pick.json', re.got);
    check('the full re-check asked the checker', re.got.calls > 0, `${re.got.calls} calls`);
    check('A verifies on the next audit', !re.got.findings.some((f) => f.id === idA) && re.got.verdicts[claimKey(idA)]?.verdict === 'supported', re.got.verdicts[claimKey(idA)]?.verdict);
    await showStatus(page, '04-after-pick.png');

    // 8. B: a wording the messages do not support: warned, then cancelled.
    const idB = flaggedOf(re.got, B)?.id;
    if (!idB) throw new Error('B is no longer flagged after the re-check');
    const bookBefore = JSON.stringify((await readBook(name)).entries);
    B.wording = `${B.text.replace(/\.$/, '')}, and then the whole harbor was swallowed by a sea serpent.`;
    await button(idB, 'edit').click();
    await dialog.waitFor({ timeout: 15000 });
    log(`[ui] 'Edit this fact': dialog '${(await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 200)}'`);
    await dialog.locator('.popup-input').fill(B.wording);
    await dialog.locator('.popup-button-ok').click();
    await page.waitForFunction(() => /do not support/.test(document.querySelector('dialog.popup[open]')?.innerText ?? ''), null, { timeout: 180000 });
    const warningB = (await dialog.innerText()).replace(/\s+/g, ' ');
    log(`[ui] warning before save: '${warningB}'`);
    await shot(page, '05-warning.png');
    check('B is warned before save, with the checker\'s reason', /do not support/.test(warningB) && warningB.length > 120, warningB.slice(0, 160));
    const book1 = JSON.stringify((await readBook(name)).entries);
    check('nothing is saved while the warning is open', book1 === bookBefore);
    await dialog.locator('.popup-button-cancel').click();
    await sleep(4000);
    const book2 = JSON.stringify((await readBook(name)).entries);
    check('Cancel leaves the lorebook as it was', book2 === bookBefore);
    check('Cancel leaves no accepted record for B', !(stateOf(await readChat()).audit.accepted ?? []).some((x) => x.id === idB));

    // 9. C: the same, and Save anyway.
    if (C) {
        const idC = flaggedOf(re.got, C)?.id;
        C.wording = `${C.text.replace(/\.$/, '')}, and everyone in the harbor agreed with a sea serpent.`;
        await button(idC, 'edit').click();
        await dialog.waitFor({ timeout: 15000 });
        await dialog.locator('.popup-input').fill(C.wording);
        await dialog.locator('.popup-button-ok').click();
        await page.waitForFunction(() => /do not support/.test(document.querySelector('dialog.popup[open]')?.innerText ?? ''), null, { timeout: 180000 });
        log(`[ui] warning before save: '${(await dialog.innerText()).replace(/\s+/g, ' ')}'`);
        const tC = Date.now();
        await dialog.locator('.popup-button-ok').click();
        log('[ui] saved anyway');
        await waitFor(tC, 'hand edit, saved anyway', page, (s) => {
            const a = s?.audit?.accepted?.find((x) => x.id === idC && /by hand/.test(x.says));
            return a ? { at: a.at, log: [`${a.says}: ${a.writes.join('; ')}`] } : null;
        });
        const afterC = await readBook(name);
        save('book-after-save-anyway.json', afterC);
        const textsC = titled(afterC, C.entity)?.canonkeeper?.facts?.map((f) => f.text) ?? [];
        check('C is saved with the person\'s wording', textsC.includes(C.wording) && !textsC.includes(C.text));
        const t4 = Date.now();
        await command(page, '/canon-audit');
        const last = await waitForAudit(t4, '/canon-audit (after save anyway)', page);
        logFindings(last.got);
        save('audit-final.json', last.got);
        check('C stays flagged on the next audit', last.got.findings.some((f) => f.check === 'claim' && f.claim === C.wording && !f.dismissed));
        await showStatus(page, '06-final.png');
    } else log('[setup] only two planted facts were flagged: C skipped');
    save('chat.jsonl', (await readChat()).map((l) => JSON.stringify(l)).join('\n') + '\n');

    await browser.close();
    save('hand-result.json', results);
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
