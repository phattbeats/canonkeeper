# Canonkeeper

Canonkeeper turns a SillyTavern roleplay chat into a correct, self-maintaining World Info lorebook, so the story remembers itself. You run it with `/canon`.

It's a clean-room build. It's written from its own spec and SillyTavern's public APIs and lorebook format, and not from any other extension's code.

**Status: build step 6 (the audit).** The core turns a transcript file into a complete lorebook in one model call (step 1), then keeps it up to date as the chat changes, re-reading only the scenes that changed (step 2). The repo is also a SillyTavern extension, so `/canon` runs the same core inside SillyTavern (step 3). A story too long for the model's window is read in parts, and the book says so (step 4). With live mode on, the book keeps up while you play: a cheap model notices when a scene ends, and the scene that ended goes through step 2's update (step 5). `/canon-audit` checks the book: plain code finds what's technically wrong, a model checks every claim against the messages it cites, and every fix waits for you to accept it (step 6). The command line still works for offline runs.

## The one-shot core (`src/`)

```bash
node bin/canonkeeper.js build <chat.jsonl> --out <dir> [--model claude-sonnet-5] [--context 200000] [--output-share 0.25]
node bin/canonkeeper.js pin   <dir> "<entry title>"      # mark an entry human-pinned
node bin/canonkeeper.js update <chat.jsonl> --run <dir> [--out <dir>] [--dry-run]   # print the plan, then apply it
node bin/canonkeeper.js rerun <chat.jsonl> --run <dir>   # same, but writes only <dir>/rerun.json
node bin/canonkeeper.js audit <chat.jsonl> --run <dir> [--model claude-haiku-4-5-20251001] [--no-verify]   # writes <dir>/audit.json
node bin/canonkeeper.js accept <chat.jsonl> --run <dir> <finding id>                                      # apply one fix
node bin/canonkeeper.js dismiss <dir> <finding id>
npm run build:story                                      # replay the recorded replies, then gate them
npm run build:chunked                                    # the same story on a window too small for it
```

`build` writes `book.json`, `scenes.json`, `ledger.json` and `replies.json` (the raw model reply, which `--replay` plays back with no model). The offline model is the Claude Code CLI in print mode, with no tools and thinking off. A reply cut off at the output limit counts as a bad reply.

How it works:

