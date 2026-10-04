// The one prompt. The model writes a small shape (six fields per entity, plus
// scene starts); code builds the lorebook from it. Anything the model could
// get wrong about SillyTavern's entry format, it never gets to write.

const RULES = `Rules:
- Use only what the transcript states. Never invent detail. If something is unclear, leave it out.
- One entry per real entity. If a character is first known by an epithet or title ("the cartographer") and later named, that is one entity under its name, with the epithet as a key. Never split one entity across two entries, and never merge two entities into one.
- Include an entity when the story would suffer from forgetting it: every named character who speaks or acts in a scene, however minor; every named place a scene is set in or that the plot turns on; important objects; named events and turning points the characters refer back to (a fire, a deal, a battle, an arrival), even when the story never gives them a formal name; groups and factions; and the plot threads the story keeps returning to (a prophecy, a mystery, a relationship, a council or reform), under the phrase the story uses for them. Skip unnamed passers-by.
- Return only the JSON object. No prose, no code fences.`;

export const SYSTEM = `You build a lorebook for a roleplay story. You read the whole transcript and report two things as JSON: where scenes start, and the entities the story needs to remember.\n\n${RULES}`;

export const UPDATE_SYSTEM = `You keep a roleplay story's lorebook up to date. You read the passages of the transcript that are new or have changed and report two things as JSON: where scenes start in them, and what they establish about the entities the story needs to remember.\n\n${RULES}`;

export const SHAPE = `{
  "scenes": [ { "start": <message id where the scene begins>, "title": "<short label>" } ],
  "entities": [
    {
      "name": "<the entity's fullest proper name as the story gives it>",
      "keys": ["<words the story uses to refer to it>"],
      "facts": [ { "text": "<one short third-person statement>", "messages": [<ids of the messages that establish it>] } ],
      "caseSensitive": <true|false>,
      "cascade": <true|false>,
      "throttle": <integer >= 0>
    }
  ]
}`;

export const FIELD_GUIDE = `Fields:
- scenes: every point where the story cuts to a new scene: a jump in time, or a jump to a different place or situation. The first scene starts at 0. Bracketed narrator headers such as "[Place · Scene · Day]" usually mark a new scene, but a scene can also change with no header at all ("The next morning..."), so read the prose. Continuous action is one scene even when the characters move from room to room or out of a building; only a cut starts a new one.
- name: the full name, e.g. "Captain Ada Marsh" -> "Ada Marsh".
- keys: the exact strings the story uses for this entity: full name, short name, and any epithet or title used in place of the name, never a pronoun. Every key must appear verbatim in the transcript. Never use a word that also refers to another entity (for example a rank or title that two characters share): a key shared by two entities is dropped from both.
- facts: what the story establishes about the entity, most important first, each citing the message ids it comes from. 1-5 facts of one short sentence each: be brief, so that every entity fits.
- caseSensitive: true when one of its keys is also an ordinary word the story uses in lowercase with another meaning (a person named after a bird or a colour), so only the capitalised form should trigger it.
- cascade: true when the entry's text should be allowed to trigger other entries it mentions. Use false only for broad entries that mention almost everything.
- throttle: messages to wait after the entry fires before it may fire again. 0 for nearly everything.`;

/**
 * One line per message: `#id Name: text`. Ids are what facts cite. Messages
 * in `changed` are marked, for an update.
 */
export function renderTranscript(messages, changed = new Set()) {
    return messages.map((m) => `#${m.id}${changed.has(m.id) ? ' (changed)' : ''} ${m.name}: ${m.text.replace(/\r\n?/g, '\n')}`).join('\n\n');
}

/** Rough reply cost of one entity, used to tell the model how much room it has. */
export const TOKENS_PER_ENTITY = 300;

export function buildPrompt(messages, outputTokens) {
    const room = Math.floor(outputTokens / TOKENS_PER_ENTITY);
    return {
        system: SYSTEM,
        user: `${FIELD_GUIDE}\n\nReturn JSON in exactly this shape:\n${SHAPE}\n\nYour reply has room for about ${room} entities. Use what the story needs and no more, but don't leave out a qualifying entity to save space.\n\nThe transcript has ${messages.length} messages, ids 0 to ${messages.length - 1}.\n\n<transcript>\n${renderTranscript(messages)}\n</transcript>`,
    };
}

export function retryPrompt(prompt, problem) {
    return {
        system: prompt.system,
        user: `${prompt.user}\n\nYour previous reply could not be used: ${problem}\nReply again with only the JSON object.`,
    };
}

export const PART_SYSTEM = `You build a lorebook for a roleplay story too long to read at once, so you read it in parts, in order. You read one part and report two things as JSON: where scenes start in it, and what it establishes about the entities the story needs to remember.\n\n${RULES}`;

/** A known entity, for a prompt: name, keys, and (unless `brief`) its facts. */
function rosterLine(e, brief) {
    const keys = e.keys.length ? ` (keys: ${e.keys.join('; ')})` : '';
    return `- ${e.name}${keys}${brief ? '' : e.facts.map((f) => `\n  kept: ${f.text}`).join('')}`;
}

export function renderRoster(known, { brief = false } = {}) {
    return known.map((e) => rosterLine(e, brief)).join('\n');
}

/**
 * The scene starts a part reports on: from its second message through the
 * first message of the next part. Whether a scene starts at a part's own
 * first message is decided by the part before it, which has read the scene
 * that leads up to it.
 */
export function sceneRange(from, to, count) {
    return [from + 1, Math.min(to + 1, count - 1)];
}

/**
 * One part of a chunked build. `known` is the ledger so far, `context` the
 * end of the previous part (shown, not reported on), `from`..`to` the part,
 * and message `to + 1`, if there is one, is shown as the next part's start.
 */
