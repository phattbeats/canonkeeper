// The one prompt. The model writes a small shape (six fields per entity, plus
// scene starts); code builds the lorebook from it. Anything the model could
// get wrong about SillyTavern's entry format, it never gets to write.

const RULES = `Rules:
- Use only what the transcript states. Never invent detail. If something is unclear, leave it out.
- One entry per real entity. If a character is first known by an epithet or title ("the cartographer") and later named, that is one entity under its name, with the epithet as a key. Never split one entity across two entries, and never merge two entities into one.
- Include an entity when the story would suffer from forgetting it: every named character who speaks or acts in a scene, however minor; every named place a scene is set in or that the plot turns on, including the town or city the story is set in and any place a narrator header names; important objects; named events and turning points the characters refer back to (a fire, a deal, a battle, an arrival), even when the story never gives them a formal name; groups and factions; and the plot threads the story keeps returning to (a prophecy, a mystery, a relationship, a council or reform), under the phrase the story uses for them. Skip unnamed passers-by.
- Return only the JSON object. No prose, no code fences.`;

export const SYSTEM = `You build a lorebook for a roleplay story. You read the whole transcript and report two things as JSON: where scenes start, and the entities the story needs to remember.\n\n${RULES}`;

export const UPDATE_SYSTEM = `You keep a roleplay story's lorebook up to date. You read the passages of the transcript that are new or have changed and report two things as JSON: where scenes start in them, and what they establish about the entities the story needs to remember.\n\n${RULES}`;

export const SHAPE = `{
  "entities": [
    {
      "name": "<the entity's fullest proper name as the story gives it>",
      "keys": ["<words the story uses to refer to it>"],
      "main": <true for a main character, else false>,
      "facts": [ { "text": "<a third-person statement>", "section": "appearance" | "personality" | "voice" | "relationships" | "history", "messages": [<ids of the messages that establish it>] } ],
      "quotes": [ { "text": "<words copied exactly from one message>", "speaker": "<who said it>", "message": <id of that message> } ],
      "caseSensitive": <true|false>,
      "cascade": <true|false>,
      "throttle": <integer >= 0>
    }
  ],
  "scenes": [
    {
      "cut": "<what the story skips here>",
      "start": <message id where the scene begins>,
      "title": "<short label>",
      "when": "<when it happens, as the story says it>",
      "where": "<where it happens>",
      "who": ["<names of those in it>"],
      "line": "<one line: what happened>",
      "keys": ["<words distinctive to this scene: its place, event or object>"],
      "facts": [ { "text": "<what happened, and why it matters>", "section": "what" | "why", "messages": [<ids>] } ],
      "quotes": [ { "text": "<words copied exactly from one message>", "speaker": "<who said it>", "message": <id of that message> } ]
    }
  ]
}`;

export const FIELD_GUIDE = `Fields:
- scenes: every point where the story cuts to a new scene (the first scene starts at 0; give it too, with its details): a jump in time, or a jump to a different place or situation. Bracketed narrator headers such as "[Place · Scene · Day]" usually mark a new scene, but a scene can also change with no header at all ("The next morning..."), so read the prose. A message that picks up where the previous one left off (the same people carrying on what they were doing, with no time skipped) continues the scene, even when they move somewhere else: room to room, out of a building, down a tunnel, onto a boat. Only a cut starts a new one. For each scene after the first, first say in cut what the story skips there: time that passes unseen, a jump to a place the characters aren't shown travelling to, a switch to other people, or a narrator header that opens a new scene. If you can't name one, it isn't a new scene; leave it out.
- A scene also becomes an entry of its own. For every scene give when, where, who, and line (one line on what happened); facts saying what happened and, in section "why", why it matters to the story; 1-3 quotes (the lines that capture the scene: every scene where anyone speaks has them); and 2-4 keys. A scene's keys are what is distinctive to that scene: its place, the event, an object that matters in it. Never use the main characters' names as a scene's keys, since they are in nearly every scene. Cite the messages of the scene.
- name: the full name, e.g. "Captain Ada Marsh" -> "Ada Marsh".
- keys: the exact strings the story uses for this entity. Give distinct triggers: the name, nicknames and short forms, titles and role nouns the story actually uses for it ("the witch", "mistress", "apprentice"), never a pronoun. A longer form of a key you already give ("Morgana Veni" beside "Morgana") adds no trigger: leave it out. A key names the entity itself, never something of its ("the captain's cabin" is a place, not a key for the captain). Every key must appear verbatim in the transcript. Never use a word that also refers to another entity (for example a rank or title that two characters share): a key shared by two entities is dropped from both.
- main: true for a main character: one the story follows through many scenes. Everyone else is false.
- facts: what the story establishes about the entity, most important first, each citing the message ids it comes from. How much to write scales with how much the story gives the entity:
  - a main character gets a full profile: at least 1,000 characters even in a short story (aim for 1,500 to 2,500), more once the story gives the material, growing as scenes pile up. Count: the facts of a main character's profile add up to well over a thousand characters, and are never a few lines. One fact per section is too thin: give each section the story supports two to five facts, each a full sentence with the concrete detail (what was said or done, where, with whom), not a summary. Tag each fact with a section: "appearance" (looks, dress, manner), "personality" (how they think and act), "voice" (how they speak: habits, phrasing), "relationships" (one fact per person that matters to them: what they are to each other and how it has changed), "history" (what has happened to them, in story order, with where and when). Facts here may run to two or three sentences, and a profile has many of them.
  - a character who recurs but isn't a main character gets 3-6 facts; a place, object, group or event gets 2-5 facts, longer if the story keeps returning to it. A passing minor character gets one or two short facts.
- quotes: a main character always has 2-4 lines that show how they talk (never none); for others, one quote only where a line matters. Copy the words exactly as they appear in the message, character for character, with the id of that message. A quote that is not word for word in the message it cites is thrown away, so never paraphrase or tidy one. Quote a whole sentence or more of speech (at least two words), never a fragment, and choose lines that show the character: how they bargain, threaten, joke or give way.
- caseSensitive: true when one of its keys is also an ordinary word the story uses in lowercase with another meaning (a person named after a bird or a colour), so only the capitalised form should trigger it.
- cascade: true when the entry's text should be allowed to trigger other entries it mentions. Use false only for broad entries that mention almost everything.
- throttle: messages to wait after the entry fires before it may fire again. 0 for nearly everything.`;

