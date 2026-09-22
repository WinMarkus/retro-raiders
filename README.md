# Retro Raiders: The Blocker Dungeon

A cooperative retrospective **game** for a distributed dev team. Everyone says how the
last two weeks felt, the app forges a character for each of them, the team throws in what
was good, bad and draining — and that pile becomes a playable dungeon full of enemies made
from your actual blockers.

No database, no login, no paid services required. Room state lives in server memory, the UI
is plain HTML/CSS with browser-side TypeScript, and the whole thing is one repository you
can zip, send to a colleague and run.

```
Node.js 22 · TypeScript · Express · Socket.IO · OpenRouter · vanilla DOM · Vitest
```

---

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:3000>, type a name, press **Create a dungeon**, and share the room
code. The first player in a room is the **facilitator**. It works with no API keys at all —
the local generator takes over wherever the AI would be.

---

## The flow

| Screen | What happens |
|--------|--------------|
| **Join / Create** | Name, and either a room code or a new dungeon. Names are unique per room; a disconnect can be rejoined. |
| **Character Forge** | Energy, pressure and satisfaction on 1–5, a few words about the sprint, optional keywords. The server sends that to OpenRouter and gets back a character: name, class, description, one special skill, one funny weakness, attack and support derived from your numbers. Portraits are emoji plus a CSS card — no image API needed. |
| **Topic Forge** | Up to six topics each, typed **good** / **bad** / **sad**, with an optional description and intensity. Everyone sees the count, only you see your own. |
| **Generation** | The facilitator presses *Generate the dungeon*. The topics go to OpenRouter, which clusters them and returns a level. |
| **The Dungeon** | A top-down map. Move with WASD, arrows, or by clicking. Bad and sad topics are enemies, good ones are power-ups lying on the floor. Walk over a power-up to collect its attack points for the party. Click an enemy to lock on. |
| **Encounter** | When three players lock onto the same enemy, movement pauses and a modal opens with the enemy, the original topics it came from, and who is locked on. The team writes how it wants to handle the issue, an optional owner, a review date, and how many attack points to spend. Submitting freezes the enemy. |
| **Victory Report** | Characters, topics, enemies, power-ups, treatments, points spent, what is still standing, and the action items — a game screen you can still paste into a wiki. |

### Attack points instead of dot voting

Good things from the retro become power-ups; power-ups carry attack points; the party
spends those points on the enemies it cares about. Spending is not damage — an enemy is
frozen by a treatment, not by arithmetic. The points say *how much this matters to us*,
which is the part a dot vote was always trying to measure.

The threshold for opening a fight is three players, or fewer if fewer are connected, so a
room of two is not stuck. That threshold is deliberate: it stops one person from quietly
deciding what the team will do about something.

---

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Watches the browser TypeScript into `public/js/` and runs the server with `tsx watch`. |
| `npm run build` | Compiles the client into `public/js/` and the server into `dist/`. |
| `npm start` | Runs the compiled server. Run `npm run build` first. |
| `npm test` | Runs the Vitest suite once. |
| `npm run typecheck` | Type-checks server and browser builds without emitting. |
| `npm run clean` | Removes `dist/` and `public/js/`. |

The server binds to `process.env.PORT` (default `3000`) and `HOST` (default `0.0.0.0`).
`GET /health` returns status, room count and uptime as JSON.

---

## Environment variables

| Variable | Required | Meaning |
|----------|----------|---------|
| `PORT` | no | HTTP port. Render sets this for you. |
| `OPENROUTER_API_KEY` | no | Enables AI generation. Without it the local generator is used. |
| `OPENROUTER_MODEL` | no | Defaults to `openai/gpt-4o-mini`. |
| `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME` | no | Attribution headers OpenRouter shows on its dashboard. |
| `GITHUB_TOKEN` | only for saving | Fine-grained token with **Contents: Read and write**. |
| `GITHUB_OWNER` | only for saving | User or organisation that owns the target repo. |
| `GITHUB_REPO` | only for saving | Repository that receives the JSON snapshots. |
| `GITHUB_BRANCH` | no | Branch to commit to, defaults to `main`. |

Neither key is ever sent to the browser. They are read server-side only, and both the
OpenRouter and GitHub clients scrub their credential out of every error message before it
can reach a log line or a player.

---

## How the OpenRouter integration works

The server calls `POST https://openrouter.ai/api/v1/chat/completions` with
`response_format: json_object`, a system prompt describing the exact JSON shape, and a
45-second timeout. Two calls exist: one per player for the character, one per room for the
level. AI calls are rate limited to six per room per ten minutes.

**The model's answer is treated exactly like player input.** Nothing it returns is used as
given:

* strings are sanitised and length-capped, angle brackets neutralised;
* `strength`, `attack`, `support` and `attackPoints` are clamped to their ranges;
* `kind` must be one of the five allowed values, otherwise it is derived;
* positions are recomputed server-side so nothing can be placed off the map;
* `sourceTopics` are matched back against topics that actually exist — an invented source
  drops the entry, and a good topic can never become an enemy;
* the enemy count is capped, and a level with no usable enemy at all is rejected.

If the response is unparseable, empty, times out, or OpenRouter returns an error, the room
falls back to the deterministic generator and the reason is shown in the UI. The game never
blocks on the AI.

### The fallback generator

The local generator is not a degraded mode — it plays the same game:

