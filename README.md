# Retro Raiders: The Blocker Dungeon

A cooperative retrospective **game** for a distributed dev team of roughly 6–8 people. Everyone
packs the dungeon with what happened during the sprint, the party explores it together, votes on a
final boss, and forges a couple of small experiments to weaken it before the next retro.

No database, no login, no paid services. Room state lives in server memory, the UI is plain
HTML/CSS with browser-side TypeScript, and the whole thing is one repository you can zip, send to a
colleague and run.

```
Node.js 22 · TypeScript · Express · Socket.IO · vanilla DOM · Vitest
```

---

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:3000>, enter a name, press **Create a new dungeon**, and share the invite
URL from the lobby with the rest of the party. The first player in a room is the **facilitator**.

---

## The seven phases

| # | Phase | What happens |
|---|-------|--------------|
| 1 | **Choose an adventurer** | Everyone picks a cosmetic class (Debugger, Architect, Test Mage, Deployment Ranger, Product Bard, Refactor Paladin) and an energy level 1–5. The party energy is shown as a combined number, never as a per-person score. Classes have zero effect on voting power. |
| 2 | **Pack the dungeon** | Each player privately writes up to two **Loot**, two **Trap** and two **Monster** cards. Drafts stay editable until you press *Ready*. Others see *that* you are ready, never *what* you wrote. |
| 3 | **Reveal the dungeon** | All cards are shuffled and shown anonymously as treasure, hazard and enemy rooms. The facilitator can merge obvious duplicates; merging keeps every original wording inside the combined card. |
| 4 | **Explore** | Everyone gets three energy tokens: 1 = *this affected us*, 2 = *we should discuss this*, 3 = *this may be our boss*. Allocation updates live and stays changeable until totals are revealed (all players ready, or the facilitator reveals). Then the top cards are discussed one at a time with a configurable timer (pause, skip, +1 minute) and a shared live note field per card. |
| 5 | **Final boss** | The highest-rated Traps and Monsters form a shortlist. One anonymous vote per player; a tie triggers a runoff. The winner gets a humorous title generated locally from the card text — no external AI service is called. |
| 6 | **Forge the weapons** | Each player proposes one small experiment (title, description, observable sign it helped, optional owner, review date). Vague titles such as “communicate better” are rejected, and a title plus an observable outcome are required. Points are distributed privately, then revealed together, and the top one or two experiments are selected. The facilitator can polish the final wording, synchronised live. |
| 7 | **Victory screen** | Participants, average starting energy, collected loot, the most relevant traps and monsters, discussed cards with their notes, the boss, the chosen experiments, owners and review dates — plus confetti that switches itself off under `prefers-reduced-motion`. |

The facilitator can always move **back one phase** to reopen something, and can reset the game
behind a confirmation dialog.

### Note on the ten forge points

The brief says “the team receives ten shared forge points, each player privately distributes their
share.” This implementation gives **every player a private budget of 10 points** to spread across
the proposals; on reveal the budgets are summed into one shared ranking. That keeps allocation
private until the reveal without needing a turn order.

