# Redpen

Redpen is a local-first visual feedback tool for coding agents. It opens a localhost app in Chromium, captures the exact screenshot and DOM state, and lets a user attach structured instructions directly to the interface.

The agent receives a self-contained task bundle containing screenshots, vector marks, DOM targets, notes, and group-specific reference images.

## Highlights

- Pixel-accurate screenshot and DOM capture from the same browser state
- Multiple color-coded instruction groups (`#1`, `#2`, ...)
- Select/Move, pen, arrow, straight line, rectangle, ellipse, bounded text, adjustable-opacity mask, and eraser tools
- Up to three pasted or drag-and-dropped reference images per instruction group
- Reference images stay in the right sidebar and are never stamped onto the screenshot
- Modal-aware capture and DOM grounding
- Agent intent-confirmation gate before implementation
- Automatic target-page refresh when a change enters review
- CLI and MCP interfaces backed by the same daemon
- English UI by default with a persistent Korean language switch
- Readable Windows 3.1 Paintbrush-inspired chrome with a docked toolbox,
  functional menus, group palette, and status bar
- Local workspace storage only; no database or cloud service

## Workflow

```text
Agent opens a Redpen session
→ User navigates the target app
→ User presses F9 to freeze the current state
→ User draws instructions and attaches references
→ User submits
→ Agent summarizes its interpretation
→ User confirms or corrects the interpretation
→ Agent implements the confirmed change
→ Redpen reloads and focuses the target page for review
```

Submission is not implementation approval. The task remains `submitted` until the user confirms the agent's interpretation.

## Requirements

- Node.js 20 or newer
- Corepack
- A target app served from `localhost`, `127.0.0.1`, or `::1`

Redpen installs its dedicated Playwright Chromium during package installation.

## Install

Install the latest GitHub release globally:

```bash
npm install -g https://github.com/Benzenp/redpen/releases/download/v0.2.0/redpen-cli-0.2.0.tgz
```

Verify the daemon:

```bash
redpen daemon start
redpen daemon status
redpen daemon stop
```

For a Vue/Vite project:

```bash
cd your-vue-project
npm run dev
redpen open http://localhost:5173 --project .
```

Run the dev server and `redpen open` in separate terminals. The Node daemon
runs as a hidden background process on Windows while Chromium remains visible.
Press **F9** in Chromium to capture and annotate the current page. Closing the
dedicated Chromium window automatically shuts down the Redpen daemon and
removes its discovery record.

## Run from source

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm demo
```

In another terminal:

```bash
corepack pnpm --filter @redpen/cli exec redpen open http://127.0.0.1:4173/
```

The Node daemon runs as a hidden background process on Windows. Chromium remains visible by default.

Press **F9** or use the in-page **Freeze screen** button to open the annotator.

## CLI

```bash
redpen daemon start
redpen daemon status
redpen daemon stop

redpen open <url> --project <workspace>
redpen list --project <workspace>
redpen status <session-id>
redpen freeze <session-id>
redpen wait <session-id> --timeout 600
redpen task <task-id> --project <workspace>
redpen claim <session-id>
redpen review <session-id>
redpen accept <session-id>
redpen cancel <session-id>
redpen close <session-id>
redpen mcp
```

Add `--json` for machine-readable output.

### Browser mode

Chromium is visible by default. For automated checks only:

```bash
REDPEN_HEADLESS=1 redpen open http://127.0.0.1:4173/
```

PowerShell:

```powershell
$env:REDPEN_HEADLESS = "1"
redpen open http://127.0.0.1:4173/
```

## Annotator

### Session UI

The annotator keeps the Windows 3.1 Paintbrush mood without sacrificing
readability:

- A navy title bar, menu bar, beveled controls, and sunken white input fields
- A docked two-column toolbox that never covers the screenshot
- A centered canvas with clear document boundaries and inactive-group dimming
- Window-style instruction cards with visible active state, mark count, notes,
  and reference-image drop zones
- A status bar showing the current tool, active group, clickable group colors,
  and zoom percentage
- File, Edit, View, and Help menus for discoverable actions and shortcuts
- English and Korean controls in the menu bar; Korean input surfaces retain
  antialiased text for readability

Click the zoom percentage or use **View → Fit to window** to restore the full
screenshot view. **Help → Keyboard shortcuts** opens the complete shortcut
reference inside the annotator.

### Instruction groups

Every mark belongs to one numbered group. A group contains:

- A fixed palette color
- Canvas marks
- An optional written note
- Up to three reference images
- Grounded DOM targets

Images can be pasted into the active group or dropped onto a specific group card. Submitted references are copied into the immutable task bundle.

### Text tool

Drag a rectangle to create a bounded text editor. Text wraps and clips inside that region and uses the current instruction-group color.
Click once for an immediately editable default text box. In Select/Move, double-click a text mark or select it and press Enter to edit it without changing its identity or group.

- `Ctrl/Cmd + Enter`: commit
- Blur: commit
- `Escape`: cancel

### Keyboard shortcuts

| Key | Tool |
| --- | --- |
| `V` | Select/move marks or a screenshot region |
| `P` | Pen |
| `A` | Arrow |
| `L` | Straight line |
| `R` | Rectangle |
| `O` | Ellipse |
| `T` | Text area |
| `M` | Mask |
| `E` | Eraser |
| `Delete` / `Backspace` | Delete selected marks |
| `Escape` | Cancel the current drawing or clear selection |
| `1`–`9` | Switch instruction group without changing tools |
| `N` | Create a new instruction group |
| Hold `Space` + drag | Pan the canvas |
| `+` / `-` | Zoom in / out |
| `0` | Fit the screenshot to the window |
| `F1` | Open the keyboard-shortcut dialog |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` | Redo |
| `Ctrl/Cmd + Enter` | Submit instructions (outside a text editor) |

