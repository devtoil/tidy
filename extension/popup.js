const DEFAULT_ENDPOINT = 'http://127.0.0.1:7787'
const endpointInput = document.getElementById('endpoint')
const channelInput = document.getElementById('channel')
const status = document.getElementById('status')

function setStatus(text, kind) {
  status.textContent = text
  status.className = `status${kind === undefined ? '' : ` ${kind}`}`
}

async function checkHealth(endpoint) {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/health`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const health = await response.json()
    const session = typeof health.session?.label === 'string' ? health.session.label : undefined
    setStatus(
      `Connected${session === undefined ? '' : ` to ${session}`} — ${health.pending} pending item(s)`,
      'good',
    )
  } catch {
    setStatus('Collector unreachable. Run `tidy serve` in a terminal.', 'bad')
  }
}

chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT, channel: '' }, (settings) => {
  endpointInput.value = settings.endpoint
  channelInput.value = settings.channel
  void checkHealth(settings.endpoint)
})

document.getElementById('save').addEventListener('click', () => {
  const endpoint = endpointInput.value.trim() === '' ? DEFAULT_ENDPOINT : endpointInput.value.trim()
  chrome.storage.sync.set({ endpoint, channel: channelInput.value.trim() }, () => {
    setStatus('Saved.', 'good')
    void checkHealth(endpoint)
  })
})
