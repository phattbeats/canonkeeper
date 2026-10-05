// The step 7 extras, recall and clips, in a real SillyTavern, driven from
// outside the page. The rule both have to keep: if the extra fails, the
// story is generated exactly as it would be without it. So this run looks at
// the one thing that decides the story, the request the roleplay model gets.
//
// The roleplay model is a small OpenAI-compatible endpoint in this process.
// It keeps the body of every request. The fixture chat, cut after message
// 49 (a user line), is opened, /canon builds its book with a real model, and
// then one reply at a time is generated, recorded and deleted, so every
// generation sees the same chat:
//
//   recall off, twice    the baseline, and proof the comparison is stable
//   recall on            ticked in the panel: the baseline plus the picks
//   recall broken        a corrupt state store in the page: the baseline
//   clip broken          /canon-clip with the writer pointed at the roleplay
//                        endpoint, which answers in prose: the lorebook file
//                        is byte-identical, and so is the next prompt
//   clip                 a sentence of message 48 highlighted on the page and
//                        clipped with the scissors in its message actions:
//                        one new entry, nothing else changed, and /canon then
//                        makes no write and holds it
//
// Everything is read through SillyTavern's HTTP API or the endpoint, never
// from the page's say-so. Writes evidence/<stamp>/: extras.log, screenshots,
// the prompts, extras.json, and the gate's verdict (--extras).
//
//   ST_DIR, ST_PAGE, ST_API, BROWSER_WS, PROXY_URL   as for st-live.mjs
//   RP_PORT   port for the roleplay endpoint (default 8124); SillyTavern's
//             server must reach it on 127.0.0.1

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const env = (k, d) => process.env[k] ?? d;
const ST_DIR = env('ST_DIR');
const ST_PAGE = env('ST_PAGE', 'http://127.0.0.1:8000/');
const ST_API = env('ST_API', 'http://127.0.0.1:8000');
const BROWSER = env('BROWSER_WS');
const PROXY_URL = env('PROXY_URL');
const RP_PORT = Number(env('RP_PORT', '8124'));
const REPO_URL = 'https://github.com/phattbeats/canonkeeper';
const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const WRITER = 'Claude Sonnet 5 (anthropic-proxy)';
const ROLEPLAY = 'Roleplay (fixture endpoint)';
const CHAR = 'Narrator';
const CHAT = 'Saltwind extras';
const CUT = 50; // messages 0-49: the chat ends on a user line
const RECALL = { maxEntries: 3, budgetTokens: 600 };
const CLIP_AT = 48;
const CLIP_TEXT = 'Saul writes the letter at his small desk, seals it with green wax pressed with a lantern sigil, and hands it to her.';
const RUN_TIMEOUT = 20 * 60 * 1000;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(env('OUT_DIR', path.join(REPO, '.run', 'live-extras')), stamp);
fs.mkdirSync(path.join(OUT, 'prompts'), { recursive: true });
const logFile = fs.createWriteStream(path.join(OUT, 'extras.log'));
const log = (...parts) => {
    const line = `${new Date().toISOString()} ${parts.join(' ')}`;
    console.log(line);
    logFile.write(line + '\n');
};
const save = (name, value) => fs.writeFileSync(path.join(OUT, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const lines = fs.readFileSync(path.join(REPO, 'fixtures/story/transcript.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const chatLines = lines.slice(0, CUT + 1);

// --- The roleplay model: keeps every request body ------------------------------
const requests = [];
const REPLY = 'The lamp turns, and the tide comes in over the causeway stones.';
const rp = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
        if (req.method === 'GET' && req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ object: 'list', data: [{ id: 'saltwind-narrator', object: 'model' }] }));
        }
        const data = JSON.parse(body || '{}');
        requests.push({ at: Date.now(), body: data });
        log(`[roleplay] request ${requests.length}: ${data.messages?.length ?? 0} messages${data.stream ? ' (streamed)' : ''}`);
        if (data.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: REPLY } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
            return res.end('data: [DONE]\n\n');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `rp-${requests.length}`, object: 'chat.completion', model: 'saltwind-narrator', choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }] }));
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
async function api(route, body = {}, raw = false) {
    const r = await fetch(`${ST_API}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie }, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${route} -> ${r.status} ${text.slice(0, 300)}`);
    if (raw) return text;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
const readChat = () => api('/api/chats/get', { ch_name: CHAR, file_name: CHAT, avatar_url: `${CHAR}.png` });
const bookText = (name) => api('/api/worldinfo/get', { name }, true);
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
    log(`[ui] typing '${text.length > 80 ? `${text.slice(0, 80)}...` : text}' into the chat box and pressing Enter`);
    await page.fill('#send_textarea', text);
    await page.press('#send_textarea', 'Enter');
    // An autocomplete popup can take the first Enter: the box keeps the text.
    for (let i = 0; i < 3; i++) {
        await sleep(700);
        if (!(await page.inputValue('#send_textarea'))) return;
        log('[ui] the chat box still holds the command (autocomplete took the Enter): closing it and pressing Enter again');
        await page.keyboard.press('Escape');
        await page.press('#send_textarea', 'Enter');
    }
    throw new Error(`the command '${text}' was never sent`);
}