---

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Watches the browser TypeScript (`tsc --watch` into `public/js/`) and runs the server with `tsx watch`. |
| `npm run build` | Compiles the client into `public/js/` and the server into `dist/`. |
| `npm start` | Runs the compiled server (`node dist/server/index.js`). Run `npm run build` first. |
| `npm test` | Runs the Vitest suite once. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run typecheck` | Type-checks both the server and the browser build without emitting. |
| `npm run clean` | Removes `dist/` and `public/js/`. |

The server binds to `process.env.PORT` (default `3000`) and `process.env.HOST` (default
`0.0.0.0`). `GET /health` returns status, room count and uptime as JSON.

---

## Environment variables

Copy `.env.example` if you want a local reference. The server reads **real environment
variables**; there is no dotenv dependency. To load a file locally, use Node's built-in flag:

```bash
npm run build
node --env-file=.env dist/server/index.js
```

| Variable | Required | Meaning |
|----------|----------|---------|
| `PORT` | no | HTTP port. Render sets this for you. |
| `HOST` | no | Bind address, default `0.0.0.0`. |
| `GITHUB_TOKEN` | only for saving | Fine-grained token with **Contents: Read and write**. |
| `GITHUB_OWNER` | only for saving | User or organisation that owns the target repo. |
| `GITHUB_REPO` | only for saving | Repository that receives the JSON snapshots. |
| `GITHUB_BRANCH` | no | Branch to commit to, defaults to `main`. |

If any of the three required GitHub variables are missing the game keeps working normally; Markus
simply sees a precise message naming the missing variables plus a **Download JSON** button.

---

## Saving the retro to GitHub

A player whose name is exactly `Markus` (case-sensitive) sees **Save retro to GitHub** on the
victory screen. On click the server:

1. builds a clean JSON snapshot in memory (no socket IDs, no internal connection data, and never
   the author of an anonymous card),
2. commits it through the GitHub Contents API to
   `retro-saves/retro-raiders/YYYY-MM-DD_HH-mm_room-CODE.json` (UTC timestamp plus room code, so
   repeated saves never overwrite each other),
3. reports success **only** when GitHub confirms the commit, and returns the resulting file URL.

Repeat clicks are disabled while a save is in flight, saves are rate limited per room, and the
token is never sent to the browser or written to logs (it is scrubbed from error messages too).
Nothing is written to Render's filesystem — the repository is the persistence layer.

The snapshot contains the app name, schema version, room code, creation and completion timestamps,
participant names, the energy summary, loot/traps/monsters with merged-card details, aggregate
token allocations, discussion notes, the final boss, the selected experiments, owners and review
dates.

### ⚠️ This is not authentication

The name check is **lightweight team-level permission, not security**. The browser hides the
button for everybody else and the server re-verifies that the requesting socket currently belongs
to the room *and* that its player name is exactly `Markus` — but anyone who can reach the room and
types `Markus` as their name before someone else does would pass that check. It is a guardrail for
a trusted team, comparable to a "please don't press this" label. If you need real control, put the
app behind SSO or an authenticating reverse proxy.

### Creating the fine-grained token (minimum permission)

1. GitHub → your avatar → **Settings** → **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token**.
2. **Resource owner**: the account or organisation that owns the target repository.
3. **Repository access**: *Only select repositories* → pick the one repository that should receive
   the snapshots.
4. **Repository permissions**: set **Contents** to **Read and write**. Leave everything else on
   *No access*. (`Metadata: Read-only` is added automatically and is required.)
5. Set a short expiry, generate, copy the token once.
6. Put it in `GITHUB_TOKEN` in your shell or in Render's environment settings — never in the repo.

If the organisation requires approval for fine-grained tokens, an owner has to approve it before
commits succeed.

---

## Deploying to Render

`render.yaml` is a ready blueprint: Node runtime, `npm ci && npm run build`, `npm start`, health
check on `/health`.

```bash
# 1. push the repository to GitHub first (see below)
# 2. Render dashboard → New → Blueprint → pick the repository → Apply
```

Then in the service's **Environment** tab add `GITHUB_TOKEN`, `GITHUB_OWNER` and `GITHUB_REPO`
(and `GITHUB_BRANCH` if you do not use `main`). They are marked `sync: false` in the blueprint so
they are never stored in git. Render injects `PORT` automatically.

Note on the free plan: instances sleep when idle and restart cold. Because rooms live in memory, a
restart empties them — fine for a retro you run in one sitting, worth knowing before you leave a
room open overnight. Empty rooms are swept after 15 minutes, idle rooms after 8 hours.

---

## Tests

```bash
npm test
```

65 tests across six files, no network access and no real commits:

| File | Covers |
|------|--------|
| `tests/rooms.test.ts` | Room creation, codes, independent rooms, facilitator assignment, duplicate-name rejection (case-insensitive), reconnect, room sweeping. |
| `tests/game.test.ts` | Phase transitions forward and back, card building, anonymity of card IDs, token budget, merging duplicates, discussion ordering and timer, shortlist, boss ties and runoffs, forge allocation, reset. |
| `tests/snapshot.test.ts` | Snapshot contents, anonymity guarantees, filename generation, commit message. |
| `tests/github.test.ts` | Missing and partial configuration, default branch, create vs. update, rejected commits, token scrubbing, network failure. |
| `tests/validation.test.ts` | HTML/script defusing, length limits, control characters, type guards, experiment validation including vague-title rejection. |
| `tests/socket.test.ts` | Real Socket.IO round trips: joining, duplicate names over the wire, facilitator-only actions, payload validation, **Markus-only save authorization**, missing configuration, and a mocked GitHub commit. |

---

## How anonymity is protected

* Card IDs are `sha256(roomSecret + playerId + category + index)` truncated — stable across a
  reopened packing phase, but not reversible to a player.
* The per-player state sent over the socket contains authorship for nobody, not even yourself
  beyond your own draft.
* The saved JSON contains participant names (they are in the room anyway) but never links a name to
  a card, a token allocation or a vote.

## Safety and reliability

* Every Socket.IO event is validated server-side: types, enum membership, ID shape, length caps
  (220 characters per card, 600 per note) and permission checks.
* Text is sanitised on the server (control characters stripped, `<`/`>` neutralised) and the client
  builds DOM nodes only — `innerHTML` is never used — so script injection has no surface.
* Rate limits per socket on joining, text edits and actions, and per room on saving.
* Connection status, per-player disconnect markers, automatic rejoin from `sessionStorage`,
  confirmation before a reset, clear empty states, and every failure surfaced as a toast.

## Project layout

```
src/shared/    types and constants used by both sides
src/server/    state, game rules, validation, sockets, snapshot, GitHub client
src/client/    browser TypeScript, one module per phase view
public/        index.html, styles.css, favicon.svg (+ public/js after a build)
tests/         Vitest suites
```

MIT licensed. Have a good raid.
