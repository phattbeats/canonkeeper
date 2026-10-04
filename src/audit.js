// The audit: is the book still sound, and does it still say only what the
// story says? Two passes.
//
//   1. The technical pass is plain code and makes no model call. It reads
//      every enabled entry in the book, Canonkeeper's or not. It finds a key
//      two entries claim, an entry with no keys, a key that fires on nearly
//      every message, probability and recursion settings that stop an entry
//      from firing, provenance that points nowhere, and an entry Canonkeeper
//      wrote that has been deleted.
//   2. Claim re-verification reads provenance. Each fact an entry carries
//      cites the messages it came from. A fact whose messages changed since
//      the book was written can't be checked until /canon runs. The others go
//      to the model with exactly the messages they cite, and come back
//      supported, unsupported or contradicted.
//
// The audit writes nothing. A finding that can be fixed carries its fix, and
// a fix is applied only when someone accepts it (accept()): that is the
// review queue. Every fix here changes something a human may want as it is
// (an entry they edited or deleted, or a fact the model wrote), so none of
// them lands on its own.

import { planBudget, estimateTokens } from './budget.js';
import { renderTranscript } from './prompt.js';
import { extractJson, ModelOutputError } from './parse.js';
import { fingerprint, hashOf } from './fingerprint.js';
import { entryKeyRegex } from './match.js';
import { MAX_FIRE_FRACTION } from './compile.js';
import { align } from './align.js';
import { heldEntries } from './plan.js';
import { ask } from './build.js';
import { update } from './update.js';

export const AUDIT_VERSION = 1;
/** Rough reply cost of one claim's verdict. */
const TOKENS_PER_VERDICT = 80;
/** Verification's own output cap: verdicts are short. */
const VERIFY_OUTPUT = 8000;

const fold = (s) => s.toLowerCase();
const keysOf = (e) => (Array.isArray(e.key) ? e.key : []).map((k) => String(k).trim()).filter(Boolean);
const title = (e) => e.comment || `entry ${e.uid}`;
const fires = (key, entry, text) => entryKeyRegex(key, entry).test(text);
const enabled = (book) => Object.values(book.entries ?? {}).filter((e) => !e.disable).sort((a, b) => a.uid - b.uid);

/** A claim's identity: its entry and its words. A verdict follows it across audits. */
export const claimId = (uid, text) => `${uid}:${hashOf(text).slice(0, 12)}`;

// ── 1. The technical pass ───────────────────────────────────────────────────

/**
 * Two claims on one key collide unless both entries are case-sensitive and
 * spell it differently (SillyTavern would tell them apart).
 */
function collisions(entries, pinned, owned) {
    const byKey = new Map(); // folded key -> [{ key, entry, cs }]
    for (const e of entries) {
        if (e.constant) continue; // keys don't decide when a constant entry fires
        for (const k of new Set(keysOf(e))) (byKey.get(fold(k)) ?? byKey.set(fold(k), []).get(fold(k))).push({ key: k, entry: e, cs: !!e.caseSensitive });
    }
    const out = [];
    for (const [folded, claims] of byKey) {
        const uids = new Set();
        for (let i = 0; i < claims.length; i++) {
            for (let j = i + 1; j < claims.length; j++) {
                const a = claims[i];
                const b = claims[j];
                if (a.entry.uid === b.entry.uid || (a.cs && b.cs && a.key !== b.key)) continue;
                uids.add(a.entry.uid).add(b.entry.uid);
            }
        }
        if (!uids.size) continue;
        const holders = entries.filter((e) => uids.has(e.uid));
        const key = claims[0].key;
        // Canonkeeper's own rule: a contested key belongs to no one, unless
        // an entry is pinned, and then the pin keeps it. /canon applies it to
        // the entries it owns. The others are a human's: dropping the key
        // from them is a fix to accept, and between two pins only a human
        // can choose.
        const pins = holders.filter((e) => pinned.has(e.uid)).length;
        const drop = holders.filter((e) => !pinned.has(e.uid) && !owned.has(e.uid));
        const mine = holders.length - pins - drop.length;
        const canon = mine && pins + drop.length <= 1;
        out.push({
            id: `collision:${folded}`,
            check: 'collision',
            severity: 'error',
            key,
            uids: holders.map((e) => e.uid),
            titles: holders.map(title),
            message: `'${key}' is a key of ${holders.length} entries (${holders.map((e) => `'${title(e)}'`).join(', ')}): whenever it comes up, all of them are injected${canon ? '. Run /canon: it takes the key off its own entries' : ''}`,
            fix: !canon && drop.length && pins <= 1
                ? { op: 'drop-key', key, uids: drop.map((e) => e.uid), says: `remove '${key}' from ${drop.map((e) => `'${title(e)}'`).join(' and ')}` }
                : null,
        });
    }
    return out;
}

