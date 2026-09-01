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
Agent: redpen_start_session(url, workspace_root)
User: navigates, freezes the screen, draws N instruction groups, submits
Agent: redpen_wait_for_submission(session_id) — or, if the host's tool
       timeout is shorter than the user needs, poll redpen_get_task later
Agent: redpen_get_task(task_id) — read groups, marks, DOM targets, source/
       annotated screenshots, overlay.svg
Agent: for each Instruction Group, summarize intent + likely source
       location(s) using the DOM target's selectorHints/context as a lead,
       not a guarantee
Agent: present an implementation plan; only modify files if the user has
       explicitly asked for the fix, not just for a plan
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
- A group with no `targetIds` is valid: `docs/ARCHITECTURE.md` explicitly
  keeps a mark without a matched element (e.g. a sketch of a brand-new
  component in blank space).

## Default behavior: plan only

Unless the user has explicitly asked you to implement the change, produce an
implementation plan (one entry per Instruction Group: intent, matched
code/DOM leads, ambiguity if any) and stop there. Only edit files when asked.

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