// The two-step build (src/deepen.js): the first call is about breadth, the
// roster of every entity and every scene, each with a few short facts; later
// calls, each about a few mains or scenes, write the depth. Depth and breadth
// compete for one reply, and breadth lost.

const ENTITY_SHAPE = `{
      "name": "<the entity's fullest proper name as the story gives it>",
      "keys": ["<words the story uses to refer to it>"],
      "main": <true for a main character, else false>,
      "facts": [ { "text": "<a third-person statement>", "section": "appearance" | "personality" | "voice" | "relationships" | "history", "messages": [<ids of the messages that establish it>] } ],
      "caseSensitive": <true|false>,
      "cascade": <true|false>,
      "throttle": <integer >= 0>
    }`;

const SCENE_SHAPE = `{
      "cut": "<what the story skips here>",
      "start": <message id where the scene begins>,
      "title": "<short label>",
      "when": "<when it happens, as the story says it>",
      "where": "<where it happens>",
      "who": ["<names of those in it>"],
      "line": "<one line: what happened>",
      "keys": ["<words distinctive to this scene: its place, event or object>"],
      "facts": [ { "text": "<what happened>", "section": "what", "messages": [<ids>] } ]
    }`;

/** The breadth call (roster and scenes), and the shape the sweeps and the roster use. */
export const SHAPE_BOTH = `{\n  "entities": [\n    ${ENTITY_SHAPE}\n  ],\n  "scenes": [\n    ${SCENE_SHAPE}\n  ]\n}`;
export const SHAPE_ROSTER = `{\n  "entities": [\n    ${ENTITY_SHAPE}\n  ],\n  "scenes": []\n}`;

const cutRule = FIELD_GUIDE.slice(FIELD_GUIDE.indexOf('- scenes:'), FIELD_GUIDE.indexOf('- A scene also becomes'));
const keysRule = FIELD_GUIDE.slice(FIELD_GUIDE.indexOf('- name:'), FIELD_GUIDE.indexOf('- facts:'));
const flagRules = FIELD_GUIDE.slice(FIELD_GUIDE.indexOf('- caseSensitive:'));

const sceneEntryRule = `- A scene also becomes an entry of its own. For every scene give when, where, who, and line (one line on what happened); one fact saying what happened (section "what"); and 2-4 keys. A scene's keys are what is distinctive to that scene: its place, the event, an object that matters in it. Never use the main characters' names as a scene's keys, since they are in nearly every scene. Cite the messages of the scene.\n`;

export const ROSTER_GUIDE = `Fields:
${keysRule}- facts: what the story establishes about the entity, most important first, each citing the message ids it comes from. This step is about coverage, so keep it short: a main character gets 3-5 facts, a character who recurs 2-4, a place, object, group, event or thread 1-3, a passing minor character one. A fact is a full sentence with the concrete detail. Tag each fact with a section: "appearance", "personality", "voice", "relationships", "history". A later step writes the main characters' full profiles in full, with quotes, so don't try to here: spend the reply on finding every entity.
${flagRules}`;