### Select/Move

Select/Move is the default tool. It handles normal annotation marks and screenshot pixel moves through one interaction model:

- Click or Shift-click marks to select them.
- Drag selected marks to move them.
- Drag a corner handle to resize; hold Shift to preserve the original ratio.
- Drag blank screenshot space to create a region, then drag that region to create a cut/move patch.
- Existing patches move and resize without changing their source crop.
- Hold Shift while creating lines or arrows for 45° snapping, rectangles for squares, and ellipses for circles.

Inactive instruction groups remain visible at reduced opacity. Clicking one of their marks activates and focuses the corresponding group.

### Mask opacity

Choose Mask to reveal its compact opacity slider. New masks use the selected opacity; selecting existing masks before adjusting the slider updates them as one undoable action.

## Task bundle

Redpen writes submitted tasks under:

```text
<workspace>/.redpen/tasks/<task-id>/
├── task.json
├── frames/
│   └── frame-001/
│       ├── source.png
│       ├── annotated.png
│       └── overlay.svg
└── references/
    └── <reference-id>.png
```

`task.json` is the canonical contract. It contains frames, instruction groups, marks, reference metadata, DOM targets, selector hints, and revision state.

## Security model

- The daemon binds only to `127.0.0.1`.
- CLI/MCP bearer credentials are separate from browser capabilities.
- Browser capabilities are scoped per session and surface.
- Daemon identity uses an HMAC challenge-response probe.
- Request bodies, PNG bytes, image dimensions, and pixel counts are bounded.
- Discovery and reference metadata use owner-only, atomic storage.
- Workspace paths and managed reference files reject traversal and symlink/junction escapes.
- Target navigation is restricted to credential-free loopback HTTP(S) URLs.

## Development

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm -r run typecheck
corepack pnpm -r --if-present run test
corepack pnpm run build
```

Browser integration checks:

```bash
REDPEN_HEADLESS=1 corepack pnpm --filter @redpen/cli run test:lifecycle
REDPEN_HEADLESS=1 corepack pnpm --filter @redpen/cli run test:daemon-lifecycle
REDPEN_HEADLESS=1 corepack pnpm --filter @redpen/cli run test:review-loop
REDPEN_HEADLESS=1 corepack pnpm --filter @redpen/cli run test:ui-e2e
REDPEN_HEADLESS=1 corepack pnpm --filter @redpen/cli run test:patch-reference
```

## Build a release package

```bash
corepack pnpm run build
cd apps/cli
corepack pnpm pack
```

The tarball contains only the executable launcher, bundled CLI/daemon JavaScript, source maps, package metadata, and annotator assets. Internal workspace packages are bundled into the CLI artifact.

## Repository layout

```text
apps/
├── annotator/       Browser annotation UI
└── cli/             CLI, daemon, browser control, MCP server
packages/
├── annotator-core/  Mark store, SVG export, pixel compositing
├── grounding/       DOM collection and mark-to-element grounding
├── protocol/        Schemas, IDs, storage, references
└── review/          Revision, diff, diagnostics, retention
fixtures/
└── demo-app/        Deterministic manual/E2E target
skills/
└── redpen/          Shared agent workflow
```

## Status

Redpen is a production-packaged local developer tool at version `0.2.0`. The CLI package is ready to pack and publish; no external service is required.
