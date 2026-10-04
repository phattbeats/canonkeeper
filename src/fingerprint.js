// Identifies the exact text a run was built from. Any edit to any message
// changes it. Plain JS (no node:crypto) so the core also runs in the browser.

function hash53(str, seed) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export function fingerprint(messages) {
    const text = messages.map((m) => `${m.id}\u0000${m.name}\u0000${m.text}`).join('\u0001');
    return `${messages.length}:${hash53(text, 1)}${hash53(text, 2)}`;
}
