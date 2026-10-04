// The one prompt. The model writes a small shape (six fields per entity, plus
// scene starts); code builds the lorebook from it. Anything the model could
// get wrong about SillyTavern's entry format, it never gets to write.

export const SYSTEM = `You build a lorebook for a roleplay story. You read the whole transcript and report two things as JSON: where scenes start, and the entities the story needs to remember.

Rules:
- Use only what the transcript states. Never invent detail. If something is unclear, leave it out.
- One entry per real entity. If a character is first known by an epithet or title ("the cartographer") and later named, that is one entity under its name, with the epithet as a key. Never split one entity across two entries, and never merge two entities into one.
- Include an entity when the story would suffer from forgetting it: characters with a role in the plot, every named place a scene is set in or that the plot turns on, important objects, named events the characters refer back to (a fire, a deal, a battle), and groups or factions. Skip passers-by who do nothing.
- Return only the JSON object. No prose, no code fences.`;

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
- facts: what the story establishes about the entity, most important first, each citing the message ids it comes from. 2-8 facts.
- caseSensitive: true when one of its keys is also an ordinary word the story uses in lowercase with another meaning (a person named after a bird or a colour), so only the capitalised form should trigger it.
- cascade: true when the entry's text should be allowed to trigger other entries it mentions. Use false only for broad entries that mention almost everything.
- throttle: messages to wait after the entry fires before it may fire again. 0 for nearly everything.`;

/** One line per message: `#id Name: text`. Ids are what facts cite. */
export function renderTranscript(messages) {
    return messages.map((m) => `#${m.id} ${m.name}: ${m.text.replace(/\r\n?/g, '\n')}`).join('\n\n');
}

export function buildPrompt(messages) {
    return {
        system: SYSTEM,
        user: `${FIELD_GUIDE}\n\nReturn JSON in exactly this shape:\n${SHAPE}\n\nThe transcript has ${messages.length} messages, ids 0 to ${messages.length - 1}.\n\n<transcript>\n${renderTranscript(messages)}\n</transcript>`,
    };
}

export function retryPrompt(prompt, problem) {
    return {
        system: prompt.system,
        user: `${prompt.user}\n\nYour previous reply could not be used: ${problem}\nReply again with only the JSON object.`,
    };
}
