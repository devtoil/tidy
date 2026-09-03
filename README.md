# tidy

Send feedback to a Claude Code session **from the page you're looking at** — a
comment, the exact DOM element you clicked, a dragged region, and a screenshot.

The CLI installs globally, the extension runs on any origin, and the collector
stores items in `~/.tidy`, so any agent session on the machine can read them.
It is not tied to any one project or framework.

```
 browser (extension or bookmarklet)          your terminal / Claude session
 ┌───────────────────────────────┐           ┌──────────────────────────────┐
 │ pick element / drag region    │  POST     │ tidy serve  (collector)│
 │ comment + screenshot          │ ────────► │ ~/.tidy/inbox/*.json   │
 └───────────────────────────────┘ :7787     │ tidy mcp  → Claude      │
                                             └──────────────────────────────┘
```

## Install

```bash
npm i -g github:devtoil/tidy
tidy serve                # collector + setup page on http://127.0.0.1:7787
```

`tidy` is taken on npm, so this installs from GitHub. Note that macOS ships
`/usr/bin/tidy` (HTML Tidy); a global install shadows it.

Zero runtime dependencies; Node 20+.

### Chrome extension (recommended — it's the only path that can screenshot)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → the `extension/` folder (`tidy extension` prints the path)
3. Press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> on any page, or click the toolbar icon

The icon has no popup — clicking it opens the overlay on the current tab
directly. Endpoint and channel settings live in the extension's options page,
reachable from the ⚙ in the overlay (or right-click the icon → Options).

The extension asks only for `activeTab`, `scripting` and `storage` — no
"read your data on all websites" warning. Nothing is injected into a page until
you invoke it, and the injection lasts for that tab only.

### Bookmarklet (no install)

Open <http://127.0.0.1:7787/> and drag **Send feedback** to your bookmarks bar.
Works anywhere, including browsers where you can't install extensions.
Bookmarklets can't reach Chrome's capture API, so those items carry the comment
and full element metadata but no image.

## Using it

<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> — or a click on the toolbar icon —
drops you straight into a comment box with the whole viewport already attached.
Type, <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd>, done — pointing at something specific
is optional, never a prerequisite.

```
● my-app · fix/layer-editor  [Pick element ⌥E] [Region ⌥R] [Whole page ⌥P]  ⚙ ✕
```

The toolbar leads with the session your feedback is headed for, so you can tell
at a glance where it will land. The label comes from the collector's `/health`,
derived from the directory and git branch of the Claude Code session hosting it
(override with `TIDY_SESSION_NAME`).

The dot is also a reachability light: green when
the collector answered, red when it didn't — so a collector that isn't running
shows up before you've typed a comment rather than after you hit Send.

Note that the collector is bound by whichever session claimed the port first, so
that is the session named — a second session sharing the inbox is not shown.

| Mode | What it captures |
|---|---|
| **Pick element** | Hover highlights, click selects. Selector, accessible name, custom-element ancestors, classes, `data-*`/aria attributes, computed styles, `outerHTML`, box geometry, plus a screenshot cropped to that element. |
| **Region** | Drag a rectangle — for "this whole area is wrong" and for things that aren't one element (spacing, overlap, z-order). |
| **Whole page** (default) | Just a comment against the current URL, with a full-viewport screenshot. |

Each mode has a hotkey — <kbd>⌥E</kbd>, <kbd>⌥R</kbd>, <kbd>⌥P</kbd> — that works
while you are typing, so you never have to reach for the mouse. Switching to a
picker uncovers the page and **keeps whatever you have already written**, so the
natural order is: type the complaint, then point at the thing.

Every item also carries the URL, title, viewport size, scroll position, device
pixel ratio, and any console errors seen since the overlay loaded.
<kbd>Esc</kbd> backs out; <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> sends.

## Reading feedback in a Claude Code session

Add the MCP server to your project's `.mcp.json` (already done in this repo):

```json
{
  "mcpServers": {
    "tidy": { "command": "tidy", "args": ["mcp"] }
  }
}
```

`tidy mcp` also binds the collector, so the MCP entry alone is enough —
no separate `serve` needed. If the port is already taken, it reads the same
file-backed inbox as whoever owns it, so several sessions can share one browser.

| Tool | Use |
|---|---|
| `feedback_list` | What's waiting |
| `feedback_get` | One item in full — the screenshot comes back as an inline image |
| `feedback_wait` | Block while the user walks the app and comments |
| `feedback_resolve` | Mark it handled once you've acted on it |

Or from the terminal:

```bash
tidy list           # pending items
tidy show <id>      # one item in full
tidy watch          # stream them as they land
tidy resolve <id> "fixed the alignment"
```


## Menu bar (macOS)

`tidy menubar` renders the inbox in [SwiftBar](https://swiftbar.app) or
[xbar](https://xbarapp.com) — collector status, which session is listening, and
the pending items, without a terminal.

```bash
tidy menubar --install ~/Library/Application\ Support/xbar/plugins
```

```
◉ 2
---
my-app · fix/layer-editor
Open setup page
---
2 pending
empty state has no copy
  Show / Resolve / open the page
save button is misaligned
  Show / Resolve / open the page
```

Each item can be shown or resolved from the menu. The session name comes from
the collector over `/health` (the plugin runs from the menu-bar host's directory,
not the session's), while pending items are read straight off disk — so the menu
still lists queued work when the collector is down.

## Roadmap

- **React Native** — an in-app dev-only overlay, so a tap identifies a component
  rather than a DOM node. The one unknown is spiked in
  [`docs/plans/react-native-spike.md`](docs/plans/react-native-spike.md).

## Deployed sites

localhost and 127.0.0.1 (any port) are allowed out of the box. To comment on
staging or production, allow that origin once:

```bash
tidy allow https://app.example.com   # then restart the collector
```

The collector binds to 127.0.0.1 only, and answers Chrome's Private Network
Access preflight so an `https://` page can reach it.

**Feedback is untrusted input.** The comment and page content are written by
whoever controls the page, so the MCP tools label them as data, not
instructions. Treat a feedback item the way you'd treat a bug report from a
stranger: read it, verify it against the codebase, then act.

## Tests

```bash
npm i -D playwright-core
npm test
```

Drives a real Chromium through both paths — overlay picking, region drag,
escape handling, click suppression, metadata capture, and the loaded extension's
inject → capture → crop → POST pipeline. Skips cleanly if Chromium or
playwright-core is missing.