1. **Size from the window.** `--context` is the model's context window. A quarter of it, capped at 64k, is reserved for output and the rest is the prompt budget. `--output-share` changes the quarter. A story that doesn't fit is read in parts (below).
2. **One call.** The model sees every message, numbered, and returns scene starts plus, per entity, six fields: `name`, `keys`, `facts` (the content, each fact citing its message ids), `caseSensitive`, `cascade` and `throttle`. The reply must be strict JSON. It gets one retry, then the run fails. Nothing is repaired by guessing.
3. **Code writes the lorebook** (`src/compile.js`). One key registry sees every entity at once:
   - a key the transcript never uses is dropped, and so is a pronoun (a first-person narrator's "I");
   - a capitalised key whose lowercase form also appears in the story makes the entry case-sensitive (Wren the runner vs. a wren);
   - a key that fires on more than 80% of messages is dropped;
   - a key two entities claim is dropped from both, unless one is pinned, in which case the pin keeps it;
   - two replies about the same name are merged, never split.

   An entity with no usable key left goes to the review list in `ledger.json` instead of the book. If none of an entity's cited messages names it (the model cited scenes that call him "the King"), the first message that does name it is added to `sources` as `canonkeeper.anchor`, kept apart from the facts' own sources. The model never writes an ST field: `cascade: false` compiles to `preventRecursion`, and `throttle` to `cooldown`.
4. **Provenance on every fact.** Each entry carries `canonkeeper.facts[]` with the source ranges for each fact, and `canonkeeper.sources` is their union.
5. **Re-runs** are step 2, below.

## Long stories: the chunked fallback (`src/chunked.js`)

When the one-call prompt won't fit the window, `build` reads the story in parts instead, in order:

1. **Each part is sized from the window.** A part takes as many messages as fit beside the prompt, the ledger so far and some context. Nothing is a fixed chunk size. If not even one message fits, the run is refused before any call.
2. **One ledger is carried across the parts.** Each part sees every entity the earlier parts found, with its keys and facts, under `<known_entities>`. A known entity comes back under the name it already has and gains only what the part adds. When the roster outgrows a third of the prompt budget, it drops the facts and keeps names and keys. A part also sees the end of the previous part, back to its last scene start (up to a tenth of the budget), as read-only context, so a scene or a name can be followed across the cut.
3. **A fact must cite its own part.** The model saw nothing else, so a citation outside the part is left out and listed for review.
4. **Cuts fall where scene starts can be judged.** Read cold, the first message of a part looks like a scene start, so a part never decides whether a scene starts at its own first message. When a part's last scene starts past its first third, that unfinished scene is handed to the next part to read whole: the part's facts from it are left for the next part, and the cut falls on a scene start the part already found (the part's `read` records how far it actually read). When the cut falls mid-scene, the part also sees the next part's first message and decides whether a scene starts there.
5. **A name that turns up later renames the entity.** When a part gives the proper name of an entity known so far by an epithet, it reports the proper name with the epithet among its keys. Code renames the known entity and keeps the old name as a key (`ledger.chunked.renamed`).
6. **One reconciliation pass with its own budget.** A part can't see ahead, so one entity can come out twice: as "the cartographer" in an early part and "Ines Vell" in a later one. One last call reads the whole entity list (no transcript, output capped at 8k) and names the pairs that are the same entity. Code merges them: keys, facts and sources. A merge naming an entity that wasn't listed, or one entity twice, is not applied and goes to review. Naming one of the kept entity's own keys merges nothing and is ignored. If even the brief list doesn't fit, the pass is skipped and the review list says so.
7. **Then the same compile** as a one-shot build, so every key rule and invariant holds.

The output is flagged. `ledger.chunked` records each part (`from`, `to`, the context shown, the prompt estimate), the reconciliation and its merges, and the number of calls. It stays on the ledger through later re-runs. The CLI prints `CHUNKED: ...`, and `/canon` says so in its summary and status view. A chunked book is never presented as a one-shot result.

Re-runs work the same way on a chunked ledger as on a one-shot one.

## Live mode (`src/live.js`)

With live mode on, nobody has to type `/canon`: the book keeps up while the chat is written. Two triggers drive it, and each fires once.

1. **Detection runs on a cadence.** Once `cadence` messages (4 by default) are waiting to be judged, one call to a cheap model reads them and reports where new scenes start. It also sees the open scene before them as context, and the newest message after them. A message arriving doesn't make a call. A call is made once enough messages have arrived. So N messages make about N/cadence calls, not N. Every message is judged once.
2. **The update runs on an edge.** A scene start means the scene before it has ended. When the end of the last finished scene moves forward, the transcript up to that point goes to step 2's `update()`, with the detector's scene starts. Only the scenes that are new or changed are re-read. The open scene waits until it ends. The first update on a chat without a ledger is a full build of the finished scenes.

What the detector is asked:

- **The newest message is look-ahead.** It's shown after the messages being judged, and judged in the next call. Without it, the end of a scene ("she sets off up the cliff road") read with nothing after it looked like a cut. Then the cut landed one or two messages early, in 3 of 3 runs.
- **A cut is a message that doesn't pick up where the one before it left off.** The story skips ahead in time, or moves somewhere else and leaves out the journey. A bracketed narrator header marks a new scene. A message that carries straight on is the same scene, however far the characters go: a reply, the next action, or the story following them down a stair and out to a boat. The detector names what each cut leaves out. Asking "where does a new scene start?" instead split the fixture's escape (messages 71–80) in 2 of 3 runs. Rewording that question only moved the false starts around.
- **Strict JSON, one retry.** An id outside the judged range is ignored.

Other behaviour:

- **Failures back off.** A failed detection, or a failed update, is tried again after another `cadence` messages, not on every message. A failed update writes nothing, as with `/canon`.
- **Edits are followed.** When a judged message is edited, swiped or deleted, it is judged again along with everything after it. If it sat in a finished scene, the book follows the edit at the next tick.
- **Live mode picks up after a `/canon` run.** If the chat's ledger covers an unchanged start of the chat, that part counts as judged and its scene starts as found.
- **The story is never touched.** A tick waits while SillyTavern is writing a reply, and a message is judged only once it's complete. The detector uses its own connection profile, never the roleplay one.

**The state store** is `chat_metadata.canonkeeper.live`, saved in the chat file next to the ledger. It survives reloads and can be read from outside the page. It holds:

- a hash of every judged message (the watermark);
- the scene starts;
- `detectCalls` and `updates`;
- `cycles`, the last 200 ticks that did anything. Each cycle records what was judged and found, and which update ran through which message, with how many writes or what error.

A tick with nothing due makes no call and saves nothing.

In SillyTavern, live mode is under **Extensions → Canonkeeper**. It has a **Live mode** box, a **Scene detection profile** (defaults to the writer's profile; a cheap fast model is the point), **Check every** (the cadence) and the detector's context window. The status view shows the state store: messages judged, scene starts, call counts and the recent cycles.

### Measured on the fixture

The detector was scored against the answer key's 7 scene starts at ±1, on 81 messages. Most runs used `harness/live-sim.js --detect-only`; the full sessions also ran the writer. The final prompt was used throughout:

| Detector | Cadence | Runs | Detection calls | Precision | Recall |
|---|---|---|---|---|---|
| claude-haiku-4-5 | 4 | 9 (8 detection-only, 1 full session) | 20 | 1.0 in 9 of 9 | 1.0 in 9 of 9 |
| claude-haiku-4-5 | 6 | 1 | 13 | 1.0 | 1.0 |
| claude-haiku-4-5 | 2 | 1 | 40 | 0.78 (extra starts at 73, 79) | 1.0 |
| claude-sonnet-5 | 4 | 2 | 20 | 0.54, 0.78 | 1.0 |

- **Sonnet as the detector splits more than Haiku**, so the cheap model is also the better detector here.
- **Smaller batches are worse.** At cadence 2 each call sees too little to compare.
- **Earlier prompts did worse.** Before look-ahead, Haiku had one false start in 36–39 in 3 of 3 runs. With look-ahead but the "where does a scene start?" question, 2 of 3 runs had a false start in the escape.

In the full session, the writer was claude-sonnet-5. Live mode made 7 updates, one per scene end, and the book passed I1–I6.

At first, one entity was split. The story calls Dovrin Kesh "the Magistrate" and drops the name "Kesh" in the first scene, but it only shows they are one person in the second. The first update had already made two entries, and the second added "Magistrate Kesh" to one of them while leaving "the Magistrate" alone. That entry also took keys for things of his, such as "Magistrate's hall", which is a place. That happened in 2 of 2 sessions. Three fixes:

- The update prompt asks for an entity listed under an epithet to be reported once, under its proper name, with the epithet among its keys. This is the instruction a chunked part already gets.
- When a reply lists one known entity's name among another's keys, `merge()` folds the first into the second (keys, facts, flags). A new name that lists exactly one known entity is a rename: the entry keeps its uid and its old name as a key. The review list records both.
- The field guide says a key names the entity itself, never something of its.

After the fixes, 3 of 3 sessions had no split or over-merge: one Kesh entry with "the Magistrate" among its keys, and the Magistrate's Hall in its own entry. Two sessions passed C7. The third missed the Saltwind Chart, which is model omission (see the chunked results). `fixtures/story/live` holds one of the passing sessions.

```bash
node harness/live-sim.js fixtures/story/transcript.jsonl --out .run/live [--detect-model claude-haiku-4-5-20251001] [--model claude-sonnet-5] [--cadence 4] [--detect-only]
npm run build:live     # replay the recorded session, then gate it with --live
```

`harness/live-sim.js` writes the story into a fake SillyTavern one message at a time and runs the adapter's own tick (`runLive`) after each, as the extension does. It writes a run directory: the book live mode kept, the detector's scene starts, the ledger, `live.json` (the state store) and the replies of both models, for `--replay`.

### The live session run (`harness/live/st-session.mjs`)

This drives a fresh SillyTavern through a real browser for the whole fixture story: 40 turns (one per user line) with no reload. It installs the extension from the repo URL and makes two connection profiles, the writer (claude-sonnet-5) and the detector (claude-haiku-4-5). It ticks **Live mode** in the panel. Then it types each of the story's user lines into the chat box and sends it. The narrator's replies come from real SillyTavern generations, served by a small OpenAI-compatible endpoint in the driver that answers with the story's next narrator message. So the chat comes out as the fixture, and its scene starts can be scored against the answer key. Every check reads SillyTavern's HTTP API from outside the page: the state store in the chat file, the lorebook file, and that the page's origin never changed. It writes `session.log`, screenshots and a run directory, then gates it with `--live`.

On 2026-10-04 it ran against SillyTavern 1.19.0, at a reading pace of about 12 s per turn. The story played out with no reload: the page origin never changed, and the chat file matched the fixture message for message. The state store in the chat file recorded 14 cycles: 13 detection calls for 81 messages, and 7 updates, one per scene end. When a tick was still busy, the next one judged everything waiting, so some calls covered 6–12 messages. The scene starts were exactly the answer key's 7. The gate passed every check: I1–I6, C7, C8 and L11.

```bash
ST_DIR=/path/to/SillyTavern ST_PAGE=http://<st-host>:8000/ ST_API=http://127.0.0.1:8000 \
BROWSER_WS=ws://<browserless>:3000 PROXY_URL=http://<claude-proxy>/v1 node harness/live/st-session.mjs
```

## The audit (`src/audit.js`, `/canon-audit`)

The audit checks a lorebook against its chat and writes nothing to it. It has two passes.

1. **The technical pass is plain code and makes no model call.** It reads every enabled entry, Canonkeeper's or not, the way SillyTavern does (regex keys, case and whole-word settings). It reports:
   - a key two entries claim (`collision`, an error);
   - a bare title inside another entry's key, such as "Captain" against "Captain Hale" (`overlap`, a warning);
   - an entry with no keys (`no-keys`);
   - a key that fires on more than 80% of the messages (`overbroad`);
   - a probability of 0 or outside 0–100, or below 100 (`probability`; the last is a warning);
   - an entry that waits for recursion when nothing can trigger it, or that also excludes recursion (`recursion`);
   - provenance that cites messages outside the chat, or none that name the entry (`provenance`);
   - an entry Canonkeeper wrote that has been deleted (`deleted`);
   - an entity the story has that got no entry (`missing`).
2. **Claim re-verification reads provenance.** Each fact an entry carries cites its messages. The model gets each fact with exactly those messages, and says what they say before it gives a verdict: supported, unsupported or contradicted. Facts are batched to fit the window, one entry's facts kept together. A fact that cites a message changed since the book was written is `stale`: it can't be checked until `/canon` brings it up to date. The verdicts are strict JSON with one retry. A claim with no usable verdict stays unchecked, and nothing is assumed either way.

**The review queue.** A finding that can be fixed carries its fix, and nothing is applied until someone accepts it. Every fix changes something a person may want as it is: an entry they edited or deleted, or a fact the model wrote.

| Fix | Offered for | What accepting it does |
|---|---|---|
| remove the key | a collision (from every claimant that isn't pinned; between two pins, only a human can choose) or an overbroad key | edits those entries, as you would in the World Info editor. An entry Canonkeeper wrote is then edited by hand and held |
| change the setting | a probability or recursion problem | sets `probability` to 100 or `delayUntilRecursion` to false |
| restore | a deleted entry | takes it off the ledger's `deleted`, and the entry comes back on its old uid, as it was |
| drop the fact | an unsupported or contradicted claim in an entry Canonkeeper still owns | takes the fact out of the ledger's canon and recompiles, with no model call. A claim in a held entry is reported but not offered: that text is yours |

When Canonkeeper's own entry is the problem, the finding says to run `/canon` instead, because `/canon` fixes its own entries. That covers a key it shares with a held entry, or a key that has grown overbroad. A fix is refused if the book or the chat has changed since the audit: audit again first. Accepting a fix runs the technical pass again, so the queue matches the book. Claim verdicts carry over to the new queue. A dismissed finding stays dismissed in later audits.

In SillyTavern, type `/canon-audit` or press **Audit** in the panel. The status view shows the review queue with an **Accept** and a **Dismiss** button per finding, then the dismissed and accepted ones and the audit's log. The record lives in `chat_metadata.canonkeeper.audit`. Claim checking is on by default and uses the **Claim check profile**. If that isn't set, it uses the scene detection profile, then the writer's.

### Measured on the fixture

`npm run build:audit` builds the fixture book from the recorded reply and audits it as built. Then `harness/plant.js` plants damage from `fixtures/story/audit/plant.json` into a second build, and that one is audited too:

- two false facts in the model's reply: the lighthouse keeper is "a young woman who lets Tamsin in without a word" (message 40 says an old man in a monk's habit, who speaks), and Mora Quill "was born in Saltgate and served ten years in the city watch" (message 2 says nothing of it);
- "Captain" added to both Mora Quill and Oren Hale, the story's planted collision;
- The Harbor Fire deleted.

| Claim checker | Runs | Clean book: claims flagged (of 59) | Planted: both false facts caught | Planted: other claims flagged |
|---|---|---|---|---|
| claude-haiku-4-5 | 4 | 0, 0, 0, 0 | 4 of 4 (contradicted; unsupported) | 0, 0, 0, 1 |
| claude-sonnet-5 | 4 | 4, 2, 5, 5 | 4 of 4 | 4, 7, 2, 4 |

The technical pass caught the collision and the deletion every time, and found nothing on the clean book. Sonnet flags more. Most of its flags are real mis-citations, a fact citing the message before or after the one that says it. Some are pedantic. Haiku flagged none of those, so the cheap model is the default here too. Before the reply put its reasoning ahead of the verdict, Sonnet sometimes argued itself to "supported" and still answered "unsupported".

### The live audit run (`harness/live/st-audit.mjs`)

This drives a fresh SillyTavern through a real browser. It installs the extension from the repo URL and makes two connection profiles: the writer (claude-sonnet-5) and the claim checker (claude-haiku-4-5). It types `/canon`, then `/canon-audit` on the book as built. Then it damages the book as a user might. It deletes The Harbor Fire in SillyTavern's own World Info editor (delete button, confirm dialog), and adds "Captain" to Mora Quill and Oren Hale through SillyTavern's World Info save. It types `/canon-audit` again, then `/canon`. It accepts both fixes by clicking their **Accept** buttons in the status view, and finishes with a technical-only audit. Every check reads SillyTavern's HTTP API from outside the page. It writes `audit.log`, screenshots and an audit run directory, then gates it with `--audit`. Live builds word their own books, so false facts are planted only in the CI run.

On 2026-10-04 it ran against SillyTavern 1.19.0 at commit 3d49a64:

- **The book as built:** no technical finding. 47 of 48 claims were verified, and 3 were flagged unsupported. All 3 are claims that go beyond their cited messages, such as a fact citing #34 and #44 for a Tuesday-night detail from #4.
- **After the damage:** both plants were caught. The collision on "Captain" was an error with a fix, and the deleted entry was a warning with a restore. The lorebook file was byte-identical after the audit.
- **`/canon` on the damaged book:** zero writes, the two edited entries held, and The Harbor Fire still deleted.
- **The accepted fixes:** The Harbor Fire came back on its old uid, and "Captain" came off both entries.
- **The gate:** A12 and A13 green.

Two live-only bugs came up on the way.

- **The output cap.** SillyTavern turns on thinking for Claude, so at an 8,000-token output cap every claim-check reply came back empty or cut off, and every claim stayed unchecked. The audit reported "0 of 50 claims verified" rather than a pass. The cap is now 32,000.
- **The driver.** It clicked Install 100 ms after typing the URL, and the install never reached the server.

```bash
ST_DIR=/path/to/SillyTavern ST_PAGE=http://<st-host>:8000/ ST_API=http://127.0.0.1:8000 \
BROWSER_WS=ws://<browserless>:3000 PROXY_URL=http://<claude-proxy>/v1 node harness/live/st-audit.mjs
```

Before step 6, `/canon` silently added a deleted entry back. The re-run in `build:audit` now makes zero writes, and A12 checks that the entry stays deleted.

## Re-runs (`src/update.js`, `src/plan.js`, `src/align.js`)

The ledger (`ledger.json`, versioned, one per chat) is the state, and the lorebook is the output. It holds:

- the canon: every entity as the model gave it, with each fact and the messages it cites, and the uid of its entry;
- a content hash of every message;
- a hash of the fields of every entry as Canonkeeper last wrote it;
- the scene starts, every key decision and the review list;
- a `revision` that counts the runs that wrote.

`update` does four things:

1. **Lines up the messages.** Messages are matched by content hash, not by id, so an insert or a delete early on doesn't make the whole story look changed. A fact citing only unchanged messages stands, and its ids are moved if the messages moved.
2. **Re-reads only the changed scenes.** Every scene with a new, edited or deleted message goes to the model, whole, in one call. Facts that cited an edited or deleted message are reopened: the model restates each one word for word or drops it. Anything else it reports is new, and something new can only come from a changed message. A new fact citing only unchanged messages can only stand in for a reopened fact of the same entity, one for one. Past that it's left out and listed for review. So an entry never grows from text that didn't change. A known entity keeps its flags, which were set from the whole story. A reopened fact the model doesn't restate is dropped and listed for review.
3. **Compiles the whole canon again,** so keys stay unique across the book. An entity keeps its uid. A new one gets the next uid, and a retired uid is never reused.
4. **Diffs it against the book** into a plan of `add`, `update` and `remove` writes, and applies only that plan. Three kinds of entry are held exactly as they are, and their keys win every contest:
   - a pinned entry;
   - an entry edited by hand (its hash no longer matches the ledger);
   - an entry Canonkeeper didn't write.

   An entry Canonkeeper wrote that has been deleted from the book stays deleted. Its entity stays in the canon, under the ledger's `deleted`, but gets no entry, and its keys are free. Only accepting the audit's restore brings it back.

   An update rewrites only the fields Canonkeeper owns (`key`, `comment`, `content`, `caseSensitive`, `preventRecursion`, `cooldown`, `canonkeeper`). Order, position, depth, `disable` and the rest stay as the user set them, and changing them isn't an edit.

An unchanged transcript makes no model call and compiles to the book it already has: an empty plan, zero writes. A held entity's canon still follows the story, so when the pin comes off, the next run brings the entry up to date. A ledger from step 1 (version 1), or no ledger, means one full rebuild with pins and foreign entries held and entries kept on their uids by title.

`harness/compare.js` scores a built book against a hand-curated one for real chats that have no answer key. Real chats stay out of the repo: put them under `local/`, which is gitignored.

## In SillyTavern (`adapter/`, `/canon`)

Install it from **Extensions → Install extension** with the repo URL, `https://github.com/phattbeats/canonkeeper`. The repo is private, so the SillyTavern server needs git access to it. Then:

1. Make a connection profile (Connection Profiles, under API Connections) for the model that should write the lorebook. Chat Completion and Text Completion profiles both work.
2. Under **Extensions → Canonkeeper**, pick that profile and set the model's context window. Max output defaults to 64k.
3. Open a chat and type `/canon`, or press **Run /canon** in the panel.

`/canon` takes no arguments. The first run on a chat builds the whole book, and every later run re-reads only what changed (see Re-runs). It writes to the lorebook bound to the chat. If the chat has none, it creates `Canonkeeper - <chat>` and binds it. A book you bound yourself is used as it is, and its own entries are held.

The panel's status view shows the last run for the open chat: the summary, every write, the held entries and why, the review list and the run log. It also lists the book's Canonkeeper entries with a pin box each. A pinned entry is never changed.

How the adapter works:

- Everything comes through `SillyTavern.getContext()`: the chat, `loadWorldInfo` and `saveWorldInfo`, and `ConnectionManagerRequestService` for the model call. No SillyTavern file is imported, so the install location doesn't matter.
- `adapter/run.js` is the run, with SillyTavern injected, and the tests run it against a fake SillyTavern. Only the plan's writes reach the book. If the chat is switched or the book changes while the model is working, nothing is written and the run says so.
- The ledger and a record of the last run, including its log, are kept in `chat_metadata.canonkeeper`. They are saved in the chat file, so they travel with the chat and can be read from outside the page.
- The model call skips the profile's generation preset, so a roleplay preset's prompts don't reach the lorebook writer. A reply cut off at the output limit counts as a bad reply.
- The call isn't streamed. A reply that takes longer than the server's HTTP timeout fails the run. A chunked build makes one call per part, so each part has to finish inside that timeout.

### The live acceptance run (`harness/live/st-live.mjs`)

This drives a fresh SillyTavern through a real browser, as a user would. It installs the extension from the repo URL, makes a connection profile, picks it in the panel, opens the fixture chat and types `/canon`. Then it pins two entries in the status view and types `/canon` again. Every check reads SillyTavern's HTTP API from outside the page: the extension on disk, the lorebook file and the run record in the chat file. Nothing relies on the page reporting its own success. It writes `live.log`, screenshots and a run directory, then gates that run directory. With `CONTEXT=20000 OUTPUT_SHARE=0.65` the fixture story doesn't fit the window, so `/canon` builds it in parts, and the gate runs with `--chunked`. `OUTPUT_SHARE` has no control in the panel, so the driver sets it in the extension's settings. The output needs that much room because SillyTavern turns on thinking for claude-5 models, and with a 5k cap the thinking used up the reply.

```bash
npm i --no-save playwright-core
ST_DIR=/path/to/SillyTavern ST_PAGE=http://<st-host>:8000/ ST_API=http://127.0.0.1:8000 \
BROWSER_WS=ws://<browserless>:3000 PROXY_URL=http://<claude-proxy>/v1 node harness/live/st-live.mjs
```

## The acceptance gate

```bash
npm test        # unit tests: every check is shown red on a broken book
npm run gate    # the gate on the hand-built reference run: must be green
node harness/gate.js --run <run-dir>   # gate any builder's output
node harness/gate.js --run <run-dir> --chunked   # a run on a window too small for the story
node harness/gate.js --run <run-dir> --live      # a live session (harness/live-sim.js, st-session.mjs)
node harness/gate.js --run <audit-dir> --audit   # an audit run (npm run build:audit, st-audit.mjs)
npm run build:audit                              # build, audit, plant, audit again, re-run, then gate --audit
node harness/live-runs.js --model <id> --n 10     # n live one-shot builds, each gated, then a tally (below)
```

With `--chunked`, the gate also runs K10 on the run's `ledger.json`. Step 4's bar for a chunked run is I1–I6 plus K10, so C7 and C8 are scored and shown as `INFO` but don't gate it.

With `--audit`, the run directory is an audit run (below), and the gate runs only A12 and A13: step 6's bar.

With `--live`, the gate also runs L11 on the run's `live.json`. Step 5's bar for a live session is I1–I6, C8 on the scene starts the detector found, and L11. The live book covers only the scenes that have ended, so C7 is shown as `INFO`.

| Exit code | Meaning |
|---|---|
| 0 | Every check is green |
| 1 | At least one check is red |
| 2 | Fixtures are missing or malformed. This is never a pass |

The checks test properties and coverage, never wording. A builder that writes better entries than the reference still passes. Any check that inspects nothing fails: an empty book, a missing re-run or a book with no pins all go red rather than passing vacuously.

| Check | What it asserts |
|---|---|
| I1 | No keyword is claimed by two enabled entries. Claims collide case-insensitively unless both entries are case-sensitive |
| I2 | No enabled entry ships with zero keys |
| I3 | No key fires on more than 80% of messages. A constant entry counts as firing on every message |
| I4 | Every entry has provenance (`canonkeeper.sources`) inside the transcript, and at least one cited message actually triggers one of the entry's keys |
| I5 | Re-running on the unchanged transcript writes nothing. `rerun.json` must deep-equal `book.json` |
| I6 | Every human-pinned entry survives the re-run with the same title, keys, content and case setting |
| C7 | Coverage against the answer key. Recall on required entities must be 1.0 and precision at least 0.8. It also fails on any split entity, any entry that merges two entities, any entry that never fires on its own entity's mentions, any case-trap decoy that fires, or any claim on a contested key |
| C8 | Scene boundaries at ±1 message, with precision and recall both at least 0.9 |
| E9 | With `--edits` only. For each edit fixture, the run's updated book changes only entries of the edited scene: entries that cite a message there, or whose keys fire there before or after the edit. A pinned entry may not change at all, and an edit that changes nothing is red. A missing update output is a fixture error |
| L11 | With `--live` only. The session's state store shows detection on a cadence: at most N/cadence detection calls for N messages, and every message judged except the few still waiting. At least one update ran, and each one brought the book up to a scene start the detector found, further than the one before. Per-message detection is red |
| A12 | With `--audit` only. The audit of the planted book caught the collision on both entries, the deleted entry and every planted false fact (judged anything but supported). It verified at least one claim and changed nothing in the book, and a re-run left the deleted entry deleted. The plant itself is checked first: a missing plant is a fixture error |
| A13 | With `--audit` only. The audit of the book as built has no technical finding, verified at least one claim, and flagged at most 15% of them |
| K10 | With `--chunked` only. The run's `ledger.json` says it was built in parts: two or more parts that read every message exactly once, in order, and a reconciliation record. A one-shot run gated as chunked is red |

Before scoring, the gate also validates the answer key itself, because a wrong key makes every score wrong. It checks that no name belongs to two entities, that every entity is mentioned in the transcript, that decoys are real non-mentions, and that the planted cases are present.

Thresholds live in `THRESHOLDS` in `harness/checks.js`.

### Live runs of the one-shot build (`harness/live-runs.js`)

CI replays a recorded reply, so it is deterministic. A real model call isn't: the same prompt can pass once and fail the next time. So a live check is n fresh runs, and the result is how many came out green, never a single run.

```bash
node harness/live-runs.js [--model claude-sonnet-5] [--n 10] [--pass 8] [--jobs 3]   # writes .run/live-runs/<model>/<i> and summary.json
```

Each run is built with the real model, has Brother Saul pinned, is re-run and then gated, the way `npm run build:story` does it (without the edit fixtures). It takes about 40 s, and three run at once.

Measured on 2026-10-04, on the fixture story. The fails are the gate as it stands:

| Prompt | claude-sonnet-5 | claude-haiku-4-5 | claude-opus-5-5 |
|---|---|---|---|
| Before | 13 of 20 (6 split the escape at 79; 3 left out Saltgate or the Drowned Lantern) | 9 of 10 | |
| Now | 10 of 10 | 10 of 10 | 0 of 5 (C7 precision, on real minor extras: the Harbor Docks, the Harbor Watch) |

Two changes to the prompt did it:

- **Every scene start names its cut.** Each scene in the reply carries `cut`, written before its `start`: what the story skips there (time that passes unseen, a jump to a place the characters aren't shown travelling to, a switch to other people, or a narrator header). If the model can't name one, there's no new scene. Rewording the scene rule alone did nothing (5 of 10). With `cut` in place, Sonnet stopped splitting the escape. Leaving the narrator header off the list made Opus merge the scene at 10 into the first one, 0 of 5. Its cellar hatch "opens onto" the quay, so the cut there is the header.
- **Setting places are named.** The places to include now say "including the town or city the story is set in and any place a narrator header names". Sonnet stopped leaving out Saltgate.

Magisa, one-shot Sonnet: 36 and 41 of 52 with the new prompt, inside the 36–44 it scored before.

## Fixtures (`fixtures/story/`)

The fixture story is *The Saltwind Chart*. It's an invented 81-message story with narrator headers (`[Place · Scene · Day]`), and it contains no real people or chats.

| File | Contents |
|---|---|
| `transcript.jsonl` | The chat in SillyTavern's chat JSONL format. Line 1 is the header. Message ids are 0-based positions after the header |
| `answer-key.json` | 17 entities (16 required), scene boundaries, contested keys and the planted cases |
| `reference/` | The hand-built reference run. It scores 1.0 against the answer key |
| `broken-collision/` | The reference with the planted collision left unresolved. CI requires the gate to go red on it |
| `recorded/replies.json` | A full-build reply recorded from a real model run, replayed in CI |
| `chunked/replies.json` | The replies recorded from a real chunked build (claude-sonnet-5) with `--context 10000 --output-share 0.5`: four parts (two of them handed an unfinished scene to the next) and a reconciliation. Part 3 renamed "the cartographer" to Ines Vell. It passes I1–I6 and K10. C7 misses the Drowned Lantern and the Gull's Errand, which no part listed. Replayed in CI |
| `live/` | The replies recorded from a real live session (`harness/live-sim.js`): the detector's (claude-haiku-4-5) and the writer's (claude-sonnet-5). `npm run build:live` replays them through the adapter's tick and gates the result with `--live`. Replayed in CI |
| `audit/` | `plant.json`, the damage `harness/plant.js` plants for the audit: two false facts, a collision and a deletion. `verify-clean.json` and `verify-planted.json` are claim verdicts recorded from a real run (claude-haiku-4-5), replayed in CI by `npm run build:audit` |
| `edits/undercroft/` | The story with one scene (20–29) edited. Message 20 changes who cut the Undercroft (the Brine Kings), and message 22 adds a new character (Fennick Rye). `replies.json` is the update reply recorded from a real model run (claude-sonnet-5) |

The story plants three cases for the checks to catch:

- **Miss.** Ines Vell is called only "the cartographer" until message 65. A builder has to find her, and link the epithet to the name, without splitting her into two entries.
- **Collision.** Mora Quill and Oren Hale are both addressed as "Captain", so no entry may claim the bare key.
- **Case trap.** Wren the street runner shares her name with the bird, which appears in lowercase at messages 10, 30 and 79. Her entry needs `caseSensitive`.

One scene break, at message 52, has no narrator header. It can only be found from the prose.

## Run directory format

A builder's output for a transcript is a directory containing three files:

- `book.json`: a SillyTavern World Info file (`{ "entries": { "<uid>": { ... } } }`). Each entry carries `canonkeeper: { "sources": [[from, to], ...], "pinned": bool }`. The ranges are inclusive message ids.
- `rerun.json`: the book after re-running on the unchanged transcript, starting from `book.json` with its pins in place.
- `scenes.json`: `{ "boundaries": [id, ...] }`, the ids of messages that start a new scene. Message 0 is excluded.
- `edits/<name>/book.json` (for `--edits`): `book.json` brought up to date with `fixtures/story/edits/<name>/transcript.jsonl`.

An audit run (`--audit`) is a directory with `clean/audit.json`, the audit of the book as built, and `planted/`. That holds `planted.json` (the uids planted), `planted-book.json` (the book as planted, before the audit), `book.json` (the book after the audit), `audit.json` and `rerun.json` (the book after a re-run).

Keyword activation follows SillyTavern's documented World Info matching. A `/regex/flags` key is treated as a regex. When whole-word matching is on, a single-word key must match a whole word and a multi-word key matches as a substring. Matching is case-insensitive unless the entry is case-sensitive. A null per-entry setting falls back to `DEFAULTS` in `harness/activation.js`.