/**
 * A bare title one entry claims ("Captain") also fires on every mention of
 * another entry's longer key ("Captain Hale"). Compile treats it as contested.
 */
function overlaps(entries) {
    const words = (k) => fold(k).split(/\s+/);
    const multi = entries.filter((e) => !e.constant).flatMap((e) => keysOf(e).filter((k) => words(k).length > 1 && !k.startsWith('/')).map((k) => ({ key: k, entry: e })));
    const out = [];
    for (const e of entries) {
        if (e.constant) continue;
        const own = new Set(words(e.comment ?? ''));
        for (const k of keysOf(e)) {
            if (words(k).length > 1 || own.has(fold(k)) || k.startsWith('/')) continue;
            const inside = multi.filter((m) => m.entry.uid !== e.uid && words(m.key).includes(fold(k)));
            if (!inside.length) continue;
            out.push({
                id: `overlap:${fold(k)}:${e.uid}`,
                check: 'overlap',
                severity: 'warning',
                key: k,
                uids: [e.uid, ...new Set(inside.map((m) => m.entry.uid))],
                message: `'${title(e)}' claims '${k}', which also fires on ${inside.map((m) => `'${m.key}' ('${title(m.entry)}')`).join(', ')}`,
                fix: null,
            });
        }
    }
    return out;
}

function noKeys(entries) {
    return entries
        .filter((e) => !e.constant && !keysOf(e).length)
        .map((e) => ({ id: `no-keys:${e.uid}`, check: 'no-keys', severity: 'error', uids: [e.uid], message: `'${title(e)}' has no keys, so it never fires`, fix: null }));
}

function overbroad(entries, messages, owned) {
    const most = Math.floor(messages.length * MAX_FIRE_FRACTION);
    const out = [];
    for (const e of entries) {
        if (e.constant) continue;
        for (const k of keysOf(e)) {
            const n = messages.filter((m) => fires(k, e, m.text)).length;
            if (n <= most) continue;
            out.push({
                id: `overbroad:${e.uid}:${fold(k)}`,
                check: 'overbroad',
                severity: 'error',
                key: k,
                uids: [e.uid],
                message: `'${title(e)}' key '${k}' fires on ${n} of ${messages.length} messages: it retrieves nothing in particular${owned.has(e.uid) ? '. Run /canon: it drops the key' : ''}`,
                fix: owned.has(e.uid) ? null : { op: 'drop-key', key: k, uids: [e.uid], says: `remove '${k}' from '${title(e)}'` },
            });
        }
    }
    return out;
}

/** SillyTavern rolls `probability` each time an entry would fire, when `useProbability` is on. */
function probability(entries) {
    const out = [];
    for (const e of entries) {
        if (e.useProbability === false || e.probability == null) continue;
        const p = Number(e.probability);
        const at = { id: `probability:${e.uid}`, check: 'probability', uids: [e.uid], fix: { op: 'set', uid: e.uid, fields: { probability: 100 }, says: `set '${title(e)}' to fire every time` } };
        if (!(p >= 0 && p <= 100)) out.push({ ...at, severity: 'error', message: `'${title(e)}' has probability ${JSON.stringify(e.probability)}, outside 0-100` });
        else if (p === 0) out.push({ ...at, severity: 'error', message: `'${title(e)}' has probability 0: it never fires` });
        else if (p < 100) out.push({ ...at, severity: 'warning', message: `'${title(e)}' fires only ${p}% of the times its keys come up` });
    }
    return out;
}