/**
 * One line per message: `#id Name: text`. Ids are what facts cite. Messages
 * in `changed` are marked, for an update.
 */
export function renderTranscript(messages, changed = new Set()) {
    return messages.map((m) => `#${m.id}${changed.has(m.id) ? ' (changed)' : ''} ${m.name}: ${m.text.replace(/\r\n?/g, '\n')}`).join('\n\n');
}

/** Rough reply cost of one entity, used to tell the model how much room it has. */
export const TOKENS_PER_ENTITY = 300;

const ROOM = (room) => `Your reply has room for about ${room} ordinary entities; a main character's profile and a scene entry each take several. Depth is in addition to breadth, never instead of it: every entity the rules call for (every named character, place, object, event, group and thread) still gets an entry, besides the main characters' profiles and a scene entry for every scene. A long story has dozens of entities. List all the entities first, then the scenes. Don't leave out a qualifying entity or shorten a profile to save space.`;

const ROOM_SCENES_RULE = 'Be strict about cuts: a scene is usually many messages long (a story of ordinary messages has about one scene per eight to fifteen of them; far more means you are splitting beats, not scenes), so most messages continue the scene before them. Check each cut again before you list it: if the people carry on from the message before, drop it.';

const ROOM_BREADTH = (room) => `Your reply has room for about ${room} entities. A long story has dozens: go through the story from the first message to the last and list every named character, place, object, event, group and thread the rules call for, however small. Don't leave out a qualifying entity. List all the entities first, then the scenes. ${ROOM_SCENES_RULE}`;

/** The first call of the two-step build: scenes and roster, short. */
const BREADTH = { guide: `Fields:\n${cutRule}${sceneEntryRule}${ROSTER_GUIDE.replace(/^Fields:\n/, '')}`, shape: SHAPE_BOTH, room: ROOM_BREADTH };

