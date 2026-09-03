/* Injected into the page's MAIN world so it sees the page's own console. */
;(() => {
  if (window.__tidyHooked === true) return
  window.__tidyHooked = true

  const post = (level, text) => {
    window.postMessage({ __tidy: 'console', entry: { level, text: String(text).slice(0, 1000), ts: Date.now() } }, '*')
  }

  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      post(level, args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' '))
      original(...args)
    }
  }
  window.addEventListener('error', (event) => post('uncaught', `${event.message} @ ${event.filename}:${event.lineno}`))
  window.addEventListener('unhandledrejection', (event) => post('unhandledrejection', String(event.reason)))
})()