* topics are tokenised (stopwords removed, light stemming) and clustered by shared words, so
  three people reporting "review takes too long" become **one stronger enemy**, not three
  weak ones;
* a bestiary maps recognisable themes to named enemies (The Review Hydra, The Scope Creep
  Ooze, The Context Switch Wraith…), with a generic pool behind it;
* strength comes from cluster size and intensity; good clusters become power-ups;
* everything is derived from a hash of the input, so the same retro always produces the same
  dungeon — which is also what makes the tests deterministic.

---

## How the GitHub integration works

On the victory screen, a player whose name is exactly `Markus` (case-sensitive) sees
**Save retro to GitHub**. On click the server:

1. builds a clean JSON snapshot in memory — no socket ids, no player ids, no mapping from a
   person to a topic;
2. commits it through the GitHub Contents API to
   `retro-saves/retro-raiders/YYYY-MM-DD_HH-mm_room-CODE.json` (UTC, so saves from three
   timezones still sort correctly, and repeated saves never overwrite each other);
3. reports success **only** when GitHub confirms the commit, and returns the file URL.

Repeat clicks are disabled while a save is in flight, saves are rate limited per room, and
nothing is written to Render's disk — the repository is the persistence layer. The snapshot
contains room code, both timestamps, players with their characters and check-ins, every raw
topic, the generated level with enemies and power-ups, the resolutions with owners and
review dates, the attack point ledger and the final summary.

### ⚠️ The name check is not authentication

It is **lightweight team-level permission**. The browser hides the button for everybody
else and the server re-verifies that the requesting socket currently belongs to the room
*and* that its player name is exactly `Markus` — but anyone who can reach the room and
types `Markus` before someone else does would pass. It is a guardrail for a trusted team,
comparable to a "please don't press this" label. If you need real control, put the app
behind SSO or an authenticating proxy.

### Creating the fine-grained token (minimum permission)

1. GitHub → avatar → **Settings** → **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token**.
2. **Resource owner**: the account or organisation that owns the target repository.
3. **Repository access**: *Only select repositories* → the one repo that receives saves.
4. **Repository permissions**: **Contents → Read and write**. Nothing else. (`Metadata:
   Read-only` is added automatically and is required.)
5. Short expiry, generate, copy once.
6. Put it in `GITHUB_TOKEN` in your shell or in Render's environment settings — never in
   the repo.

If the organisation requires approval for fine-grained tokens, an owner has to approve it
before commits succeed.

---

## Deploying on Render

`render.yaml` is a ready blueprint: Node runtime, `npm ci && npm run build`, `npm start`,
health check on `/health`.

1. Push this repository to GitHub.
2. Render dashboard → **New** → **Blueprint** → pick the repository → **Apply**.
3. In the service's **Environment** tab add `OPENROUTER_API_KEY` (optional) and
   `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` (optional). They are `sync: false` in the
   blueprint so they are never stored in git. Render injects `PORT` automatically.

The blueprint targets the `frankfurt` region — change it if you want to be elsewhere.

On the free plan, instances sleep when idle and restart cold. Because rooms live in memory,
a restart empties them: fine for a retro you run in one sitting, worth knowing before you
leave a room open overnight. Empty rooms are swept after 15 minutes, idle ones after 8 hours.

---

## Tests

```bash
npm test
```

91 tests, no network access and no real commits or completions:

| File | Covers |
|------|--------|
| `tests/rooms.test.ts` | Room creation, codes, facilitator assignment, duplicate names, room limit, spawn spread, reconnect, sweeping. |
| `tests/generate.test.ts` | Topic clustering, fallback level and characters, AI output sanitising (clamping, invented sources, good-topic-as-enemy, enemy caps), fallback on failure, key never leaking into an error. |
| `tests/game.test.ts` | Lock thresholds, switching targets, one fight at a time, power-up collection, attack point accounting, resolution, abandon, summary. |
| `tests/validation.test.ts` | HTML defusing, length caps, control characters, clamps, check-in/topic/treatment validation. |
| `tests/snapshot.test.ts` | Snapshot contents, anonymity, path traversal in the room code, filename and commit message. |
| `tests/socket.test.ts` | Real Socket.IO round trips: joining, duplicate names, rejoin, facilitator-only actions, topic privacy, the full forge→topics→level→resolve flow, **Markus-only save**, missing config, mocked GitHub commit and rejection. |

---

## Safety and reliability

* Every Socket.IO event is validated server-side: types, enum membership, id shape, length
  caps and permission checks. Ids are pattern-checked, so nothing can walk a path.
* Text is sanitised on the server and the client builds DOM nodes only — `innerHTML` is
  never used — so script injection has no surface, including for AI output.
* Rate limits per socket on joins, text and actions; per room on AI calls and saves.
* Movement is broadcast on a lightweight channel rather than a full state push, and
  positions are clamped to the map server-side.
* Connection status, disconnect markers on the map, automatic rejoin from `sessionStorage`,
  and every failure surfaced as a toast rather than silence.

## Project layout

```
src/shared/    types and constants used by both sides
src/server/    state, game rules, validation, sockets, generation, OpenRouter, GitHub
src/client/    browser TypeScript, one module per screen
public/        index.html, styles.css, favicon.svg (+ public/js after a build)
tests/         Vitest suites
```

MIT licensed. Have a good raid.
