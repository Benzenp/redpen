---
name: redpen
description: >
  Open a local page as a Redpen visual-annotation session, wait for the user
  to draw color-coded instruction groups on it, then read the submitted task
  (screenshots, marks, DOM grounding hints) to plan or implement changes.
license: MIT
---

# Redpen

Redpen turns a user's visual markup of a running local page into a
structured task an agent can act on. It never interprets images or writes
code itself — it only produces the task bundle.

## When to use this skill

Use it when the user says things like:

- "이 페이지 수정할 거야. Redpen 열어봐."
- "Open Redpen on this page so I can mark what I want changed."
- "I submitted a Redpen task, can you check it?"

Do **not** use it for requests that already fully specify the change in
text — Redpen is for visual/spatial intent that is hard to describe in
words.

## Golden flow

```text
User: 이 페이지 수정할 거야. Redpen 열어봐.
Agent: confirm the target is a running localhost/127.0.0.1 URL
Agent: if the target is already running, redpen_start_session(url,
       workspace_root); for this repository's demo, run
       `node fixtures/demo-app/redpen-session.mjs` instead so one process owns
       the target server, Redpen session, and cleanup watcher
User: navigates, freezes the screen, draws N instruction groups, submits
Agent: redpen_wait_for_submission(session_id) — or, if the host's tool
       timeout is shorter than the user needs, poll redpen_get_task later
Agent: redpen_get_task(task_id) — read groups, marks, DOM targets, source/
       annotated screenshots, overlay.svg
Agent: for each Instruction Group, summarize intent + likely source
       location(s) using the DOM target's selectorHints/context as a lead,
       not a guarantee
Agent: present a concise intent confirmation: "제가 이해한 변경은
       1) ... 2) ... 입니다. 이 의도가 맞나요?"
User: explicitly confirms or corrects the interpretation
Agent: only after confirmation, set state to working and implement
Agent: set state to review; Redpen reloads and focuses the still-open target
       page so the user sees the updated code
User: accepts the reviewed result
Agent: set state to done, close the session, stop the daemon when no other
       Redpen session is active, and stop every target-server process the
       agent started for this session
```

## Tools

- `redpen_start_session(url, workspace_root?, viewport?)` — opens a session;
  returns `{ session }`. `url` MUST be `localhost`/`127.0.0.1`; anything else
  is rejected.
- `redpen_wait_for_submission(session_id, timeout_seconds?)` — long-polls for
  the user's submission. A timeout is **not** an error: it returns
  `{ taskId: null, session }` and the session stays open. Re-call this or
  `redpen_get_task` later; never treat a timeout as failure.
- `redpen_get_task(task_id, workspace_root?)` — returns the full task bundle:
  `frames`, `groups`, `marks`, `targets`, asset paths (`source.png`,
  `annotated.png`, `overlay.svg`), and any `globalNote`.
- `redpen_update_task(session_id, state)` — advances session state as work
  progresses: `state: "working"` when you start implementing, `"review"`
  when a build is ready to look at, `"done"` when the user has accepted it.
- `redpen_open_review(session_id, url?)` — alias for
  `redpen_update_task(session_id, "review")`.
- `redpen_cancel_session(session_id)` — cancels a session that is no longer
  needed.

## Required lifecycle cleanup

A Redpen run is not complete when its task merely reaches `done`. The agent
MUST clean up every runtime resource it owns so the same host session can
start Redpen again without stale ports or orphaned processes.

- When the agent starts the target app, it MUST record the managed job/process
  handle and listening port. A target app that was already running belongs to
  the user and MUST NOT be stopped.
- For this repository's demo, use
  `node fixtures/demo-app/redpen-session.mjs` rather than separately starting
  `pnpm demo` and `redpen open`. The managed runner opens Redpen itself and
  owns the static server in the same process.
- Prefer launching the actual server executable directly. Do not rely on
  cancelling a package-runner parent such as `pnpm` or `npm`: on Windows its
  Node child can survive as an orphan. If a wrapper is unavoidable, terminate
  and verify the complete owned process tree.
- At session launch, install an ownership watcher for an agent-started target
  server. Closing the dedicated Chromium window shuts down the Redpen daemon;
  the watcher MUST treat that daemon/browser exit as a cleanup event and stop
  the owned target-server process tree immediately.
- After the user accepts a review, perform this sequence without waiting for
  another prompt:
  1. advance the session to `done`;
  2. close the session with an atomic idle shutdown
     (`redpen close <session-id> --shutdown-if-idle` when using the CLI), so
     the daemon stops only when it has no other open target page;
  3. if atomic idle shutdown is unavailable, stop the daemon only after
     confirming no other Redpen session is active;
  4. cancel submission waiters and other Redpen background jobs;
  5. stop the complete process tree of every target server started by the
     agent for this session.
- Cancellation and unexpected Chromium closure use the same cleanup sequence,
  except that an already-exited daemon needs no additional stop command.
- Before reporting completion, verify that the owned target port is no longer
  listening, the daemon discovery record is gone, and no owned background job
  or child process remains.

## Reading a task bundle

- `task.groups[]` — each has a `number`, `color`, optional `note`, and
  `markIds`/`targetIds`. Treat the group **number** as the identity, not the
  color (docs/PRODUCT_INTENT.md §5.4).
- `task.marks[]` — vector shapes (freehand/arrow/rectangle/ellipse/text/mask)
  with `bounds` in the frame's CSS pixel space.
- `task.targets[]` — DOM grounding hints. `selectorHints` are **not**
  guaranteed-executable selectors; they are code-search clues, ordered
  test-id → stable-id → role/name → structural. Ranking is preserved —
  multiple similar candidates are not collapsed into one, so check more than
  the first hint when the top one doesn't match anything in the codebase.
- `task.globalNote` and each group's `note` carry the user's own words —
  treat these as the primary signal; DOM targets are supporting context, not
  the source of truth.
- `task.groups[].referenceIds` links up to three reference images to that
  Instruction Group. Resolve each ID through `task.references[]` and open its
  task-relative `path`; references are visual context only and are never
  canvas marks or requested pixel placement by themselves.
- A group with no `targetIds` is valid: `docs/ARCHITECTURE.md` explicitly
  keeps a mark without a matched element (e.g. a sketch of a brand-new
  component in blank space).

## Default behavior: plan only

Submission is never implementation approval by itself. After every submitted
task, summarize the interpreted intent (one entry per Instruction Group:
requested result, source/DOM lead, and any ambiguity) and ask the user to
confirm it. Do not claim the task, edit product files, or run mutating commands
until that confirmation arrives, even when the user originally said they want
the eventual fix. Once confirmed, implement without asking for a second
permission.

## Setup

- Codex CLI/IDE: run `scripts/install-codex.sh` (or `.ps1` on Windows) from
  this skill's directory, or copy `SKILL.md` into your Codex skills
  directory manually.
- Claude Code: run `scripts/install-claude.sh` (or `.ps1`), or copy
  `SKILL.md` into `.claude/skills/redpen/`.
- Either host: the skill assumes a `redpen` CLI is on `PATH` (or reachable
  via the workspace's `apps/cli`) and calls `redpen mcp` to start the stdio
  MCP server; hosts configure this as an MCP server entry pointing at that
  command.
