// Reading a SillyTavern chat. The core works on plain message arrays; this is
// the only module that knows the JSONL file format.

/**
 * SillyTavern chat JSONL: line 1 is the chat header, every later line is one
 * message. Message ids are 0-based positions after the header.
 */
export function parseTranscript(jsonl) {
    const lines = jsonl.split('\n').filter((l) => l.trim());
    if (lines.length < 2) throw new Error('transcript has no messages');
    return lines.slice(1).map((line, id) => {
        const m = JSON.parse(line);
        if (typeof m.mes !== 'string') throw new Error(`message ${id} has no 'mes' text`);
        return { id, name: String(m.name ?? ''), isUser: !!m.is_user, text: m.mes };
    });
}