/** A Canonkeeper toast on the page, as the user reads it, or null. */
async function toast(page) {
    const t = await page.$('#toast-container .toast-error, #toast-container .toast-warning');
    return t ? (await t.innerText()).replace(/\s+/g, ' ') : null;
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

const idle = (page) => page.waitForFunction(() => getComputedStyle(document.getElementById('mes_stop')).display === 'none', null, { timeout: 120000 });

/**
 * One reply, generated from the same chat every time: World Info's timed
 * effects are cleared first, the reply is generated with /trigger, its
 * request kept, and the reply deleted. Returns the request's messages.
 */
async function capture(page, label) {
    await page.evaluate(() => {
        SillyTavern.getContext().chatMetadata.timedWorldInfo = {};
    });
    const from = requests.length;
    await command(page, '/trigger');
    await page.waitForFunction((n) => SillyTavern.getContext().chat.length > n, CUT, { timeout: 120000 });
    await idle(page);
    await sleep(1000);
    const got = requests.slice(from);
    if (got.length !== 1) throw new Error(`${label}: the roleplay endpoint got ${got.length} requests, not 1`);
    await page.evaluate(async () => SillyTavern.getContext().deleteLastMessage());
    await page.waitForFunction((n) => SillyTavern.getContext().chat.length === n, CUT, { timeout: 30000 });
    await sleep(1000);
    const messages = got[0].body.messages;
    save(`prompts/${label}.json`, got[0].body);
    log(`[roleplay] ${label}: prompt of ${messages.length} messages, ${JSON.stringify(messages).length} chars; reply deleted, chat back to ${CUT} messages`);
    return messages;
}

async function waitForRecord(after, label, pick, page) {
    const until = Date.now() + RUN_TIMEOUT;
    let seen = null;
    while (Date.now() < until) {
        const said = page ? await toast(page) : null;
        if (said && said !== seen) log(`[ui] ${label}: toast on the page: '${(seen = said)}'`);
        const chat = await readChat();
        const rec = pick(stateOf(chat));
        if (rec && new Date(rec.at).getTime() >= after) {
            log(`[server] ${label}: chat file records ok=${rec.ok}${rec.error ? `, error '${rec.error}'` : ''}`);
            for (const line of rec.log ?? []) log(`[server]   ${line}`);
            return { chat, rec };
        }
        if (said && /already running|Open a chat|Pick a connection|Wait for the reply/.test(said)) throw new Error(`${label}: refused: ${said}`);
        await sleep(3000);
    }
    throw new Error(`${label}: nothing recorded within ${RUN_TIMEOUT / 60000} min`);
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

async function pickWriter(page, label) {
    await openDrawer(page, 'extensions-settings-button');
    await page.selectOption('#canonkeeper_profile', { label });
    await sleep(1500);
    log(`[ui] Canonkeeper panel: writer profile '${label}'`);
}

let browser = null;

async function main() {
    for (const k of ['ST_DIR', 'BROWSER_WS', 'PROXY_URL']) if (!process.env[k]) throw new Error(`set ${k}`);
    await new Promise((r) => rp.listen(RP_PORT, '127.0.0.1', r));
    log(`[setup] roleplay endpoint on 127.0.0.1:${RP_PORT}`);
    const head = execFileSync('git', ['ls-remote', REPO_URL, 'HEAD'], { encoding: 'utf8' }).split('\t')[0];
    log(`[setup] ${REPO_URL} HEAD is ${head}`);
    const extDir = path.join(ST_DIR, 'data', 'default-user', 'extensions', 'canonkeeper');
    log(`[setup] SillyTavern ${JSON.parse(fs.readFileSync(path.join(ST_DIR, 'package.json'), 'utf8')).version}; canonkeeper installed before the run: ${fs.existsSync(extDir)}`);
    if (fs.existsSync(extDir)) throw new Error('not a fresh install: the extension is already there');

    await session();
    await api('/api/characters/create', { ch_name: CHAR, description: 'Narrator of The Saltwind Chart.', first_mes: '', personality: '', scenario: '', mes_example: '', creator_notes: '', talkativeness: 0.5, fav: false, tags: [] });
    await api('/api/chats/save', { ch_name: CHAR, file_name: CHAT, avatar_url: `${CHAR}.png`, chat: chatLines });
    log(`[setup] character '${CHAR}' and chat '${CHAT}' (messages 0-${CUT - 1} of the fixture; the last is a user line) saved to the server`);

    browser = await chromium.connectOverCDP(BROWSER, { timeout: 120000 });
    const bctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = await bctx.newPage();
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

    // 2. Profiles: the writer, then the roleplay connection, left active.
    await claudeProfile(page, 'claude-sonnet-5', WRITER);
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
    log(`[ui] roleplay connection: Chat Completion → Custom, http://127.0.0.1:${RP_PORT}/v1; saved as '${ROLEPLAY}' and left active`);

    await openDrawer(page, 'extensions-settings-button');
    await page.click('#canonkeeper_settings .inline-drawer-toggle');
    await sleep(500);
    await pickWriter(page, WRITER);
    await page.fill('#canonkeeper_recall_entries', String(RECALL.maxEntries));
    await page.dispatchEvent('#canonkeeper_recall_entries', 'change');
    await page.fill('#canonkeeper_recall_tokens', String(RECALL.budgetTokens));
    await page.dispatchEvent('#canonkeeper_recall_tokens', 'change');
    log(`[ui] recall: at most ${RECALL.maxEntries} entries within ${RECALL.budgetTokens} tokens; recall left off`);

    // 3. The chat, and /canon builds its book.
    await page.evaluate(async ({ CHAR, CHAT }) => {
        const c = SillyTavern.getContext();
        await c.selectCharacterById(c.characters.findIndex((x) => x.name === CHAR));
        await c.openCharacterChat(CHAT);
    }, { CHAR, CHAT });
    await page.waitForFunction((n) => SillyTavern.getContext().chat.length === n, CUT, { timeout: 60000 });
    log(`[ui] opened chat '${CHAT}': ${CUT} messages`);
    const t0 = Date.now();
    await command(page, '/canon');
    const { rec: built } = await waitForRecord(t0, '/canon', (s) => s?.lastRun, page);
    if (!built.ok) throw new Error(`/canon failed: ${built.error}`);
    await idle(page);
    await sleep(3000);
    const bookName = stateOf(await readChat()).book;
    const builtBook = await bookText(bookName);
    log(`[server] lorebook '${bookName}': ${Object.keys(JSON.parse(builtBook).entries).length} entries; scene starts ${JSON.stringify(built.scenes)}`);
    const scanDepth = await page.evaluate(() => $('#world_info_depth').val());
    log(`[ui] SillyTavern World Info scan depth: ${scanDepth}`);
    // A window the whole chat fits in, so no message is cut from the prompt
    // and two prompts compare message for message.
    const context = await page.evaluate(() => {
        $('#oai_max_context_unlocked').prop('checked', true).trigger('input').trigger('change');
        $('#openai_max_context').val(32000).trigger('input').trigger('change');
        return $('#openai_max_context').val();
    });
    log(`[ui] roleplay context window set to ${context} tokens`);
    // With World Info's recursive scan on, an entry's text pulls in every
    // entry it names, and on this book that already holds everything the
    // scene names: recall rightly adds nothing. So recall is compared with
    // recursion off, a setting users choose, and once more with it on.
    const recursive = await page.evaluate(() => {
        const was = $('#world_info_recursive').prop('checked');
        $('#world_info_recursive').prop('checked', false).trigger('input').trigger('change');
        return { was, now: $('#world_info_recursive').prop('checked') };
    });
    log(`[ui] World Info recursive scan: was ${recursive.was ? 'on' : 'off'}, now ${recursive.now ? 'on' : 'off'}`);

    // 4. Recall: off twice, on, broken.
    const x = { recall: { ...RECALL, broken: [] }, clip: {} };
    x.recall.off = await capture(page, 'recall-off');
    x.recall.off2 = await capture(page, 'recall-off-again');
    log(`[check] two prompts with recall off identical: ${same(x.recall.off, x.recall.off2)}`);

    await openDrawer(page, 'extensions-settings-button');
    await page.locator('#canonkeeper_recall').check();
    await sleep(1000);
    log('[ui] Recall ticked in the panel');
    x.recall.on = await capture(page, 'recall-on');
    await sleep(1500);
    if (x.recall.on.length !== x.recall.off.length + 1) log(`[check] recall on: ${x.recall.on.length} messages vs ${x.recall.off.length} with recall off`);
    const uids = await page.$$eval('#canonkeeper_status .canonkeeper-recalled', (els) => els.map((e) => Number(e.dataset.uid)));
    const book = JSON.parse(builtBook).entries;
    x.recall.picks = uids.map((uid) => ({ uid, title: book[uid].comment, content: book[uid].content }));
    log(`[ui] status view: recall picked ${x.recall.picks.map((p) => `'${p.title}'`).join(', ') || 'nothing'}`);
    await page.locator('#canonkeeper_status').scrollIntoViewIfNeeded();
    await shot(page, '01-recall-on.png');

    // Broken: the live state store's scene starts made unreadable, in the
    // page only (never saved), as a corrupt chat file would leave them.
    await page.evaluate(() => {
        SillyTavern.getContext().chatMetadata.canonkeeper.live = { starts: 7 };
    });
    log('[setup] recall broken: chat_metadata.canonkeeper.live.starts set to 7 (not a list) in the page');
    x.recall.broken.push({ what: 'a corrupt state store', prompt: await capture(page, 'recall-broken') });
    await sleep(1500);
    log(`[ui] status view: ${(await page.$eval('#canonkeeper_status', (el) => el.innerText)).split('\n').find((l) => l.startsWith('Recall')) ?? '(no recall line)'}`);
    await shot(page, '02-recall-broken.png');
    await page.evaluate(() => {
        delete SillyTavern.getContext().chatMetadata.canonkeeper.live;
    });
    // Recall on with recursion on: an observation, not gated.
    await page.evaluate(() => $('#world_info_recursive').prop('checked', true).trigger('input').trigger('change'));
    log('[ui] World Info recursive scan back on');
    const recOff = await (async () => {
        await page.locator('#canonkeeper_recall').uncheck();
        await sleep(800);
        return capture(page, 'recursive-recall-off');
    })();
    await page.locator('#canonkeeper_recall').check();
    await sleep(800);
    const recOn = await capture(page, 'recursive-recall-on');
    await sleep(1500);
    x.recall.recursive = { off: recOff, on: recOn, picks: await page.$$eval('#canonkeeper_status .canonkeeper-recalled', (els) => els.map((e) => Number(e.dataset.uid))) };
    log(`[check] recursion on: recall ${same(recOff, recOn) ? 'added nothing (World Info already held what the scene names)' : `added ${recOn.length - recOff.length} message(s)`}`);
    await page.evaluate(() => $('#world_info_recursive').prop('checked', false).trigger('input').trigger('change'));
    await page.locator('#canonkeeper_recall').uncheck();
    await sleep(1000);
    log('[ui] Recall unticked; recursion off again; state store restored');

    // 5. A clip that fails: the writer is the roleplay endpoint, which
    // answers in prose, not JSON.
    await pickWriter(page, ROLEPLAY);
    x.clip.broken = { bookBefore: await bookText(bookName) };
    const t1 = Date.now();
    await command(page, `/canon-clip at=${CLIP_AT}`);
    const { rec: failed } = await waitForRecord(t1, 'broken clip', (s) => s?.clips?.at(-1), page);
    await idle(page);
    await sleep(2000);
    x.clip.broken.error = failed.ok ? null : failed.error;
    x.clip.broken.bookAfter = await bookText(bookName);
    log(`[server] lorebook file byte-identical after the failed clip: ${x.clip.broken.bookAfter === x.clip.broken.bookBefore}`);
    await shot(page, '03-clip-failed.png');
    x.clip.broken.prompt = await capture(page, 'after-broken-clip');
    log(`[check] prompt after the failed clip identical to recall off: ${same(x.clip.broken.prompt, x.recall.off)}`);

    // 6. A clip that works: highlight a sentence of message 48 and press the
    // scissors in its message actions.
    await pickWriter(page, WRITER);
    await page.evaluate(() => toastr.clear());
    await page.evaluate(() => document.getElementById('extensions-settings-button').querySelector('.drawer-toggle').click());
    await sleep(800);
    x.clip.working = { bookBefore: await bookText(bookName) };
    const selected = await page.evaluate(({ at, text }) => {
        const root = document.querySelector(`#chat .mes[mesid="${at}"] .mes_text`);
        root.scrollIntoView({ block: 'center' });
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const i = n.textContent.indexOf(text);
            if (i < 0) continue;
            const range = document.createRange();
            range.setStart(n, i);
            range.setEnd(n, i + text.length);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return sel.toString();
        }
        return null;
    }, { at: CLIP_AT, text: CLIP_TEXT });
    if (selected !== CLIP_TEXT) throw new Error(`could not highlight the passage in message ${CLIP_AT}`);
    await sleep(800);
    await shot(page, '04-highlighted.png');
    log(`[ui] highlighted in message ${CLIP_AT}: '${selected}'`);
    const t2 = Date.now();
    await page.hover(`#chat .mes[mesid="${CLIP_AT}"]`);
    await page.click(`#chat .mes[mesid="${CLIP_AT}"] .extraMesButtonsHint`);
    await sleep(800);
    await page.click(`#chat .mes[mesid="${CLIP_AT}"] .canonkeeper_clip`);
    log(`[ui] opened message ${CLIP_AT}'s actions and pressed the clip button`);
    const { rec: clipped } = await waitForRecord(t2, 'clip', (s) => s?.clips?.at(-1), page);
    if (!clipped.ok) throw new Error(`the clip failed: ${clipped.error}`);
    await sleep(2000);
    await shot(page, '05-clipped.png');
    x.clip.working.bookAfter = await bookText(bookName);
    const clipEntry = JSON.parse(x.clip.working.bookAfter).entries[clipped.uid];
    log(`[server] clip entry ${clipped.uid} '${clipEntry.comment}', keys ${JSON.stringify(clipEntry.key)}: ${clipEntry.content.replace(/\s+/g, ' ')}`);
    x.clip.working.firesInScan = chatLines.slice(-2).some((m) => clipEntry.key.some((k) => m.mes.toLowerCase().includes(k.toLowerCase())));
    x.clip.working.prompt = await capture(page, 'with-clip');
    log(`[check] a clip key is in the last two messages: ${x.clip.working.firesInScan}; clip in the prompt: ${JSON.stringify(x.clip.working.prompt).includes(JSON.stringify(clipEntry.content).slice(1, -1))}`);

    // 7. /canon after the clip: no write, the clip held.
    const t3 = Date.now();
    await command(page, '/canon');
    const { rec: again } = await waitForRecord(t3, '/canon after the clip', (s) => s?.lastRun, page);
    await idle(page);
    await sleep(2000);
    x.clip.working.canon = { ok: again.ok, plan: again.plan, held: again.held };
    x.clip.working.bookAfterCanon = await bookText(bookName);
    log(`[server] /canon after the clip: ${again.plan?.length ?? '?'} writes; held ${JSON.stringify(again.held)}; book file unchanged: ${x.clip.working.bookAfterCanon === x.clip.working.bookAfter}`);
    await openDrawer(page, 'extensions-settings-button');
    await page.locator('#canonkeeper_status').scrollIntoViewIfNeeded();
    await page.evaluate(() => document.querySelectorAll('#canonkeeper_status details').forEach((d) => (d.open = /^(Clips|Held)/.test(d.querySelector('summary').textContent))));
    await sleep(800);
    await shot(page, '06-status.png');
    await browser.close();

    save('extras.json', x);
    const gate = spawnSync('node', [path.join(REPO, 'harness/gate.js'), '--story', path.join(REPO, 'fixtures/story'), '--run', OUT, '--extras'], { encoding: 'utf8' });
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
