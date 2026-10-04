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
- keys: the exact strings the story uses for this entity: full name, short name, and any epithet or title used in place of the name. Every key must appear verbatim in the transcript. Never use a word that also refers to another entity (for example a rank or title that two characters share): a key shared by two entities is dropped from both.
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

export const UPDATE_GUIDE = `This story already has a lorebook. The passages below are whole scenes in which some messages are new or were edited since it was built; those are marked (changed). The other messages are unchanged and are there for context: what they establish is already in the lorebook. Report:
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
    const roster = known
        .map((e) => `- ${e.name}${e.keys.length ? ` (keys: ${e.keys.join('; ')})` : ''}${e.facts.map((f) => `\n  kept: ${f.text}`).join('')}`)
        .join('\n');
    const prior = previous.map((p) => `- ${p.name}: ${p.text} [${p.messages.join(', ')}]`).join('\n');
    const passages = windows
        .map(([from, to]) => `<passage from="${from}" to="${to}">\n${renderTranscript(messages.slice(from, to + 1), changed)}\n</passage>`)
        .join('\n\n');
    return {
        system: UPDATE_SYSTEM,
        user: `${FIELD_GUIDE}\n\n${UPDATE_GUIDE}\n\nReturn JSON in exactly this shape:\n${SHAPE}\n\nYour reply has room for about ${room} entities.\n\nThe whole transcript has ${messages.length} messages, ids 0 to ${messages.length - 1}.\n\n<known_entities>\n${roster || '(none)'}\n</known_entities>\n\n<previous_facts>\n${prior || '(none)'}\n</previous_facts>\n\n<passages>\n${passages}\n</passages>`,
    };
}