/**
 * `delayUntilRecursion` lets an entry fire only when another entry's text
 * triggers it. Then it needs an entry that allows recursion and mentions it,
 * and it must not also exclude recursion.
 */
function recursion(entries) {
    const out = [];
    for (const e of entries) {
        if (!e.delayUntilRecursion || e.constant) continue;
        const at = { id: `recursion:${e.uid}`, check: 'recursion', severity: 'error', uids: [e.uid], fix: { op: 'set', uid: e.uid, fields: { delayUntilRecursion: false }, says: `let '${title(e)}' fire on the chat itself` } };
        if (e.excludeRecursion) {
            out.push({ ...at, message: `'${title(e)}' waits for recursion and also excludes it: it never fires` });
            continue;
        }
        const feeders = entries.filter((o) => o.uid !== e.uid && !o.preventRecursion && keysOf(e).some((k) => fires(k, e, String(o.content ?? ''))));
        if (!feeders.length) out.push({ ...at, message: `'${title(e)}' waits for recursion, but no entry that allows recursion mentions its keys: it never fires` });
    }
    return out;
}

/** Canonkeeper's entries cite messages; the citations must exist and name the entry. */
function provenance(entries, messages, current) {
    const out = [];
    for (const e of entries) {
        if (!e.canonkeeper) continue;
        const sources = e.canonkeeper.sources;
        const at = { id: `provenance:${e.uid}`, check: 'provenance', severity: 'error', uids: [e.uid], fix: null };
        if (!Array.isArray(sources) || !sources.length) {
            out.push({ ...at, message: `'${title(e)}' cites no messages` });
            continue;
        }
        const bad = sources.filter((r) => !(Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[0] <= r[1] && r[1] < messages.length));
        if (bad.length) {
            out.push({ ...at, message: `'${title(e)}' cites messages that aren't in the chat: ${JSON.stringify(bad)}` });
            continue;
        }
        // Ids are only checked against the text when the book is up to date
        // with the chat: otherwise they may point at moved messages.
        if (!current) continue;
        const named = sources.some(([a, b]) => messages.slice(a, b + 1).some((m) => e.constant || keysOf(e).some((k) => fires(k, e, m.text))));
        if (!named) out.push({ ...at, message: `none of the messages '${title(e)}' cites mentions any of its keys` });
    }
    return out;
}

/**
 * Entries Canonkeeper wrote that are gone from the book. A run leaves a
 * deleted entry out (the ledger's `deleted`), so it stays deleted until
 * someone accepts its restore here.
 */
function deleted(book, ledger) {
    if (!ledger) return [];
    const names = new Map(ledger.entities.filter((e) => e.uid != null).map((e) => [String(e.uid), e.name]));
    const gone = new Map(Object.entries(ledger.deleted ?? {}));
    for (const uid of Object.keys(ledger.written ?? {})) if (!(uid in book.entries)) gone.set(uid, names.get(uid) ?? `entry ${uid}`);
    return [...gone]
        .filter(([uid]) => !(uid in book.entries))
        .map(([uid, name]) => ({
            id: `deleted:${uid}`,
            check: 'deleted',
            severity: 'warning',
            uids: [Number(uid)],
            titles: [name],
            message: `'${name}' (uid ${uid}) was written by Canonkeeper and has been deleted from the book. /canon leaves it out; restore it if that was a mistake`,
            fix: { op: 'restore', uid: Number(uid), name, says: `restore '${name}'` },
        }));
}

