#!/usr/bin/env node
// Scores a live-sim run made with --audit-model and --plant-at: did the live
// audit queue the planted collision at the first update after it, with no
// click, and did any claim go to the model twice?
//
//   node harness/live-audit-check.js <run dir> [<run dir> ...] [--json]
//
//   LA1  every successful update was audited
//   LA2  the planted collision is in the queue after the first update after
//        the plant (a 'steal' plant may instead be settled by /canon taking
//        the key off its own entry, with the human's entry left alone)
//   LA3  no claim line (entry, cited messages, text) was shown to the model twice
//   LA4  a dismissed planted finding stays dismissed in every later audit
//   LA5  the planted entries are never changed by an update

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function scoreRun(dir) {
    const live = readJson(join(dir, 'live.json'));
    const plant = existsSync(join(dir, 'plant.json')) ? readJson(join(dir, 'plant.json')) : null;
    const calls = existsSync(join(dir, 'audit-calls.json')) ? readJson(join(dir, 'audit-calls.json')) : [];
    const audit = existsSync(join(dir, 'audit.json')) ? readJson(join(dir, 'audit.json')) : null;
    const checks = [];
    const add = (id, ok, says) => checks.push({ id, ok, says });

    const updates = live.cycles.filter((c) => c.update?.ok);
    const failedUpdates = live.cycles.filter((c) => c.update && !c.update.ok);
    const unaudited = updates.filter((c) => !c.audit?.ok);
    add('LA1', updates.length > 0 && !unaudited.length, `${updates.length - unaudited.length}/${updates.length} updates audited${unaudited.length ? `; not: ${unaudited.map((c) => `#${c.messages} ${c.audit?.error ?? 'no audit'}`).join('; ')}` : ''}`);

    if (!plant || plant.at == null) add('LA2', false, 'nothing was planted (no book by the plant point)');
    else if (!plant.audits.length) add('LA2', false, `planted at ${plant.at}, but no update came after it`);
    else {
        const first = plant.audits[0];
        const settled = plant.how === 'steal' && !first.finding && first.victimKeeps === false && first.plantedIntact;
        add('LA2', !!first.finding || settled, `planted '${plant.how}' on '${plant.key}' at ${plant.at}; first audit after it at ${first.at}: ${first.finding ? 'queued' : settled ? '/canon took the key off its own entry' : 'NOT queued'}`);
    }

    // A claim check shows a fact with its own cites; a re-cite try shows it
    // with other messages. The sim tells them apart when it records the call.
    const seen = new Map();
    const rep = { verify: 0, recite: 0 };
    const repeated = [];
    for (const c of calls) {
        c.lines.forEach((l, i) => {
            const kind = c.kinds?.[i] ?? 'verify';
            if (seen.has(l)) {
                rep[kind]++;
                if (repeated.length < 4) repeated.push(`${kind}: ${l.slice(0, 110)} (at ${seen.get(l)} and ${c.at})`);
            } else seen.set(l, c.at);
        });
    }
    const shown = calls.reduce((n, c) => n + c.lines.length, 0);
    const reciteShown = calls.reduce((n, c) => n + (c.kinds ?? []).filter((k) => k === 'recite').length, 0);
    add('LA3', rep.verify + rep.recite === 0, `${shown} claim lines (${reciteShown} re-cite tries) in ${calls.length} calls; repeated: ${rep.verify} claim checks, ${rep.recite} re-cite tries${repeated.length ? `: ${repeated.join(' | ')}` : ''}`);

    if (plant?.dismissedAt) {
        const later = plant.audits.filter((a) => a.at > plant.dismissedAt);
        const bad = later.filter((a) => a.finding && !a.finding.dismissed);
        add('LA4', !bad.length, `dismissed at ${plant.dismissedAt}; ${later.length} later audit(s), ${bad.length} reopened it`);
    }
    if (plant?.audits?.length) {
        const touched = plant.audits.filter((a) => !a.plantedIntact);
        add('LA5', !touched.length, touched.length ? `planted entries changed by the update at ${touched.map((a) => a.at).join(', ')}` : 'planted entries untouched');
    }

    const open = (audit?.findings ?? []).filter((f) => !f.dismissed);
    const byCheck = {};
    for (const f of open) byCheck[f.check === 'claim' ? `claim:${f.verdict}` : f.check] = (byCheck[f.check === 'claim' ? `claim:${f.verdict}` : f.check] ?? 0) + 1;
    const auditMs = calls.reduce((n, c) => n + (c.ms ?? 0), 0);
    return {
        dir,
        ok: checks.every((c) => c.ok),
        checks,
        stats: {
            messages: live.messageCount,
            updates: updates.length,
            failedUpdates: failedUpdates.length,
            auditCalls: updates.reduce((n, c) => n + (c.audit?.calls ?? 0), 0),
            claimLines: shown,
            claimsAtEnd: audit?.claims ?? null,
            unchecked: audit?.unchecked?.length ?? 0,
            openFindings: byCheck,
            auditSeconds: Math.round(auditMs / 1000),
            perUpdate: updates.map((c) => ({ at: c.messages, checked: c.audit?.checked, reused: c.audit?.reused, calls: c.audit?.calls, findings: c.audit?.findings })),
        },
    };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
    const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const out = dirs.map(scoreRun);
    if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
    else {
        for (const r of out) {
            console.log(`${r.ok ? 'GREEN' : 'RED  '} ${r.dir}`);
            for (const c of r.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.says}`);
            console.log(`  stats: ${r.stats.updates} updates, ${r.stats.auditCalls} audit calls, ${r.stats.auditSeconds}s in audit calls, open ${JSON.stringify(r.stats.openFindings)}`);
        }
    }
    process.exit(out.every((r) => r.ok) ? 0 : 1);
}
