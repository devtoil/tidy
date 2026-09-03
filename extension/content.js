/* Isolated-world bridge: settings, screenshot capture, console relay, toggle. */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:7787'
;(() => {
  if (window.__tidyBridge === true) return
  window.__tidyBridge = true

  const buffer = []
  window.__tidyConsole = buffer
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.__tidy !== 'console') return
    buffer.push(event.data.entry)
    if (buffer.length > 25) buffer.shift()
  })

  window.__tidyConfig = { endpoint: DEFAULT_ENDPOINT, source: 'extension' }
  const applySettings = () => {
    chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT, channel: '' }, (settings) => {
      window.__tidyConfig = {
        endpoint: settings.endpoint,
        channel: settings.channel === '' ? undefined : settings.channel,
        source: 'extension',
      }
    })
  }
  applySettings()
  chrome.storage.onChanged.addListener(applySettings)

  window.__tidyOpenSettings = () => {
    chrome.runtime.sendMessage({ type: 'tidy:settings' }, () => undefined)
  }

  window.__tidyCapture = (rect) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'tidy:capture', rect, devicePixelRatio: window.devicePixelRatio },
        (response) => resolve(chrome.runtime.lastError === undefined ? response?.dataUrl : undefined),
      )
    })

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'tidy:toggle') {
      window.__tidy?.toggle()
      sendResponse({ ok: true, open: window.__tidy?.isOpen() === true })
    }
    return false
  })
})()
