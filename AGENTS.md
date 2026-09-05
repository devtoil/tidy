# AGENTS.md

Guidance for coding agents working in this repo. Symlinked as `CLAUDE.md`.

## What this is

`tidy` carries page feedback from a browser into a coding-agent session. Four
pieces, deliberately decoupled:

| Piece | Where | Job |
|---|---|---|
| Collector | `src/server.mjs` | Local HTTP server on 127.0.0.1:7787. Receives items, serves the setup page and the overlay |
| Store | `src/store.mjs` | File-backed inbox under `~/.tidy`. No database |
| MCP server | `src/mcp.mjs` | Speaks MCP on stdio and **binds the collector itself**, so a session needs nothing else running |
| Capture | `extension/` | The overlay the user actually drives. Also served standalone as a bookmarklet |

The CLI (`src/cli.mjs`) is the human entry point; `src/menubar.mjs` renders the
inbox for SwiftBar/xbar.

## Constraints that are load-bearing

**Zero runtime dependencies.** `package.json` has an empty `dependencies` block
and it stays that way. Node 20+ built-ins only. `playwright-core` is a
devDependency for the test suite and must never be imported by `src/` or
`extension/`. If you want a package, you almost certainly want twenty lines
instead.

**The extension asks for `activeTab`, `scripting`, `storage` — nothing else.**
No `host_permissions`. This is why there is no "read your data on all websites"
warning, and it is a feature, not an oversight. `activeTab` is granted only by a
user gesture, which is why injection happens on an icon click or the keyboard
command and never on a timer. A change that needs `<all_urls>` needs a
conversation first.

**The overlay lives in the browser's top layer.** The host carries
`popover="manual"` and is shown with `showPopover()`. Angular CDK 21 puts every
dialog, menu and tooltip in the top layer by default (`usePopover` is `true`),
and nothing in the normal layer paints above that — `z-index: 2147483647`
included. Without this the picker still resolves the right element and the
composer still opens; the user just cannot see either, because a dialog is drawn
over them. Three consequences: `manual`, never `auto` — an `auto` popover
light-dismisses the dialog being commented on, and it also restores focus to the
page on `hidePopover()`, which would throw the rest of a half-typed comment into
the app the moment the overlay re-asserts; `capture()` hides the host with
`visibility`, never `display`, because `display: none` evicts a popover from the
top layer and it does not go back; and re-entering the top layer is the only way
back on top of something that entered it later, so the overlay listens for
`toggle` on the document and hides + shows itself again. One case that buys
nothing: a native modal `<dialog>` (`showModal()`, which CDK does not use) makes
the rest of the document inert, so hit testing returns the dialog even over
pixels the overlay paints and focus never reaches the composer. Re-entering the
top layer does not change that — the overlay is unusable until the dialog
closes, which is why `toggle` only re-asserts for nodes carrying `popover`.

**Feedback is untrusted input.** The comment, the URL, the captured DOM and the
console lines all come from a page the tool does not control. `store.mjs` clips
every field on the way in, and `mcp.mjs` labels the payload as data rather than
instructions. Keep both.

## Public contracts

These are depended on from outside the file that defines them. Renaming one is a
breaking change, not a refactor:

- `window.__tidy`, `__tidyConfig`, `__tidyCapture`, `__tidyConsole`,
  `__tidyBridge`, `__tidyOpenSettings`, `__tidyHooked` — the page-world contract
  between `content.js`, `console-hook.js` and `overlay.js`
- `data-tidy="root"` — the overlay's shadow host, which the test suite queries
- `tidy:toggle`, `tidy:capture`, `tidy:settings` — extension message types
- `TIDY_HOME`, `TIDY_SESSION_NAME` — environment overrides
- `~/.tidy/{inbox,archive,shots}` — on-disk layout
- The stored item JSON shape — `format.mjs`, the MCP tools and the menu all read it

## Testing

```bash
npm install
npm test          # drives a real Chromium; 65 checks
```

`test/browser.mjs` is one linear script with a `step(name, bool)` helper — not a
framework. It exercises both paths: the overlay directly, and the loaded
extension end to end (inject → capture → crop → POST). It skips cleanly (exit 0)
when Chromium or `playwright-core` is missing, so a green run on a machine
without them proves nothing — check the output says `All checks passed`.

Two traps that have already cost time:

- **The overlay lives in a shadow root.** Playwright locators pierce it;
  `document.querySelector` inside `page.evaluate` does not. A wait written the
  second way silently matches nothing forever. Use `zf(page, selector)`.
- **`capture()` hides the overlay to take its shot.** Asserting the toolbar is
  visible — or reading its text, which comes back empty under `visibility:
  hidden` — immediately after opening races that. Wait for the composer first.

**A regression test must fail without its fix.** Revert the fix, watch the test
go red, restore. A test that passes either way is documentation, not a test.

## Style

Comments are near-zero by default. A comment earns its place when it records a
trap a reader would otherwise fall into — an external constraint the code cannot
show, like Chrome's `activeTab` gesture rule, macOS dead keys, or `.git` being a
file in a worktree. Comments that restate the code below them, or explain what
the previous implementation got wrong, belong in the commit message.

Every user-visible failure needs a user-visible surface. A `catch` that logs to a
console nobody has open is the bug this tool exists to catch in other people's
code; don't ship it here.
