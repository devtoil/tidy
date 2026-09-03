# Spike: can tidy identify a React Native component from a tap?

**Status:** not started · **Timebox:** 30 minutes · **Output:** an answer, not code to keep

## The question

tidy's browser items are actionable because they carry structure — a CSS
selector, an accessible name, a custom-element ancestor chain. An agent can find
the code from that. A screenshot alone can't.

React Native has no DOM, so the question is whether an equivalent exists. If it
does, a mobile overlay is worth building. If it doesn't, mobile feedback degrades
to "a screenshot with a note", and the honest answer may be not to build it.

**Spike this before designing the overlay.** Everything else about the mobile
path (shake to open, `react-native-view-shot`, POSTing to the collector) is
routine; this is the only unknown, and it decides whether the feature has a point.

## What is already known

Verified against `ziptility-mobile` (RN 0.83.4, Expo ~55, React 19):

| | |
|---|---|
| ✅ | `@react-native/babel-preset` injects `@babel/plugin-transform-react-jsx-source` in dev — every JSX element carries `fileName` + `lineNumber` |
| ✅ | `__REACT_DEVTOOLS_GLOBAL_HOOK__` is present in the dev renderer |
| ✅ | `findNodeHandle` / `measureInWindow` still exist |
| ❌ | **`react-native/Libraries/Inspector` is gone in 0.83.** `getInspectorDataForViewAtPoint` — the obvious API for this — no longer exists; inspection moved to the C++/CDP DevTools backend |

So the removed-API route is closed, and the open question is whether the fiber
tree can be walked directly from a touch.

## The probe

In `ziptility-mobile`, in a dev build, on any screen:

1. Render a full-screen transparent `View` with `onStartShouldSetResponderCapture`
   so it sees the touch without swallowing it.
2. From the touch event take `event.target` (a host node handle/instance).
3. Get the renderer: `__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers` → the entry with
   `findFiberByHostInstance`.
4. Map the target to a fiber, then walk `fiber.return` upward, collecting for
   each frame: `type.displayName ?? type.name`, and whatever source field the
   React 19 build exposes.
5. `console.log` the chain.

## What decides it

Tap the Save button on a task screen. Success looks like:

```
TouchableOpacity
Button            app/components/Button.tsx:31
TaskDetailFooter  app/(app)/tasks/[id]/footer.tsx:88
TaskDetailScreen  app/(app)/tasks/[id].tsx:142
```

**PASS** — a named chain with at least one `file:line`. That is *better* than a
CSS selector: it names the file to open. Build the overlay.

**PARTIAL** — component names but no source. Still useful (a name is greppable).
Build it, and note the degradation in the item shape.

**FAIL** — no usable fiber walk. React 19 dropped `_debugSource` from fibers, and
the replacement may only be reachable from the DevTools backend over CDP rather
than in-process. Do not build the in-app overlay on this basis; fall back to
**accessibility label + `testID` + the expo-router route**, and decide separately
whether that thin a payload earns a feature.

The most likely failure is step 4: React 19 moved fiber debug fields. Check
`fiber._debugSource`, `fiber._debugOwner`, and `element._source` on the
corresponding element before concluding it is unavailable.

## Notes for whoever runs it

- Dev build only. `__DEV__` gates the whole thing; a release build must not carry
  the overlay or the DevTools hook access.
- Don't build UI. A `console.log` of the chain is the entire deliverable.
- Expo web is a shortcut worth remembering: `ziptility-mobile` has a `web/`
  target, and tidy's existing browser overlay already works there unmodified. It
  won't answer this question — Expo web renders to a real DOM — but it may cover
  some of the need without any of this work.

## If it passes

The overlay is then routine, and the item shape needs one additive change: a
`component` field beside the existing DOM-shaped `element` —
`{ name, source: { file, line }, chain[], accessibilityLabel, testID, frame }`.
`format.mjs` grows one branch. Nothing migrates. Transport is free:
`Constants.expoConfig.hostUri` already holds the dev machine's LAN address, which
is what a physical device needs to reach the collector.
