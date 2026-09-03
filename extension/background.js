/* Service worker: injection on demand (activeTab only) + screenshot cropping. */

const FILES_MAIN = ['console-hook.js']
const FILES_ISOLATED = ['content.js', 'overlay.js']

async function toggle(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'tidy:toggle' })
    return
  } catch {
    // Not injected in this tab yet.
  }
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: FILES_MAIN }).catch(() => undefined)
  await chrome.scripting.executeScript({ target: { tabId }, files: FILES_ISOLATED })
  await chrome.tabs.sendMessage(tabId, { type: 'tidy:toggle' })
}

/**
 * The overlay cannot be injected into chrome://, the Web Store, or the PDF
 * viewer. There is no popup left to report that in, so the icon says it.
 */
async function activate(tabId) {
  let failure
  try {
    await toggle(tabId)
  } catch (error) {
    // Only claim the page is off limits when Chrome actually said so — asserting
    // one cause for every failure sends the user looking in the wrong place.
    const message = String(error?.message ?? error)
    failure = /Cannot access|extensions gallery|chrome:\/\//i.test(message)
      ? 'tidy cannot run on this page (chrome:// and Web Store pages are off limits)'
      : `tidy could not start on this page: ${message}`
  }
  // Both are cleared on success: a tab that failed once would otherwise keep the
  // warning tooltip for the rest of its life. The three calls fail together
  // (the tab went away), so one guard covers them.
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b91c1c' })
    await chrome.action.setBadgeText({ tabId, text: failure === undefined ? '' : '!' })
    await chrome.action.setTitle({
      tabId,
      title: failure ?? chrome.runtime.getManifest().action?.default_title ?? 'tidy',
    })
  } catch {
    // The tab closed between the click and here.
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-overlay' && tab?.id !== undefined) void activate(tab.id)
})

// activeTab is granted by the icon click itself, which is what toggle()'s executeScript needs.
chrome.action.onClicked.addListener((tab) => {
  if (tab?.id !== undefined) void activate(tab.id)
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'tidy:settings') {
    chrome.runtime.openOptionsPage()
    sendResponse({ ok: true })
    return false
  }
  if (message?.type === 'tidy:capture') {
    void capture(sender.tab?.windowId, message.rect, message.devicePixelRatio ?? 1)
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch(() => sendResponse({ dataUrl: undefined }))
    return true
  }
  return false
})

async function capture(windowId, rect, dpr) {
  const full = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
  if (rect === undefined || rect === null || rect.width < 2 || rect.height < 2) return full

  const bitmap = await createImageBitmap(await (await fetch(full)).blob())
  const pad = 8 * dpr
  const sx = Math.max(0, Math.round(rect.x * dpr - pad))
  const sy = Math.max(0, Math.round(rect.y * dpr - pad))
  const sw = Math.min(bitmap.width - sx, Math.round(rect.width * dpr + pad * 2))
  const sh = Math.min(bitmap.height - sy, Math.round(rect.height * dpr + pad * 2))
  if (sw < 2 || sh < 2) return full

  const canvas = new OffscreenCanvas(sw, sh)
  const context = canvas.getContext('2d')
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return `data:image/png;base64,${toBase64(await blob.arrayBuffer())}`
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}