export function buildPartPrompt(messages, { part, from, to, context, known, brief, outputTokens }) {
    const room = Math.floor(outputTokens / TOKENS_PER_ENTITY);
    const ctx = context
        ? `<context from="${context[0]}" to="${context[1]}">\n${renderTranscript(messages.slice(context[0], context[1] + 1))}\n</context>\n\n`
        : '';
    const next = to + 1 < messages.length ? to + 1 : null;
    const after = next == null ? '' : `\n\n<next_part_starts>\n${renderTranscript([messages[next]])}\n</next_part_starts>`;
    const [s0, s1] = sceneRange(from, to, messages.length);
    const guide = `This is part ${part}: messages ${from} to ${to} of ${messages.length}. ${part > 1 ? '<known_entities> lists what the earlier parts found.' : 'It is the first part.'}${context ? ` Messages ${context[0]} to ${context[1]}, in <context>, end the previous part; they are there so you can follow the story across the cut, and were already read.` : ''}${next == null ? ' It is the last part.' : ` Message ${next}, in <next_part_starts>, begins the next part.`}
Report:
- scenes: scene starts among messages ${s0} to ${s1}.${next == null ? '' : ` Include ${next} only if the story cuts to a new scene there.`}
- entities: every entity messages ${from} to ${to} establish something about, known or new. For a known entity, use its name exactly as <known_entities> lists it, and add only what this part establishes that its kept facts don't already cover. One exception: when this part gives the proper name of an entity listed under an epithet or title ("the cartographer" turns out to be "Ines Vell"), report it under its proper name with the listed name among its keys.
- Every fact must cite messages from ${from} to ${to}. Report nothing from <context> or <next_part_starts> but scene starts.`;
    return {
        system: PART_SYSTEM,
        user: `${FIELD_GUIDE}\n\n${guide}\n\nReturn JSON in exactly this shape:\n${SHAPE}\n\nYour reply has room for about ${room} entities. Use what the story needs and no more, but don't leave out a qualifying entity to save space.\n\n<known_entities>\n${renderRoster(known, { brief }) || '(none yet)'}\n</known_entities>\n\n${ctx}<part from="${from}" to="${to}">\n${renderTranscript(messages.slice(from, to + 1))}\n</part>${after}`,
    };
}

export const RECONCILE_SYSTEM = `You check a lorebook built from a long roleplay story read in parts. Each part was read with only a list of what the earlier parts had found, so one real entity can be listed twice: under an epithet or title in an early part and its name in a later one ("the cartographer", then "Ines Vell"), or under two spellings of one name. You report those pairs as JSON.

Rules:
- Merge only when the listed facts and keys show it is the same entity. Two people who share a title or a family name are different entities. If unsure, leave them apart.
- Use the names exactly as listed. Keep the fullest proper name.
- Return only the JSON object. No prose, no code fences.`;

export const MERGE_SHAPE = `{ "merges": [ { "keep": "<listed name to keep>", "same": ["<other listed name for the same entity>"] } ] }`;

export function buildReconcilePrompt(entities, { brief = false } = {}) {
    const list = entities
        .map((e) => {
            const ids = e.facts.flatMap((f) => f.messages);
            return `${rosterLine(e, brief)}\n  messages ${Math.min(...ids)}-${Math.max(...ids)}`;
        })
        .join('\n');
    return {
        system: RECONCILE_SYSTEM,
        user: `Return JSON in exactly this shape:\n${MERGE_SHAPE}\n\nAn empty "merges" list is a fine answer.\n\n<entities>\n${list}\n</entities>`,
    };
}

export const UPDATE_GUIDE =`This story already has a lorebook. The passages below are whole scenes in which some messages are new or were edited since it was built; those are marked (changed). The other messages are unchanged and are there for context: what they establish is already in the lorebook. Report:
- scenes: scene starts inside the passages. Each passage begins a scene.
- entities: every entity listed in <previous_facts>, and every entity the changes establish something new about, known or new. For a known entity, use its name exactly as <known_entities> lists it.
- <previous_facts> are facts the lorebook took from messages that have since changed. They have been removed. Restate word for word, with its ids, each one the passages still support, and leave out any they no longer support.
- Beyond those, add a fact only for something a (changed) message establishes that the story would suffer from forgetting and that the entity's kept facts don't already cover. Every new fact must cite a (changed) message. Small details of the scene don't belong.
- A new entity follows the same rules as in a full build.`;

/**
 * The prompt for an incremental update: the changed passages (whole scenes),
 * the entities the book already knows with the facts they keep, and the
 * facts the passages used to support, so an unchanged fact comes back worded
 * as it was.
 */
export function buildUpdatePrompt(messages, windows, known, previous, changed, outputTokens) {
    const room = Math.floor(outputTokens / TOKENS_PER_ENTITY);
    const roster = renderRoster(known);
    const prior = previous.map((p) => `- ${p.name}: ${p.text} [${p.messages.join(', ')}]`).join('\n');
    const passages = windows
        .map(([from, to]) => `<passage from="${from}" to="${to}">\n${renderTranscript(messages.slice(from, to + 1), changed)}\n</passage>`)
        .join('\n\n');
    return {
        system: UPDATE_SYSTEM,
        user: `${FIELD_GUIDE}\n\n${UPDATE_GUIDE}\n\nReturn JSON in exactly this shape:\n${SHAPE}\n\nYour reply has room for about ${room} entities.\n\nThe whole transcript has ${messages.length} messages, ids 0 to ${messages.length - 1}.\n\n<known_entities>\n${roster || '(none)'}\n</known_entities>\n\n<previous_facts>\n${prior || '(none)'}\n</previous_facts>\n\n<passages>\n${passages}\n</passages>`,
    };
}