/** Entities the story has that never got an entry: no usable key was left. */
function missing(ledger) {
    if (!ledger) return [];
    return ledger.entities
        .filter((e) => e.uid == null)
        .map((e) => ({ id: `missing:${fold(e.name)}`, check: 'missing', severity: 'warning', uids: [], titles: [e.name], message: `'${e.name}' is in the story but has no entry: ${(e.compiled?.dropped ?? []).map((d) => `'${d.key}' ${d.reason}`).join('; ') || 'no usable key'}`, fix: null }));
}

/**
 * The deterministic pass. `ledger` may be null (a book with no Canonkeeper
 * history): then deleted entries can't be told from ones never written.
 */
export function technicalPass({ book, ledger = null, messages }) {
    const entries = enabled(book);
    const pinned = new Set(entries.filter((e) => e.canonkeeper?.pinned).map((e) => e.uid));
    // Entries Canonkeeper wrote and nobody has touched since: /canon keeps
    // these right itself.
    const held = new Set(heldEntries(book, ledger?.written ?? {}).map((h) => h.entry.uid));
    const owned = new Set(entries.filter((e) => !held.has(e.uid)).map((e) => e.uid));
    const current = !ledger || ledger.fingerprint === fingerprint(messages);
    return [
        ...collisions(entries, pinned, owned),
        ...overlaps(entries),
        ...noKeys(entries),
        ...overbroad(entries, messages, owned),
        ...probability(entries),
        ...recursion(entries),
        ...provenance(entries, messages, current),
        ...deleted(book, ledger),
        ...missing(ledger),
    ];
}

// ── 2. Claim re-verification ────────────────────────────────────────────────

/**
 * Every fact the book's Canonkeeper entries carry, with the messages it
 * cites in today's ids. A fact citing a message that changed or went since
 * the ledger was written is `stale`: only /canon can bring it up to date.
 */
export function claimsOf({ book, ledger = null, messages }) {
    let toNow = (id) => (id >= 0 && id < messages.length ? id : null);
    if (ledger && ledger.fingerprint !== fingerprint(messages)) {
        const { toNew } = align(ledger.hashes, messages);
        toNow = (id) => toNew[id] ?? null;
    }
    const claims = [];
    const stale = [];
    for (const e of enabled(book)) {
        for (const f of e.canonkeeper?.facts ?? []) {
            const cited = (f.sources ?? []).flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
            const ids = cited.map(toNow);
            const claim = { id: claimId(e.uid, f.text), uid: e.uid, title: title(e), text: f.text, cited };
            if (!ids.length || ids.some((id) => id == null)) stale.push(claim);
            else claims.push({ ...claim, ids });
        }
    }
    return { claims, stale };
}

export const VERIFY_SYSTEM = `You check a lorebook against the roleplay story it was built from. Each claim in the lorebook cites the messages it was taken from. You judge each claim against its cited messages only, and report as JSON.

Verdicts:
- "supported": the cited messages state it, or it follows plainly from them. A paraphrase, a summary, or a fair reading of who "they" or "she" refers to is supported.
- "unsupported": it adds something the cited messages don't contain: a detail, a name, a cause. It may be true elsewhere in the story, but these messages don't establish it.
- "contradicted": the cited messages say the opposite. Something they merely leave out is unsupported, not contradicted.

Judge what the claim says, not how it is worded. Return only the JSON object. No prose, no code fences.`;

export const VERDICT_SHAPE = `{ "claims": [ { "id": "<claim id>", "why": "<in a sentence: what the cited messages say about it; quote the story in 'single quotes', never double>", "verdict": "supported" | "unsupported" | "contradicted" } ] }`;

