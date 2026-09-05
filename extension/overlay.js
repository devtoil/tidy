/**
 * tidy overlay — shared by the Chrome extension (injected as a content
 * script) and the bookmarklet (fetched from the local collector).
 *
 * Host page contract:
 *   window.__tidyConfig  = { endpoint, channel, source }
 *   window.__tidyCapture = (rect|undefined) => Promise<dataUrl|undefined>
 *   window.__tidyConsole = [{ level, text, ts }]   (optional ring buffer)
 * Exposes window.__tidy = { toggle, open, close, isOpen }.
 */
;(() => {
  if (window.__tidy !== undefined) return

  const config = () => ({
    endpoint: 'http://127.0.0.1:7787',
    source: 'bookmarklet',
    ...(window.__tidyConfig ?? {}),
  })

  const endpointUrl = (path) => `${String(config().endpoint).replace(/\/$/, '')}${path}`

  const ATTRS_OF_INTEREST = [
    'id', 'name', 'type', 'role', 'href', 'placeholder', 'value', 'title', 'alt',
    'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-expanded', 'aria-selected',
    'disabled', 'checked', 'for', 'formcontrolname', 'routerlink', 'data-testid',
  ]

  // ---------------------------------------------------------------- describe

  function cssPath(el) {
    const parts = []
    let node = el
    while (node !== null && node.nodeType === 1 && parts.length < 12) {
      if (node.id !== '' && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`)
        break
      }
      const tag = node.tagName.toLowerCase()
      const siblings = node.parentElement === null ? [] : [...node.parentElement.children].filter((c) => c.tagName === node.tagName)
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag)
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label')
    if (aria !== null && aria.trim() !== '') return aria.trim()
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy !== null) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText ?? '')
        .join(' ')
        .trim()
      if (text !== '') return text
    }
    if (el.id !== '') {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (label !== null) return label.innerText.trim()
    }
    const wrapping = el.closest('label')
    if (wrapping !== null && wrapping.innerText.trim() !== '') return wrapping.innerText.trim()
    for (const attr of ['placeholder', 'alt', 'title']) {
      const value = el.getAttribute(attr)
      if (value !== null && value.trim() !== '') return value.trim()
    }
    return (el.innerText ?? '').trim().slice(0, 120)
  }

  /** Custom-element ancestors are the fastest route from a pixel to a source file. */
  function componentChain(el) {
    const chain = []
    let node = el
    while (node !== null && chain.length < 6) {
      const tag = node.tagName.toLowerCase()
      if (tag.includes('-')) chain.push(tag)
      node = node.parentElement
    }
    return chain
  }

  function describeElement(el) {
    const rect = el.getBoundingClientRect()
    const styles = window.getComputedStyle(el)
    const attributes = {}
    for (const attr of ATTRS_OF_INTEREST) {
      const value = el.getAttribute(attr)
      if (value !== null) attributes[attr] = value.slice(0, 300)
    }
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-') && attributes[attr.name] === undefined) {
        attributes[attr.name] = attr.value.slice(0, 300)
      }
    }
    return {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      classes: [...el.classList].slice(0, 30),
      accessibleName: accessibleName(el),
      componentChain: componentChain(el),
      attributes,
      text: (el.innerText ?? '').trim(),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      pageRect: { x: Math.round(rect.x + window.scrollX), y: Math.round(rect.y + window.scrollY) },
      styles: Object.fromEntries(
        ['display', 'position', 'color', 'background-color', 'font-size', 'font-family', 'font-weight', 'padding', 'margin', 'border', 'border-radius', 'z-index', 'overflow', 'opacity', 'visibility']
          .map((prop) => [prop, styles.getPropertyValue(prop)]),
      ),
      outerHTML: el.outerHTML,
    }
  }

  // ------------------------------------------------------------------ styles

  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
    .highlight { position: fixed; border: 2px solid #4f46e5; background: rgba(79,70,229,.12); border-radius: 2px; pointer-events: none; transition: all .04s linear; }
    .tag { position: fixed; background: #4f46e5; color: #fff; font-size: 11px; line-height: 1.4; padding: 2px 6px; border-radius: 3px; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
    .marquee { position: fixed; border: 2px dashed #4f46e5; background: rgba(79,70,229,.10); pointer-events: none; }
    .bar { position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 6px; background: #111827; color: #fff; padding: 8px; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.35); pointer-events: auto; }
    .bar button { font-size: 12px; padding: 6px 10px; border-radius: 6px; border: 1px solid #374151; background: #1f2937; color: #e5e7eb; cursor: pointer; }
    .bar button:hover { background: #374151; }
    .bar button.on { background: #4f46e5; border-color: #4f46e5; color: #fff; }
    .bar .label { font-size: 11px; color: #9ca3af; padding: 0 4px; }
    .bar .session { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #d1d5db; max-width: 210px; padding: 0 2px; }
    .bar .session .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar .dot { width: 7px; height: 7px; border-radius: 50%; background: #6b7280; flex: none; }
    .bar .dot.live { background: #34d399; }
    .bar .dot.down { background: #f87171; }
    .panel { position: fixed; right: 16px; bottom: 70px; width: 360px; max-width: calc(100vw - 32px); background: #fff; color: #111827; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.3); pointer-events: auto; overflow: hidden; }
    .panel header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; font-size: 13px; font-weight: 600; }
    .panel .body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .target { font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #4b5563; background: #f3f4f6; border-radius: 6px; padding: 6px 8px; word-break: break-all; max-height: 76px; overflow: auto; }
    textarea { width: 100%; min-height: 96px; resize: vertical; font-size: 13px; padding: 8px; border: 1px solid #d1d5db; border-radius: 8px; color: #111827; background: #fff; }
    textarea:focus { outline: 2px solid #4f46e5; outline-offset: -1px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #4b5563; }
    .actions { display: flex; gap: 8px; }
    .actions button { font-size: 13px; padding: 7px 12px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; color: #374151; cursor: pointer; }
    .actions button.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
    .actions button[disabled] { opacity: .55; cursor: default; }
    .shot { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; max-height: 150px; object-fit: contain; background: #f9fafb; }
    .error { font-size: 12px; color: #b91c1c; }
    .toast { position: fixed; right: 16px; bottom: 70px; background: #065f46; color: #fff; font-size: 13px; padding: 10px 12px; border-radius: 8px; pointer-events: none; }
    .icon { border: 0; background: transparent; color: #6b7280; font-size: 16px; line-height: 1; cursor: pointer; padding: 2px 4px; }
  `

  // ------------------------------------------------------------------- state

  const host = document.createElement('div')
  host.setAttribute('data-tidy', 'root')
  // Angular CDK 21, and any dialog built on <dialog> or the Popover API, renders
  // into the browser's TOP LAYER. Nothing in the normal layer paints above that —
  // z-index 2147483647 included — so the only way to stay on top of a dialog is to
  // join the top layer too. `manual` and not `auto`: an auto popover light-dismisses
  // and closes every other open auto popover, which would shut the very dialog the
  // user is trying to comment on.
  const CAN_RAISE = typeof host.showPopover === 'function'
  if (CAN_RAISE) host.setAttribute('popover', 'manual')

  /** Re-entering the top layer moves the overlay above anything that entered it since. */
  function raise() {
    if (!CAN_RAISE || !host.isConnected) return
    try {
      if (host.matches(':popover-open')) host.hidePopover()
      host.showPopover()
    } catch {
      // A popover cannot be shown while the document is unloading. Nothing to
      // recover: the overlay still works, it is just back under a dialog.
    }
  }

  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CSS_TEXT
  root.append(style)

  const layer = document.createElement('div')
  layer.className = 'layer'
  root.append(layer)

  let mode = 'idle' // idle | pick | region
  let open = false
  // What the feedback is about. `kind` is the wire `mode` verbatim.
  const PAGE = { kind: 'page' }
  let selection = PAGE // PAGE | { kind: 'element', description } | { kind: 'region', rect }
  let pendingShot // dataUrl | undefined
  let composerToken = 0
  let draft = '' // comment text, kept across a re-open so picking never eats it
  let dragStart

  const nodes = {}

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className !== undefined) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  // ----------------------------------------------------------------- toolbar

  function buildBar() {
    const bar = el('div', 'bar')
    const session = el('div', 'session')
    const dot = el('span', 'dot')
    const name = el('span', 'name', 'connecting…')
    session.append(dot, name)
    const pick = el('button', undefined, 'Pick element ⌥E')
    const drag = el('button', undefined, 'Region ⌥R')
    const page = el('button', undefined, 'Whole page ⌥P')
    const hint = el('span', 'label', 'esc to exit')
    const close = el('button', 'icon', '✕')
    close.title = 'Close tidy'
    pick.addEventListener('click', modes.pick)
    drag.addEventListener('click', modes.region)
    page.addEventListener('click', modes.wholePage)
    close.addEventListener('click', () => api.close())
    const gear = el('button', 'icon', '⚙')
    gear.title = 'tidy settings'
    gear.addEventListener('click', openSettings)
    bar.append(session, pick, drag, page, hint, gear, close)
    nodes.bar = bar
    nodes.pick = pick
    nodes.drag = drag
    nodes.sessionDot = dot
    nodes.sessionName = name
    layer.append(bar)
  }

  function openSettings() {
    if (window.__tidyOpenSettings === undefined) {
      window.alert('Settings live in the tidy extension. The bookmarklet reads its endpoint from the page it was dragged from.')
      return
    }
    window.__tidyOpenSettings()
  }

  async function refreshSession() {
    try {
      const response = await fetch(endpointUrl('/health'), { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const health = await response.json()
      if (health.originAllowed === false) {
        nodes.sessionName.textContent = 'origin not allowed'
        nodes.sessionName.title = `The collector is running but will not accept ${location.origin}. Run: tidy allow ${location.origin}`
        nodes.sessionDot.className = 'dot down'
        return
      }
      const label = typeof health.session?.label === 'string' && health.session.label !== '' ? health.session.label : 'tidy'
      nodes.sessionName.textContent = label
      nodes.sessionName.title = `Feedback goes to: ${label}`
      nodes.sessionDot.className = 'dot live'
    } catch {
      nodes.sessionName.textContent = 'collector unreachable'
      nodes.sessionName.title = 'Start a Claude Code session with the tidy MCP server, or run `tidy serve`.'
      nodes.sessionDot.className = 'dot down'
    }
  }

  function syncBar() {
    nodes.pick.classList.toggle('on', mode === 'pick')
    nodes.drag.classList.toggle('on', mode === 'region')
  }

  // --------------------------------------------------------------- highlight

  function showHighlight(rect, label) {
    if (nodes.highlight === undefined) {
      nodes.highlight = el('div', 'highlight')
      nodes.tag = el('div', 'tag')
      layer.append(nodes.highlight, nodes.tag)
    }
    Object.assign(nodes.highlight.style, {
      display: 'block',
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    })
    nodes.tag.style.display = 'block'
    nodes.tag.textContent = label
    nodes.tag.style.left = `${rect.x}px`
    nodes.tag.style.top = rect.y > 22 ? `${rect.y - 20}px` : `${rect.y + rect.height + 4}px`
  }

  function hideHighlight() {
    if (nodes.highlight === undefined) return
    nodes.highlight.style.display = 'none'
    nodes.tag.style.display = 'none'
  }

  function ownsNode(node) {
    return node === host || host.contains(node) || node?.getRootNode?.() === root
  }

  // ------------------------------------------------------------ mode plumbing

  function setMode(next) {
    // Picking needs the page visible.
    if (next !== 'idle') {
      removePanel()
      pendingShot = undefined
      composerToken += 1
    }
    // A dialog can enter the top layer after the overlay did. Arming a mode is the
    // moment the highlight has to be visible, so take the top back here.
    if (next !== 'idle') raise()
    mode = next
    document.documentElement.style.cursor = next === 'idle' ? '' : 'crosshair'
    if (next === 'idle') hideHighlight()
    if (nodes.marquee !== undefined) nodes.marquee.style.display = 'none'
    syncBar()
  }

  function onMove(event) {
    if (mode === 'pick') {
      const node = document.elementFromPoint(event.clientX, event.clientY)
      if (node === null || ownsNode(node)) return hideHighlight()
      const rect = node.getBoundingClientRect()
      showHighlight(rect, `${node.tagName.toLowerCase()}${node.id === '' ? '' : `#${node.id}`} · ${Math.round(rect.width)}×${Math.round(rect.height)}`)
      return undefined
    }
    if (mode === 'region' && dragStart !== undefined) {
      if (nodes.marquee === undefined) {
        nodes.marquee = el('div', 'marquee')
        layer.append(nodes.marquee)
      }
      const x = Math.min(dragStart.x, event.clientX)
      const y = Math.min(dragStart.y, event.clientY)
      Object.assign(nodes.marquee.style, {
        display: 'block',
        left: `${x}px`,
        top: `${y}px`,
        width: `${Math.abs(event.clientX - dragStart.x)}px`,
        height: `${Math.abs(event.clientY - dragStart.y)}px`,
      })
    }
    return undefined
  }

  function onDown(event) {
    if (mode !== 'region' || ownsNode(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    dragStart = { x: event.clientX, y: event.clientY }
  }

  function onUp(event) {
    if (mode !== 'region' || dragStart === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const x = Math.min(dragStart.x, event.clientX)
    const y = Math.min(dragStart.y, event.clientY)
    const width = Math.abs(event.clientX - dragStart.x)
    const height = Math.abs(event.clientY - dragStart.y)
    dragStart = undefined
    if (width < 6 || height < 6) return
    selection = {
      kind: 'region',
      rect: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
    }
    setMode('idle')
    void openComposer()
  }

  function onClick(event) {
    if (mode !== 'pick' || ownsNode(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    const node = document.elementFromPoint(event.clientX, event.clientY)
    if (node === null || ownsNode(node)) return
    selection = { kind: 'element', description: describeElement(node) }
    setMode('idle')
    hideHighlight()
    void openComposer()
  }

  // Alt+letter, matched on `code` so it survives layouts and macOS dead keys —
  // preventDefault stops Alt+E composing an accent into the open textarea.
  const modes = {
    pick: () => setMode(mode === 'pick' ? 'idle' : 'pick'),
    region: () => setMode(mode === 'region' ? 'idle' : 'region'),
    wholePage: () => {
      setMode('idle')
      selection = PAGE
      void openComposer()
    },
  }

  const HOTKEYS = { KeyE: modes.pick, KeyR: modes.region, KeyP: modes.wholePage }

  function onKey(event) {
    if (event.repeat) return
    if (event.altKey && !event.ctrlKey && !event.metaKey && HOTKEYS[event.code] !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      HOTKEYS[event.code]()
      return
    }
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (nodes.panel !== undefined) closeComposer()
    else if (mode !== 'idle') setMode('idle')
    else api.close()
  }

  // ---------------------------------------------------------------- composer

  function targetSummary() {
    if (selection.kind === 'element') {
      const { description } = selection
      const name = description.accessibleName === '' ? '' : ` — “${description.accessibleName.slice(0, 60)}”`
      const component = description.componentChain[0] === undefined ? '' : `\n<${description.componentChain[0]}>`
      return `${description.selector}${name}${component}`
    }
    if (selection.kind === 'region') {
      const { rect } = selection
      return `region ${rect.width}×${rect.height} at (${rect.x}, ${rect.y})`
    }
    return `whole page — ${location.pathname}`
  }

  async function capture() {
    const capturer = window.__tidyCapture
    if (typeof capturer !== 'function') return undefined
    const rect = selection.kind === 'element' ? selection.description.rect : selection.rect
    // `visibility`, not `display`: display:none evicts the host from the top layer,
    // and it does not go back when the shot is done. It paints nothing either way.
    host.style.visibility = 'hidden'
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 40)))
    try {
      return await capturer(rect)
    } catch {
      return undefined
    } finally {
      host.style.visibility = ''
    }
  }

  async function openComposer() {
    removePanel()
    const token = ++composerToken
    // Capture first: the overlay hides itself for the shot, and a panel that
    // opened before the capture would blink off for a frame.
    pendingShot = await capture()
    // Arming a picker mid-capture supersedes this composer; rebuilding it would
    // drop a panel over the page with the picker live, which reads as a dead picker.
    if (token !== composerToken) return
    buildComposer()
  }

  function buildComposer() {
    const panel = el('div', 'panel')
    const header = el('header')
    header.append(el('span', undefined, 'Send feedback to Claude'))
    const dismiss = el('button', 'icon', '✕')
    dismiss.addEventListener('click', () => closeComposer())
    header.append(dismiss)

    const body = el('div', 'body')
    const summary = el('div', 'target', targetSummary())
    const textarea = document.createElement('textarea')
    textarea.placeholder = 'What is wrong / what should change here?'
    textarea.value = draft
    textarea.addEventListener('input', () => { draft = textarea.value })

    const shotRow = el('div', 'row')
    const check = el('label', 'check')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    // A capture that came back empty (rate limit, restricted page) must not leave
    // the box promising an image that will not be sent.
    const canCapture = typeof window.__tidyCapture === 'function'
    const haveShot = pendingShot !== undefined
    checkbox.checked = canCapture && haveShot
    checkbox.disabled = !canCapture || !haveShot
    check.append(
      checkbox,
      el(
        'span',
        undefined,
        !canCapture ? 'Screenshot needs the extension' : haveShot ? 'Include screenshot' : 'Screenshot unavailable on this page',
      ),
    )
    shotRow.append(check)

    const preview = document.createElement('img')
    preview.className = 'shot'
    preview.style.display = 'none'

    const error = el('div', 'error')
    error.style.display = 'none'

    const actions = el('div', 'actions')
    const cancel = el('button', undefined, 'Cancel')
    const send = el('button', 'primary', 'Send')
    cancel.addEventListener('click', () => closeComposer())
    actions.append(cancel, send)
    const footer = el('div', 'row')
    footer.append(el('span', 'label', '⌘/ctrl + enter'), actions)

    body.append(summary, textarea, shotRow, preview, error, footer)
    panel.append(header, body)
    layer.append(panel)
    nodes.panel = panel
    textarea.focus()

    if (pendingShot !== undefined) {
      preview.src = pendingShot
      preview.style.display = checkbox.checked ? 'block' : 'none'
    }
    checkbox.addEventListener('change', () => {
      preview.style.display = checkbox.checked && pendingShot !== undefined ? 'block' : 'none'
    })

    async function submit() {
      const comment = textarea.value.trim()
      if (comment === '') {
        error.textContent = 'Add a comment first.'
        error.style.display = 'block'
        textarea.focus()
        return
      }
      send.disabled = true
      send.textContent = 'Sending…'
      error.style.display = 'none'
      try {
        await send_(comment, checkbox.checked ? pendingShot : undefined)
        closeComposer()
        toast('Feedback sent')
      } catch (cause) {
        send.disabled = false
        send.textContent = 'Send'
        error.textContent = `Could not reach the collector at ${config().endpoint} — is \`tidy serve\` running? (${cause.message})`
        error.style.display = 'block'
      }
    }

    send.addEventListener('click', () => void submit())
    textarea.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        void submit()
      }
    })
  }

  // Panel teardown only — arming a picker must not clear the selection or the draft.
  function removePanel() {
    if (nodes.panel === undefined) return
    nodes.panel.remove()
    nodes.panel = undefined
  }

  function closeComposer() {
    removePanel()
    selection = PAGE
    pendingShot = undefined
    draft = ''
  }

  function toast(text) {
    const node = el('div', 'toast', text)
    layer.append(node)
    setTimeout(() => node.remove(), 2200)
  }

  async function send_(comment, screenshot) {
    const settings = config()
    const payload = {
      source: settings.source,
      channel: settings.channel,
      mode: selection.kind,
      comment,
      screenshot,
      region: selection.kind === 'region' ? selection.rect : undefined,
      element: selection.kind === 'element' ? selection.description : undefined,
      console: (window.__tidyConsole ?? []).slice(-25),
      page: {
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) },
        devicePixelRatio: window.devicePixelRatio,
        userAgent: navigator.userAgent,
      },
    }
    const response = await fetch(endpointUrl('/api/feedback'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`)
    return response.json()
  }

  // ----------------------------------------------------------- console buffer

  if (window.__tidyConsole === undefined) {
    const buffer = []
    window.__tidyConsole = buffer
    for (const level of ['error', 'warn']) {
      const original = console[level].bind(console)
      console[level] = (...args) => {
        buffer.push({ level, text: args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' ').slice(0, 1000), ts: Date.now() })
        if (buffer.length > 25) buffer.shift()
        original(...args)
      }
    }
    window.addEventListener('error', (event) => {
      buffer.push({ level: 'uncaught', text: `${event.message} @ ${event.filename}:${event.lineno}`, ts: Date.now() })
      if (buffer.length > 25) buffer.shift()
    })
    window.addEventListener('unhandledrejection', (event) => {
      buffer.push({ level: 'unhandledrejection', text: String(event.reason).slice(0, 1000), ts: Date.now() })
      if (buffer.length > 25) buffer.shift()
    })
  }

  // ------------------------------------------------------------------- public

  const listeners = [
    ['mousemove', onMove, true],
    ['mousedown', onDown, true],
    ['mouseup', onUp, true],
    ['click', onClick, true],
    ['keydown', onKey, true],
  ]

  const api = {
    isOpen: () => open,
    open() {
      if (open) return
      open = true
      document.documentElement.append(host)
      raise()
      if (nodes.bar === undefined) buildBar()
      // Every open, not once per page: the collector can restart on another
      // branch, or start after a page that first saw it down.
      void refreshSession()
      for (const [type, handler, capture_] of listeners) document.addEventListener(type, handler, capture_)
      modes.wholePage()
    },
    close() {
      if (!open) return
      open = false
      closeComposer()
      setMode('idle')
      for (const [type, handler, capture_] of listeners) document.removeEventListener(type, handler, capture_)
      host.remove()
    },
    toggle() {
      if (open) api.close()
      else api.open()
    },
  }

  window.__tidy = api
})()
