# Canonkeeper

Canonkeeper turns a SillyTavern roleplay chat into a correct, self-maintaining World Info lorebook, so the story remembers itself. You run it with `/canon`.

It's a clean-room build. It's written from its own spec and SillyTavern's public APIs and lorebook format, and not from any other extension's code.

**Status: build step 3 (SillyTavern adapter).** The core turns a transcript file into a complete lorebook in one model call (step 1), then keeps it up to date as the chat changes, re-reading only the scenes that changed (step 2). The repo is also a SillyTavern extension, so `/canon` runs the same core inside SillyTavern (step 3). The command line still works for offline runs.

## The one-shot core (`src/`)

```bash
node bin/canonkeeper.js build <chat.jsonl> --out <dir> [--model claude-sonnet-5] [--context 200000]
node bin/canonkeeper.js pin   <dir> "<entry title>"      # mark an entry human-pinned
node bin/canonkeeper.js update <chat.jsonl> --run <dir> [--out <dir>] [--dry-run]   # print the plan, then apply it
node bin/canonkeeper.js rerun <chat.jsonl> --run <dir>   # same, but writes only <dir>/rerun.json
npm run build:story                                      # replay the recorded replies, then gate them
```

`build` writes `book.json`, `scenes.json`, `ledger.json` and `replies.json` (the raw model reply, which `--replay` plays back with no model). The offline model is the Claude Code CLI in print mode, with no tools and thinking off. A reply cut off at the output limit counts as a bad reply.

How it works:

1. **Size from the window.** `--context` is the model's context window. A quarter of it, capped at 64k, is reserved for output and the rest is the prompt budget. A story that doesn't fit is refused before any call. Long stories are step 4's chunked fallback.
2. **One call.** The model sees every message, numbered, and returns scene starts plus, per entity, six fields: `name`, `keys`, `facts` (the content, each fact citing its message ids), `caseSensitive`, `cascade` and `throttle`. The reply must be strict JSON. It gets one retry, then the run fails. Nothing is repaired by guessing.
3. **Code writes the lorebook** (`src/compile.js`). One key registry sees every entity at once:
   - a key the transcript never uses is dropped;
   - a capitalised key whose lowercase form also appears in the story makes the entry case-sensitive (Wren the runner vs. a wren);
   - a key that fires on more than 80% of messages is dropped;
   - a key two entities claim is dropped from both, unless one is pinned, in which case the pin keeps it;
   - two replies about the same name are merged, never split.

   An entity with no usable key left goes to the review list in `ledger.json` instead of the book. If none of an entity's cited messages names it (the model cited scenes that call him "the King"), the first message that does name it is added to `sources` as `canonkeeper.anchor`, kept apart from the facts' own sources. The model never writes an ST field: `cascade: false` compiles to `preventRecursion`, and `throttle` to `cooldown`.
4. **Provenance on every fact.** Each entry carries `canonkeeper.facts[]` with the source ranges for each fact, and `canonkeeper.sources` is their union.
5. **Re-runs** are step 2, below.

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
- The call isn't streamed. A reply that takes longer than the server's HTTP timeout fails the run, which matters for long stories (step 4).

### The live acceptance run (`harness/live/st-live.mjs`)

This drives a fresh SillyTavern through a real browser, as a user would. It installs the extension from the repo URL, makes a connection profile, picks it in the panel, opens the fixture chat and types `/canon`. Then it pins two entries in the status view and types `/canon` again. Every check reads SillyTavern's HTTP API from outside the page: the extension on disk, the lorebook file and the run record in the chat file. Nothing relies on the page reporting its own success. It writes `live.log`, screenshots and a run directory, then gates that run directory.

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
```

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

Before scoring, the gate also validates the answer key itself, because a wrong key makes every score wrong. It checks that no name belongs to two entities, that every entity is mentioned in the transcript, that decoys are real non-mentions, and that the planted cases are present.

Thresholds live in `THRESHOLDS` in `harness/checks.js`.

## Fixtures (`fixtures/story/`)

The fixture story is *The Saltwind Chart*. It's an invented 81-message story with narrator headers (`[Place · Scene · Day]`), and it contains no real people or chats.

| File | Contents |
|---|---|
| `transcript.jsonl` | The chat in SillyTavern's chat JSONL format. Line 1 is the header. Message ids are 0-based positions after the header |
| `answer-key.json` | 17 entities (16 required), scene boundaries, contested keys and the planted cases |
| `reference/` | The hand-built reference run. It scores 1.0 against the answer key |
| `broken-collision/` | The reference with the planted collision left unresolved. CI requires the gate to go red on it |
| `recorded/replies.json` | A full-build reply recorded from a real model run, replayed in CI |
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

Keyword activation follows SillyTavern's documented World Info matching. A `/regex/flags` key is treated as a regex. When whole-word matching is on, a single-word key must match a whole word and a multi-word key matches as a substring. Matching is case-insensitive unless the entry is case-sensitive. A null per-entry setting falls back to `DEFAULTS` in `harness/activation.js`.
