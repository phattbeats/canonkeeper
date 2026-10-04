// Lining up the transcript a ledger was built from with the transcript now.
//
// SillyTavern message ids are positions, so one message inserted or deleted
// early on shifts every id after it. Matching messages by content hash, not
// by id, keeps every untouched message (and every fact that cites it) intact
// and leaves only the messages that really changed.

import { messageHash } from './fingerprint.js';

/**
 * `oldHashes` are the message hashes the ledger recorded. Returns
 * { toNew, fresh, dirty }:
 *   toNew  old id -> new id, or null for a message that is gone or changed
 *   fresh  new ids with no unchanged counterpart (edited or added)
 *   dirty  fresh ids plus, for a deletion, the message now in its place
 */
export function align(oldHashes, messages) {
    const now = messages.map(messageHash);
    const n = oldHashes.length;
    const m = now.length;
    const toNew = new Array(n).fill(null);

    // Common prefix and suffix first: an edit or an append leaves almost
    // everything here, and the quadratic part below only sees the rest.
    let head = 0;
    while (head < n && head < m && oldHashes[head] === now[head]) toNew[head] = head++;
    let tail = 0;
    while (tail < n - head && tail < m - head && oldHashes[n - 1 - tail] === now[m - 1 - tail]) {
        toNew[n - 1 - tail] = m - 1 - tail;
        tail++;
    }

    // Longest common subsequence of the middle.
    const a = oldHashes.slice(head, n - tail);
    const b = now.slice(head, m - tail);
    const w = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
        }
    }
    for (let i = 0, j = 0; i < a.length && j < b.length; ) {
        if (a[i] === b[j]) toNew[head + i++] = head + j++;
        else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++;
        else j++;
    }

    const kept = new Set(toNew.filter((x) => x != null));
    const fresh = messages.map((msg) => msg.id).filter((id) => !kept.has(id));
    const dirty = new Set(fresh);
    toNew.forEach((x, i) => {
        if (x != null) return;
        const before = toNew.slice(0, i).reverse().find((y) => y != null) ?? -1;
        const after = toNew.slice(i + 1).find((y) => y != null) ?? m;
        // Replaced by something new in the same place: that's an edit, and
        // the new message is already dirty. Otherwise it was deleted, which
        // dirties the message now in its place (its scene).
        if (fresh.some((id) => id > before && id < after)) return;
        if (after < m) dirty.add(after);
        else if (before >= 0) dirty.add(before);
    });
    return { toNew, fresh, dirty: [...dirty].sort((p, q) => p - q) };
}