export function buildVerifyPrompt(messages, claims) {
    const ids = [...new Set(claims.flatMap((c) => c.ids))].sort((a, b) => a - b);
    const list = claims.map((c, i) => `C${i + 1} · ${c.title} · cites ${c.ids.map((id) => `#${id}`).join(', ')}: ${c.text}`).join('\n');
    return {
        system: VERIFY_SYSTEM,
        user: `Judge every claim, each against only the messages it cites. Say what the messages say first, then give the verdict that follows from it. Return JSON in exactly this shape:\n${VERDICT_SHAPE}\n\n<messages>\n${renderTranscript(ids.map((id) => messages[id]))}\n</messages>\n\n<claims>\n${list}\n</claims>`,
    };
}

const VERDICTS = new Set(['supported', 'unsupported', 'contradicted']);

/**
 * Reads the verdicts for `count` claims (C1..Ccount). Strict JSON. A claim
 * with no usable verdict stays unchecked: nothing is assumed either way.
 */
export function readVerdicts(text, count) {
    const data = extractJson(text);
    if (!data || !Array.isArray(data.claims)) throw new ModelOutputError("reply needs a 'claims' array");
    const out = new Map();
    for (const c of data.claims) {
        const n = /^C(\d+)$/.exec(String(c?.id ?? '').trim())?.[1];
        const i = n ? Number(n) - 1 : -1;
        if (i < 0 || i >= count || out.has(i) || !VERDICTS.has(c.verdict)) continue;
        out.set(i, { verdict: c.verdict, why: typeof c.why === 'string' ? c.why.trim() : '' });
    }
    return out;
}

/**
 * Groups claims, an entry's claims together, into calls that fit the
 * window. An entry whose claims don't fit even alone is left unchecked.
 */
export function batches(messages, claims, budget) {
    const byEntry = [];
    for (const c of claims) {
        const last = byEntry[byEntry.length - 1];
        if (last && last[0].uid === c.uid) last.push(c);
        else byEntry.push([c]);
    }
    const fits = (cs) => estimateTokens(Object.values(buildVerifyPrompt(messages, cs)).join('')) <= budget.input && cs.length * TOKENS_PER_VERDICT <= budget.output;
    const out = [];
    const tooBig = [];
    let cur = [];
    for (const group of byEntry) {
        if (!fits(group)) {
            tooBig.push(...group);
            continue;
        }
        if (cur.length && !fits([...cur, ...group])) {
            out.push(cur);
            cur = [];
        }
        cur.push(...group);
    }
    if (cur.length) out.push(cur);
    return { batches: out, tooBig };
}

/**
 * Asks the model about every claim. Returns { verdicts, unchecked, calls }:
 * `verdicts` maps a claim id to { verdict, why }. A batch whose reply is
 * unusable after one retry leaves its claims unchecked; the audit goes on.
 */
export async function verifyClaims({ messages, claims, generate, contextTokens, maxOutputTokens = VERIFY_OUTPUT }) {
    const budget = planBudget({ contextTokens, maxOutputTokens: Math.min(maxOutputTokens, VERIFY_OUTPUT) });
    const { batches: groups, tooBig } = batches(messages, claims, budget);
    const verdicts = {};
    const unchecked = tooBig.map((c) => ({ id: c.id, reason: 'its cited messages do not fit the window' }));
    let calls = 0;
    const counted = (req) => (calls++, generate(req));
    for (const group of groups) {
        let got;
        try {
            got = await ask(counted, buildVerifyPrompt(messages, group), budget.output, messages.length, (text) => readVerdicts(text, group.length));
        } catch (err) {
            if (!(err instanceof ModelOutputError)) throw err;
            unchecked.push(...group.map((c) => ({ id: c.id, reason: `no usable reply: ${err.message}` })));
            continue;
        }
        group.forEach((c, i) => {
            if (got.has(i)) verdicts[c.id] = got.get(i);
            else unchecked.push({ id: c.id, reason: 'the reply gave no verdict' });
        });
    }
    return { verdicts, unchecked, calls };
}

/** Findings from claim verdicts. Only a fact in an entry Canonkeeper still owns can be dropped. */
function claimFindings(claims, stale, verdicts, held) {
    const out = [];
    for (const c of claims) {
        const v = verdicts[c.id];
        if (!v || v.verdict === 'supported') continue;
        const why = held.get(c.uid);
        out.push({
            id: `claim:${c.id}`,
            check: 'claim',
            severity: v.verdict === 'contradicted' ? 'error' : 'warning',
            uids: [c.uid],
            titles: [c.title],
            claim: c.text,
            cites: c.ids,
            verdict: v.verdict,
            message: `'${c.title}': "${c.text}" is ${v.verdict} by the messages it cites (${c.ids.map((id) => `#${id}`).join(', ')})${v.why ? `. ${v.why}` : ''}`,
            fix: why ? null : { op: 'drop-fact', uid: c.uid, text: c.text, says: `drop this fact from '${c.title}'` },
            ...(why ? { held: why } : {}),
        });
    }
    if (stale.length) {
        out.push({
            id: 'stale',
            check: 'stale',
            severity: 'warning',
            uids: [...new Set(stale.map((c) => c.uid))],
            message: `${stale.length} fact${stale.length === 1 ? '' : 's'} cite${stale.length === 1 ? 's' : ''} messages that changed since the book was brought up to date: run /canon, then audit again`,
            fix: null,
        });
    }
    return out;
}

// ── The audit ───────────────────────────────────────────────────────────────

/**
 * Audits `book` against `messages`. With `generate`, claims are re-verified
 * by the model; without it, verdicts from `previous` (an earlier audit of the
 * same chat) carry over for claims that haven't changed, and the rest stay
 * unchecked. Findings a human dismissed in `previous` stay dismissed.
 *
 * Returns the audit record: { version, at, fingerprint, bookHash, findings,
 * claims: { total, checked, stale, unchecked }, verdicts, calls, dismissed }.
 */
export async function audit({ book, ledger = null, messages, generate = null, contextTokens, maxOutputTokens, previous = null, now = new Date() }) {
    if (!messages.length) throw new Error('empty transcript');
    const technical = technicalPass({ book, ledger, messages });
    const { claims, stale } = claimsOf({ book, ledger, messages });
    const live = new Set(claims.map((c) => c.id));
    let verdicts = Object.fromEntries(Object.entries(previous?.verdicts ?? {}).filter(([id]) => live.has(id)));
    let unchecked = [];
    let calls = 0;
    if (generate) {
        const out = await verifyClaims({ messages, claims, generate, contextTokens, maxOutputTokens });
        ({ verdicts, unchecked, calls } = out);
    } else unchecked = claims.filter((c) => !verdicts[c.id]).map((c) => ({ id: c.id, reason: 'not verified in this audit' }));
    const held = new Map(heldEntries(book, ledger?.written ?? {}).map((h) => [h.entry.uid, h.reason]));
    const dismissed = (previous?.dismissed ?? []).filter((id) => typeof id === 'string');
    const findings = [...technical, ...claimFindings(claims, stale, verdicts, held)].map((f) => (dismissed.includes(f.id) ? { ...f, dismissed: true } : f));
    return {
        version: AUDIT_VERSION,
        at: now.toISOString(),
        fingerprint: fingerprint(messages),
        bookHash: hashOf(book.entries ?? {}),
        findings,
        claims: { total: claims.length + stale.length, checked: Object.keys(verdicts).length, stale: stale.length, unchecked: unchecked.length },
        verdicts,
        unchecked,
        calls,
        dismissed,
    };
}

/** Open findings: not dismissed. */
export const openFindings = (record) => record.findings.filter((f) => !f.dismissed);

/** One line per finding, for the CLI and the status view. */
export function describeFinding(f) {
    return `${f.severity === 'error' ? 'ERROR' : 'warn '} ${f.check}: ${f.message}${f.fix ? ` [fix: ${f.fix.says}]` : ''}${f.held ? ` [held: ${f.held}]` : ''}${f.dismissed ? ' [dismissed]' : ''}`;
}

// ── The review queue: accepting a fix ───────────────────────────────────────

export class StaleAuditError extends Error {}

const noModel = async () => {
    throw new Error('accepting a fix makes no model call');
};

/**
 * Applies one finding's fix. The audit must be of this book and this chat as
 * they are now, or nothing is applied (audit again).
 *
 *   drop-key, set   edit the named entries in the book, as a human would in
 *                   the World Info editor. An entry Canonkeeper wrote is then
 *                   edited by hand, and held from then on.
 *   restore         takes the entry off the ledger's deleted list; the
 *                   ledger's canon brings it back on its old uid.
 *   drop-fact       takes the fact out of the ledger's canon (an entity left
 *                   with none goes), and the entry is compiled again.
 *
 * The last two go through update(), with no model call, so keys stay unique
 * across the book. Returns { book, ledger, writes }: `writes` describes each
 * entry written, and `ledger` is unchanged for a book edit.
 */
export async function accept({ book, ledger, messages, record, id }) {
    const f = record.findings.find((x) => x.id === id);
    if (!f) throw new Error(`no finding '${id}' in the audit`);
    if (!f.fix) throw new Error(`finding '${id}' has no fix to accept`);
    if (record.fingerprint !== fingerprint(messages) || record.bookHash !== hashOf(book.entries ?? {})) {
        throw new StaleAuditError('the chat or the book changed since the audit: audit again before accepting a fix');
    }
    const fix = f.fix;
    if (fix.op === 'drop-key' || fix.op === 'set') {
        const out = structuredClone(book);
        const writes = [];
        for (const uid of fix.op === 'set' ? [fix.uid] : fix.uids) {
            const e = out.entries[String(uid)];
            if (!e) throw new Error(`uid ${uid} is not in the book`);
            if (fix.op === 'set') Object.assign(e, structuredClone(fix.fields));
            else e.key = (e.key ?? []).filter((k) => fold(String(k).trim()) !== fold(fix.key));
            writes.push(`update ${uid} '${title(e)}' (${fix.op === 'set' ? Object.keys(fix.fields).join(', ') : 'key'})`);
        }
        return { book: out, ledger, writes };
    }
    if (!ledger) throw new Error('this fix needs the ledger');
    if (ledger.fingerprint !== fingerprint(messages)) throw new StaleAuditError('the book is behind the chat: run /canon first');
    const next = structuredClone(ledger);
    if (fix.op === 'restore') {
        if (!next.entities.some((e) => e.uid === fix.uid)) throw new Error(`the story no longer has '${fix.name}': nothing to restore`);
        delete next.deleted?.[String(fix.uid)];
        // An entry deleted since the last run is still in `written`; it goes
        // too, so the restored entry isn't taken for a fresh deletion.
        delete next.written[String(fix.uid)];
    } else if (fix.op === 'drop-fact') {
        const e = next.entities.find((x) => x.uid === fix.uid);
        const at = e?.facts.findIndex((x) => fold(x.text) === fold(fix.text)) ?? -1;
        if (at < 0) throw new Error(`the ledger has no such fact for uid ${fix.uid}`);
        e.facts.splice(at, 1);
        if (!e.facts.length) next.entities = next.entities.filter((x) => x !== e);
    } else throw new Error(`unknown fix '${fix.op}'`);
    const out = await update({ book, ledger: next, messages, generate: noModel, contextTokens: ledger.budget?.contextTokens ?? 200000 });
    return { book: out.book, ledger: out.ledger, writes: out.plan.map((o) => `${o.op} ${o.uid} '${o.title}'${o.fields ? ` (${o.fields.join(', ')})` : ''}`) };
}

/** Marks a finding dismissed. It stays listed, and stays dismissed in later audits. */
export function dismiss(record, id) {
    if (!record.findings.some((f) => f.id === id)) throw new Error(`no finding '${id}' in the audit`);
    return {
        ...record,
        dismissed: [...new Set([...record.dismissed, id])],
        findings: record.findings.map((f) => (f.id === id ? { ...f, dismissed: true } : f)),
    };
}