export function buildPrompt(messages, outputTokens, { depth = false } = {}) {
    const room = Math.floor(outputTokens / TOKENS_PER_ENTITY);
    const f = depth ? BREADTH : { guide: FIELD_GUIDE, shape: SHAPE, room: ROOM };
    return {
        system: SYSTEM,
        user: `${f.guide}\n\nReturn JSON in exactly this shape:\n${f.shape}\n\n${f.room(room)}\n\nThe transcript has ${messages.length} messages, ids 0 to ${messages.length - 1}.\n\n<transcript>\n${renderTranscript(messages)}\n</transcript>`,
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
    const scene = e.kind === 'scene' ? ` [scene starting at message ${e.start}]` : e.main ? ' [main character]' : '';
    const said = e.quotes?.length ? `\n  quotes kept: ${e.quotes.length}` : '';
    return `- ${e.name}${scene}${keys}${brief ? '' : e.facts.map((f) => `\n  kept${f.section ? ` (${f.section})` : ''}: ${f.text}`).join('') + said}`;
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
export function buildPartPrompt(messages, { part, from, to, context, known, brief, outputTokens, depth = false }) {
    const room = Math.floor(outputTokens / TOKENS_PER_ENTITY);
    const ctx = context
        ? `<context from="${context[0]}" to="${context[1]}">\n${renderTranscript(messages.slice(context[0], context[1] + 1))}\n</context>\n\n`
        : '';
    const next = to + 1 < messages.length ? to + 1 : null;
    const after = next == null ? '' : `\n\n<next_part_starts>\n${renderTranscript([messages[next]])}\n</next_part_starts>`;
    const [s0, s1] = sceneRange(from, to, messages.length);
    const scenesLine = `- scenes: scene starts among messages ${s0} to ${s1}.${next == null ? '' : ` Include ${next} only if the story cuts to a new scene there.`}
`;
    const entitiesLine = `- entities: every entity messages ${from} to ${to} establish something about, known or new. For a known entity, use its name exactly as <known_entities> lists it, and add only what this part establishes that its kept facts don't already cover, in the same sections, and add quotes only if you can give new ones. A known entity that becomes a main character: say main true. A scene already listed under <known_entities> is reported by its listed name and start only if this part continues it. One exception: when this part gives the proper name of an entity listed under an epithet or title ("the cartographer" turns out to be "Ines Vell"), report it under its proper name with the listed name among its keys.
`;
    const f = depth ? BREADTH : { guide: FIELD_GUIDE, shape: SHAPE, room: ROOM };
    const guide = `This is part ${part}: messages ${from} to ${to} of ${messages.length}. ${part > 1 ? '<known_entities> lists what the earlier parts found.' : 'It is the first part.'}${context ? ` Messages ${context[0]} to ${context[1]}, in <context>, end the previous part; they are there so you can follow the story across the cut, and were already read.` : ''}${next == null ? ' It is the last part.' : ` Message ${next}, in <next_part_starts>, begins the next part.`}
Report:
${scenesLine}${entitiesLine}- Every fact must cite messages from ${from} to ${to}. Report nothing from <context> or <next_part_starts> but scene starts.`;
    return {
        system: PART_SYSTEM,
        user: `${f.guide}\n\n${guide}\n\nReturn JSON in exactly this shape:\n${f.shape}\n\n${f.room(room)}\n\n<known_entities>\n${renderRoster(known, { brief }) || '(none yet)'}\n</known_entities>\n\n${ctx}<part from="${from}" to="${to}">\n${renderTranscript(messages.slice(from, to + 1))}\n</part>${after}`,
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
- entities: every entity listed in <previous_facts>, and every entity the changes establish something new about, known or new. For a known entity, use its name exactly as <known_entities> lists it. One exception: when the passages show that an entity listed under an epithet or title is someone with a proper name ("the cartographer" turns out to be "Ines Vell"), report it once, under its proper name (as listed, if it is listed), with the epithet's listed name among its keys.
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
        user: `${FIELD_GUIDE}\n\n${UPDATE_GUIDE}\n\nReturn JSON in exactly this shape:\n${SHAPE}\n\n${ROOM(room)}\n\nThe whole transcript has ${messages.length} messages, ids 0 to ${messages.length - 1}.\n\n<known_entities>\n${roster || '(none)'}\n</known_entities>\n\n<previous_facts>\n${prior || '(none)'}\n</previous_facts>\n\n<passages>\n${passages}\n</passages>`,
    };
}

// The depth step: a few mains or scenes at a time, over the same text.

export const DEPTH_SYSTEM = `You deepen a lorebook for a roleplay story. The lorebook already lists its entities and scenes with a few short facts each. You read the story and write in full the ones you are asked about, as JSON: a main character's profile, a scene's account, and the lines that show how people speak.\n\nRules:\n- Use only what the transcript states. Never invent detail.\n- Return only the JSON object. No prose, no code fences.`;

export const SHAPE_DEPTH = `{
  "entities": [
    {
      "name": "<the main character's name, exactly as listed>",
      "keys": [],
      "facts": [ { "text": "<a third-person statement>", "section": "appearance" | "personality" | "voice" | "relationships" | "history", "messages": [<ids of the messages that establish it>] } ],
      "quotes": [ { "text": "<words copied exactly from one message>", "speaker": "<who said it>", "message": <id of that message> } ]
    }
  ],
  "scenes": [
    {
      "start": <the scene's start, as listed>,
      "title": "<the scene's title, as listed>",
      "keys": ["<2-4 words or phrases copied exactly from the scene's messages>"],
      "facts": [ { "text": "<what happened, and why it matters>", "section": "what" | "why", "messages": [<ids>] } ],
      "quotes": [ { "text": "<words copied exactly from one message>", "speaker": "<who said it>", "message": <id of that message> } ]
    }
  ]
}`;

const profileRule = FIELD_GUIDE.slice(FIELD_GUIDE.indexOf('  - a main character gets'), FIELD_GUIDE.indexOf('  - a character who recurs')).trim().replace(/^- a main character gets a full profile: /, '');
const quotesRule = FIELD_GUIDE.slice(FIELD_GUIDE.indexOf('- quotes:'), FIELD_GUIDE.indexOf('- caseSensitive:'));

const DEPTH_MAIN = `- a main character: a full profile, at least ${profileRule} The kept facts listed with the character are already in the entry: add what they don't cover, in the same sections, and don't restate them.\n`;
const DEPTH_SCENE = `- a scene: what happened, in two to five facts (section "what": the events in order, with who did and said what; section "why": why it matters to the story, what it changes, sets up or reveals), each a full sentence or two with the concrete detail, citing messages inside the scene. Add what the kept fact doesn't cover. Give 1-3 quotes from the scene, the lines that capture it; every scene where anyone speaks has them. Give "keys" too: 2-4 words or phrases that are word for word in the scene's messages, distinctive to this scene (a place, an object, an event), and not among the <taken_keys> (another entry already uses those, and a key two entries share fires neither).\n`;
const DEPTH_QUOTES = `${quotesRule}- A quote is one unbroken stretch of the message. When narration or "she said" cuts a speech in two, take the piece on one side of the cut; never join the pieces, change punctuation, or fill a gap with "...". Prefer a short line: one sentence of speech, copied from between its quotation marks, is the safest. Check each quote against the message once more before you give it.\n`;

/** The guide for a batch of main characters, of scenes, or (both) of each. */
export const depthGuide = ({ mains = true, scenes = true } = {}) =>
    `Write, for each ${mains && scenes ? 'main character and scene' : mains ? 'main character' : 'scene'} listed under <to_write>:\n${mains ? DEPTH_MAIN : ''}${scenes ? DEPTH_SCENE : ''}${DEPTH_QUOTES}- Report ${mains && scenes ? 'a main character under "entities" and a scene under "scenes"' : mains ? 'each under "entities" and leave "scenes" empty' : 'each under "scenes" and leave "entities" empty'}. Report only what is listed in this call, nothing else. Every fact and quote must come from messages inside the span given for it.`;

/**
 * The prompt for one batch of the depth step. `mains` and `scenes` are canon
 * entities; `spans` maps a scene's start to its [first, last] message ids.
 */
export function buildDepthPrompt(messages, { from, to, mains, scenes, spans, taken = [], outputTokens }) {
    const room = Math.floor(outputTokens / TOKENS_PER_ENTITY);
    const title = (e) => e.name.replace(/^Scene: /, '');
    const list = [
        ...mains.map((e) => rosterLine(e, false).replace(' [main character]', ' [main character: write the profile]')),
        ...scenes.map((e) => {
            const [a, b] = spans.get(e.start);
            const meta = [e.when && `when: ${e.when}`, e.where && `where: ${e.where}`, e.who?.length && `who: ${e.who.join(', ')}`, e.line && `happened: ${e.line}`].filter(Boolean).join('; ');
            return `- scene start ${e.start}, title "${title(e)}", span: messages ${a} to ${b}; ${meta}${e.facts.map((f) => `\n  kept${f.section ? ` (${f.section})` : ''}: ${f.text}`).join('')}`;
        }),
    ].join('\n');
    return {
        system: DEPTH_SYSTEM,
        user: `${depthGuide({ mains: mains.length > 0, scenes: scenes.length > 0 })}\n\nReturn JSON in exactly this shape:\n${SHAPE_DEPTH}\n\nYour reply has room for about ${room} entities' worth of text; use it on the ${mains.length + scenes.length} listed and write each one in full.\n\n<to_write>\n${list}\n</to_write>${scenes.length ? `\n\n<taken_keys>\n${taken.join('; ')}\n</taken_keys>` : ''}\n\nThe story, messages ${from} to ${to}:\n\n<transcript>\n${renderTranscript(messages.slice(from, to + 1))}\n</transcript>`,
    };
}

// The sweep: the roster call, asked for every entity of a whole story, stops
// short (it lists the people and places and skips plans, objects, events and
// threads). A model reading a few scenes at a time, with the roster in hand,
// finds what is missing.

export const SWEEP_SYSTEM = `You complete a lorebook for a roleplay story. You read a passage of the story with the list of entities the lorebook already has, and report as JSON the entities the passage establishes something about that the list lacks.\n\n${RULES.split('\n').filter((l, i) => i !== 2).join('\n')}`;

export function buildSweepPrompt(messages, { from, to, known, outputTokens }) {
    const room = Math.floor(outputTokens / TOKENS_PER_ENTITY);
    return {
        system: SWEEP_SYSTEM,
        user: `${ROSTER_GUIDE}\n\nReturn JSON in exactly this shape:\n${SHAPE_ROSTER}\n\nThe lorebook's list, under <known_entities>, is not complete. Read messages ${from} to ${to}, below, and list only the entities they establish something about that the list lacks. Look for: objects the characters carry, wear, give, hide or keep; plans, schemes, spells, rituals and deals; named events and turning points the characters refer back to (a fire, a battle, an arrival, a siege), even when the story gives them no formal name; every place a scene is set or the plot turns on; groups and factions; threads the story keeps returning to; and every named character who speaks or acts. Your reply has room for about ${room} entities. Don't report anything already under <known_entities>, nor under another spelling or form of the name. Only what the story would suffer from forgetting: skip a one-off detail that is never mentioned again. If nothing is missing, "entities" is empty. Scenes are reported in a separate step: leave "scenes" empty. Every fact must cite messages from ${from} to ${to}.\n\n<known_entities>\n${renderRoster(known, { brief: true }) || '(none)'}\n</known_entities>\n\n<passage from="${from}" to="${to}">\n${renderTranscript(messages.slice(from, to + 1))}\n</passage>`,
    };
}
