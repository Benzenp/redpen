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
code itself; after intent confirmation, the coding host executes the task
through isolated Redpen candidate worktrees.

## When to use this skill

Use it when the user says things like:

- "이 페이지 수정할 거야. Redpen 열어봐."
- "Open Redpen on this page so I can mark what I want changed."
- "I submitted a Redpen task, can you check it?"

Do **not** use it for requests that already fully specify the change in
text — Redpen is for visual/spatial intent that is hard to describe in
words.

## Slash invocation

Claude Code users invoke this skill through the installed command:

```text
/redpen
/redpen /customers/42
/redpen http://127.0.0.1:5173/settings
```

An empty argument targets the current local app's root page. A relative path
is resolved against the detected local app origin, and a complete loopback URL
is used exactly. Resolve the base origin in this order:

1. an explicit `REDPEN_URL`;
2. the URL reported by the workspace's already-running dev command;
3. the single loopback HTTP server associated with this workspace;
4. the workspace's framework/dev-server configuration.

Never choose an unrelated listener merely because it uses a common port. If
discovery reports a complete URL, preserve its protocol, host, port, and base
path verbatim; do not extract only the port and rebuild the URL as
`http://127.0.0.1:<port>`. `localhost` and `127.0.0.1` are not interchangeable
for cookie, host-header, and dev-server routing behavior. If
the workspace server is not running, start the project's existing dev script
as an owned process and apply the required lifecycle cleanup below. Start the
submission waiter immediately after opening the session.

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
Agent: only after confirmation, call redpen_prepare_execution(task_id,
       workspace_root). It enters working state after creating the run and
       worktrees. Preparation alone is not implementation and MUST be followed
       through.
Agent: read the returned run tasks and candidate worktree paths. The coding
       host MUST delegate one subagent per returned candidate worktree when
       host-native delegation is available. Each subagent receives only its
       VisualTask instruction group and edits only that worktree — never the
       parent worktree.
Agent: if host-native delegation is unavailable, use
       redpen_start_candidate_agent for each candidate with the configured
       external agent command, then redpen_wait_execution_process. Its command
       and args can use {instruction}, {worktree}, {runId}, {taskId}, and
       {candidateId}; Redpen expands them before launch.
Agent: run candidate-specific verification in its candidate worktree, then
       redpen_finalize_candidate(run_id, task_id, candidate_id,
       commit_message, verification_commands, remote) for every candidate.
       This verifies, commits, pushes, and remote-verifies; do not treat a
       local uncommitted edit as a completed candidate.
Agent: select the finalized default candidate for each task with
       redpen_select_candidate. For an explicitly requested alternative UI
       approach only, call redpen_add_candidate on that instruction task,
       finish and finalize each candidate, then use
       redpen_start_candidate_comparison with per-candidate server
       commands/URLs for interactive CDP review.
Agent: call redpen_start_preview with the selected included task ids and the
       project's preview command, args, and URL. It builds the integrated
       branch, starts and readiness-checks an owned server, opens it, and
       transitions the originating session to review.
User: accepts the reviewed result
Agent: call redpen_publish_execution(run_id, workspace_root,
       included_task_ids, target_branch, remote) for only accepted/included
       tasks. It assembles cleanly, fast-forward merges, pushes, verifies the
       remote result, transitions the originating session to done, closes it,
       and cleans up every managed Redpen execution process.
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
- `redpen_prepare_execution(task_id, workspace_root?, base_ref?,
  candidates_per_task?)` — turns VisualTask groups into a run, tasks, and
  isolated candidate worktrees. This is setup, not implementation.
- `redpen_add_candidate(run_id, task_id, workspace_root?)` — adds one isolated
  alternative implementation worktree to a specific task.
- `redpen_start_candidate_agent(run_id, task_id, candidate_id, command, args,
  env?, workspace_root?)` — fallback managed external-agent runtime. It
  expands `{instruction}`, `{worktree}`, `{runId}`, `{taskId}`, and
  `{candidateId}` in `command` and `args`.
- `redpen_get_execution_process(run_id, process_id)`,
  `redpen_wait_execution_process(run_id, process_id)`, and
  `redpen_stop_execution_process(run_id, process_id)` — inspect, wait for,
  or stop managed agents/servers.
- `redpen_finalize_candidate(run_id, task_id, candidate_id, commit_message,
  verification_commands?, remote?, workspace_root?)` — verification, commit,
  push, and remote verification for one candidate.
- `redpen_select_candidate(run_id, task_id, candidate_id, workspace_root?)`
  — picks the finalized candidate to include for a task.
- `redpen_start_preview(run_id, command, args, url, workspace_root?,
  included_task_ids?, env?, ready_timeout_ms?)` — builds the selected
  integration and owns its preview server.
- `redpen_start_candidate_comparison(run_id, candidates, workspace_root?)` —
  owns per-candidate servers and opens an interactive CDP comparison review.
- `redpen_publish_execution(run_id, workspace_root?, included_task_ids?,
  target_branch?, remote?)` — clean final assembly, fast-forward merge, push,
  and remote verification.

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
- Stop every process returned by `redpen_start_candidate_agent`,
  `redpen_start_preview`, or `redpen_start_candidate_comparison` with
  `redpen_stop_execution_process` once its review or execution purpose is
  complete. Do not stop user-owned processes.
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

## Confirmation and execution boundary

Submission is never implementation approval by itself. After every submitted
task, summarize the interpreted intent (one entry per Instruction Group:
requested result, source/DOM lead, and any ambiguity) and ask the user to
confirm it. Do not claim the task, prepare execution, edit product files, or
run mutating commands until that confirmation arrives, even when the user
originally said they want the eventual fix. Once confirmed, complete the
isolated candidate lifecycle above without a second permission; never directly
implement in the parent worktree.

## Setup

- Claude Code: run `redpen install --host claude --project <workspace>`. This
  installs the skill, the `/redpen` command, and the MCP entry while preserving
  unrelated project MCP configuration.
- Codex CLI/IDE: run `redpen install --host codex`; invoke the installed skill
  as `$redpen`.
- Use `redpen install --host all --project <workspace>` to configure both.
- Either host: the skill assumes a `redpen` CLI is on `PATH` (or reachable
  via the workspace's `apps/cli`) and calls `redpen mcp` to start the stdio
  MCP server; hosts configure this as an MCP server entry pointing at that
  command.
