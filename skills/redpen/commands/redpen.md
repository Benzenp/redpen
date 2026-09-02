---
description: Open Redpen on the current local app, optionally at a route or exact localhost URL
argument-hint: "[route-or-local-url]"
---

Run the `redpen` skill for this project.

Requested target: `$ARGUMENTS`

Interpret the argument as follows:

- Empty: open the detected local app's root page (`/`).
- A path such as `/settings` or `customers/42`: resolve it against the detected local app origin.
- A complete `localhost`, `127.0.0.1`, or `::1` URL: open it exactly.

Detect the project's existing local dev server before starting another one. Prefer an explicitly configured `REDPEN_URL`, then a URL reported by the project's active dev command, then the single loopback HTTP server associated with this workspace. If several plausible servers remain, use project scripts and framework configuration to select the workspace server rather than guessing by port number.
Preserve a detected URL's protocol, host, port, and base path exactly. Never extract only its port and reconstruct it with `127.0.0.1`; `localhost` and `127.0.0.1` can have different cookies, host routing, and dev-server behavior.

Follow the skill's complete submission, confirmation, review, and owned-process cleanup lifecycle. Start the submission waiter immediately after opening Redpen. Do not treat submission as implementation approval.
