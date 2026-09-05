/**
 * End-to-end coverage for the overlay and the Chrome extension, driven through
 * a real Chromium. Skips (exit 0) when playwright-core or a Chromium binary is
 * not available, so it never blocks a checkout that has neither.
 *
 *   node tools/tidy/test/browser.mjs
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXTENSION = join(HERE, '..', 'extension')
const PORT = 7900
const PAGE_PORT = 7901
const ENDPOINT = `http://127.0.0.1:${PORT}`

let chromium
try {
  ;({ chromium } = await import('playwright-core'))
} catch {
  process.stdout.write('SKIP  playwright-core is not installed (npm i -D playwright-core)\n')
  process.exit(0)
}

function findChromium() {
  if (process.env.ZF_CHROME !== undefined) return process.env.ZF_CHROME
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers'
  if (existsSync(root)) {
    for (const entry of readdirSync(root)) {
      const candidate = join(root, entry, 'chrome-linux', 'chrome')
      if (entry.startsWith('chromium-') && existsSync(candidate)) return candidate
    }
  }
  try {
    const path = chromium.executablePath()
    return existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
}

const executablePath = findChromium()
if (executablePath === undefined) {
  process.stdout.write('SKIP  no Chromium binary found (set ZF_CHROME=/path/to/chrome)\n')
  process.exit(0)
}

process.env.TIDY_HOME = mkdtempSync(join(tmpdir(), 'tidy-test-'))
process.env.TIDY_SESSION_NAME = 'test-session · main'
const { startCollector } = await import('../src/server.mjs')
const { listFeedback } = await import('../src/store.mjs')

let failures = 0
const step = (name, ok) => {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n`)
}

const FIXTURE = `<!doctype html><html><body style="font-family:sans-serif;padding:40px">
  <h1>Layer settings</h1>
  <app-layer-edit>
    <label for="layer-title">Layer title</label>
    <input id="layer-title" style="display:block;margin:8px 0">
    <ui-button><button id="save-btn" type="submit" data-testid="save" style="padding:8px 16px">Save</button></ui-button>
  </app-layer-edit>
  <!-- Angular CDK 21 puts every overlay in the browser's TOP LAYER: usePopover
       defaults to true, so the host carries popover + showPopover(). Nothing in
       the normal layer can paint above that, z-index 2147483647 included. -->
  <div id="cdk-host" popover style="background:none;border:none;padding:0;position:fixed;inset:auto;top:0;left:0;width:100%;height:100%;pointer-events:none">
    <div id="cdk-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.32);pointer-events:auto"></div>
    <div id="cdk-pane" style="position:absolute;left:200px;top:120px;width:520px;height:360px;background:#fff;pointer-events:auto">
      <img id="thumb" alt="Repair clamp" style="width:120px;height:80px;background:#94a3b8;display:block">
    </div>
  </div>
</body></html>`

const OVERLAY_SOURCE = readFileSync(join(EXTENSION, 'overlay.js'), 'utf8')

/** The overlay lives in a shadow root; Playwright locators pierce it, evaluate() does not. */
const zf = (page, selector) => page.locator(`[data-tidy=root] ${selector}`)
const sessionName = (page) => zf(page, '.bar .session .name')
const composer = (page) => zf(page, '.panel').waitFor({ timeout: 8000 })

/**
 * elementFromPoint retargets shadow content to the host, so "the host is on top
 * here" is the browser's own answer to "can the user reach this pixel".
 */
const onTop = (page, selector) =>
  page.evaluate((sel) => {
    const host = document.querySelector('[data-tidy=root]')
    const rect = host.shadowRoot.querySelector(sel).getBoundingClientRect()
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + 4) === host
  }, selector)

/** A page with the overlay injected. `init` runs before load and carries what varies. */
async function overlayPage(browser, init, arg) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  await page.addInitScript(init, arg)
  await page.goto(`http://127.0.0.1:${PAGE_PORT}`)
  await page.addScriptTag({ content: OVERLAY_SOURCE })
  return page
}

const collector = await startCollector({ port: PORT })
if (!collector.listening) {
  process.stdout.write(`SKIP  port ${PORT} is busy\n`)
  process.exit(0)
}
const pageServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end(FIXTURE)
})
pageServer.listen(PAGE_PORT, '127.0.0.1')

// --------------------------------------------------------- overlay (bookmarklet path)

{
  const browser = await chromium.launch({ executablePath })
  const page = await overlayPage(browser, (endpoint) => {
    window.__tidyConfig = { endpoint, channel: 'test-channel', source: 'bookmarklet' }
    window.__tidyCapture = async () =>
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  }, ENDPOINT)

  await page.evaluate(() => window.__tidy.open())
  await composer(page)
  step('overlay opens with the toolbar', await zf(page, '.bar').isVisible())
  step('opens straight into the composer', await zf(page, '.panel').isVisible())
  step(
    'the comment box has focus, ready to type',
    await page.evaluate(() => document.querySelector('[data-tidy=root]')?.shadowRoot?.activeElement?.tagName === 'TEXTAREA'),
  )
  step(
    'the whole page is attached by default',
    await zf(page, '.panel .check input').isChecked(),
  )
  step(
    'no element is preselected',
    (await zf(page, '.target').innerText()).toLowerCase().includes('page'),
  )
  step('picking stays one click away', await zf(page, '.bar').isVisible())

  await zf(page, '.bar .dot.live').waitFor({ timeout: 5000 })
  step(
    'toolbar names the session from /health',
    (await sessionName(page).innerText()) === 'test-session · main',
  )
  step(
    'session dot shows the collector is reachable',
    await zf(page, '.bar .dot.live').isVisible(),
  )

  {
    const offline = await overlayPage(browser, () => {
      window.__tidyConfig = { endpoint: 'http://127.0.0.1:7999', source: 'bookmarklet' }
    })
    await offline.evaluate(() => window.__tidy.open())
    await zf(offline, '.bar .dot.down').waitFor({ timeout: 5000 })
    step(
      'unreachable collector is announced on the toolbar',
      (await sessionName(offline).innerText()) === 'collector unreachable',
    )
    await offline.close()
  }

  await zf(page, '.bar button').filter({ hasText: 'Pick element' }).first().click()
  step('the Pick element button arms picking', (await zf(page, '.bar button.on').innerText()).startsWith('Pick element'))

  await page.hover('#save-btn')
  step('hover highlights the hovered element', (await zf(page, '.tag').innerText()).startsWith('button#save-btn'))

  await page.evaluate(() => console.error('NG0100: expression changed after checked'))
  await page.click('#save-btn')
  await composer(page)
  step('clicking an element opens the composer', await zf(page, '.panel').isVisible())
  await new Promise((resolve) => setTimeout(resolve, 250))
  step('composer stays visible after the capture pass', await zf(page, '.panel').isVisible())
  const summary = await zf(page, '.target').innerText()
  step('composer names selector, accessible name and component', summary.includes('#save-btn') && summary.includes('Save') && summary.includes('ui-button'))
  step('screenshot preview renders', await zf(page, '.shot').isVisible())

  await zf(page, 'textarea').fill('Save button should sit flush with the title input.')
  await zf(page, '.actions button.primary').click()
  await page.waitForSelector('[data-tidy=root] .toast', { timeout: 5000 })
  step('composer closes after a successful send', (await zf(page, '.panel').count()) === 0)

  const item = listFeedback({ channel: 'test-channel' })[0]
  step('collector stored the item', item !== undefined)
  step('selector resolves to the clicked button', item?.element?.selector?.endsWith('#save-btn') === true)
  step('accessible name captured from the button text', item?.element?.accessibleName === 'Save')
  step('custom-element ancestors captured', item?.element?.componentChain?.[0] === 'ui-button' && item?.element?.componentChain?.[1] === 'app-layer-edit')
  step('data- attributes captured', item?.element?.attributes?.['data-testid'] === 'save')
  step('console errors ride along', item?.console?.[0]?.text?.includes('NG0100') === true)
  step('screenshot written to disk', typeof item?.screenshot === 'string')

  await page.evaluate(() => window.__tidy.open())
  await zf(page, '.bar button').filter({ hasText: 'Region' }).click()
  await page.mouse.move(60, 120)
  await page.mouse.down()
  await page.mouse.move(400, 300, { steps: 10 })
  await page.mouse.up()
  await composer(page)
  step('dragging a region opens the composer', (await zf(page, '.target').innerText()).startsWith('region 340×180'))

  await page.keyboard.press('Escape')
  step('escape closes the composer', (await zf(page, '.panel').count()) === 0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  step('escape closes the overlay', (await page.locator('[data-tidy=root]').count()) === 0)

  {
    await page.evaluate(() => window.__tidy.open())
    await composer(page)
    const box = zf(page, '.panel textarea')
    await box.fill('the save button is misaligned')

    await page.keyboard.press('Alt+KeyE')
    await page.click('#save-btn')
    await composer(page)
    step(
      'picking from an open composer keeps the element',
      (await zf(page, '.target').innerText()).includes('#save-btn'),
    )
    step(
      'the typed comment survives arming the picker',
      (await zf(page, '.panel textarea').inputValue()) === 'the save button is misaligned',
    )

    await page.keyboard.press('Alt+KeyE')
    await page.click('#layer-title')
    await composer(page)
    step(
      'picking works again on a second pass',
      (await zf(page, '.target').innerText()).includes('#layer-title'),
    )

    await page.keyboard.press('Alt+KeyR')
    step('alt+R arms region', (await zf(page, '.bar button.on').innerText()).startsWith('Region'))
    await page.keyboard.press('Alt+KeyP')
    await composer(page)
    step(
      'alt+P returns to the whole page',
      (await zf(page, '.target').innerText()).toLowerCase().includes('page'),
    )

    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.__tidy.close())
  }

  {
    // Clearing half of the removePanel/closeComposer split: a real dismiss, and a
    // successful send, must both drop the draft and the selection.
    await page.evaluate(() => window.__tidy.open())
    await composer(page)
    await zf(page, '.panel textarea').fill('discard me')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Alt+KeyP')
    await composer(page)
    step(
      'escape discards the draft',
      (await zf(page, '.panel textarea').inputValue()) === '',
    )

    await zf(page, '.panel textarea').fill('sent and gone')
    await zf(page, '.actions button.primary').click()
    await page.waitForSelector('[data-tidy=root] .toast', { timeout: 8000 })
    await page.keyboard.press('Alt+KeyP')
    await composer(page)
    step(
      'a successful send clears the draft',
      (await zf(page, '.panel textarea').inputValue()) === '',
    )
    await page.evaluate(() => window.__tidy.close())
  }

  {
    // A failed send must keep the panel, the text, and an enabled button — the
    // comment is the user's only copy.
    const dead = await overlayPage(browser, () => {
      window.__tidyConfig = { endpoint: 'http://127.0.0.1:7998', source: 'bookmarklet' }
    })
    await dead.evaluate(() => window.__tidy.open())
    await composer(dead)
    await zf(dead, '.panel textarea').fill('this must survive')
    await zf(dead, '.actions button.primary').click()
    await dead.waitForSelector('[data-tidy=root] .error', { state: 'visible', timeout: 8000 })
    step('a failed send says so', (await zf(dead, '.error').innerText()).includes('7998'))
    step('a failed send keeps the composer open', (await zf(dead, '.panel').count()) === 1)
    step(
      'a failed send keeps the typed comment',
      (await zf(dead, '.panel textarea').inputValue()) === 'this must survive',
    )
    step(
      'a failed send re-enables Send so it can be retried',
      await zf(dead, '.actions button.primary').isEnabled(),
    )
    await dead.close()
  }

  {
    // The label must be re-probed on every open: the collector can restart on
    // another branch, and a stale green dot names the wrong destination.
    let stubLabel = 'session-alpha'
    const stub = createServer((_q, r) => {
      r.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      r.end(JSON.stringify({ ok: true, name: 'tidy', pending: 0, session: { label: stubLabel } }))
    })
    await new Promise((done) => stub.listen(7903, '127.0.0.1', done))

    const probe = await overlayPage(browser, () => {
      window.__tidyConfig = { endpoint: 'http://127.0.0.1:7903', source: 'bookmarklet' }
      window.__tidyCapture = async () => undefined
    })
    const shown = () => sessionName(probe).innerText()

    await probe.evaluate(() => window.__tidy.open())
    await zf(probe, '.dot.live').waitFor({ timeout: 5000 })
    step('first open names the session', (await shown()) === 'session-alpha')

    stubLabel = 'session-bravo'
    await probe.evaluate(() => window.__tidy.close())
    await probe.evaluate(() => window.__tidy.open())
    await sessionName(probe)
      .filter({ hasText: 'session-bravo' })
      .waitFor({ timeout: 5000 })
    step('reopening re-probes instead of showing a stale session', (await shown()) === 'session-bravo')

    await probe.close()
    await new Promise((done) => stub.close(done))
  }

  {
    // Arming a picker while the opening capture is still in flight must not let
    // that composer land on top of the page — it reads as a dead picker.
    const slow = await overlayPage(browser, (endpoint) => {
      window.__tidyConfig = { endpoint, source: 'bookmarklet' }
      window.__tidyCapture = async () => {
        await new Promise((r) => setTimeout(r, 800))
        return undefined
      }
    }, ENDPOINT)
    await slow.evaluate(() => window.__tidy.open())
    await new Promise((resolve) => setTimeout(resolve, 150))
    await slow.keyboard.press('Alt+KeyE')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    step(
      'a picker armed mid-capture is not buried by the composer',
      (await zf(slow, '.panel').count()) === 0,
    )
    await slow.close()
  }

  {
    const guard = await overlayPage(browser, (endpoint) => {
      window.__tidyConfig = { endpoint, source: 'bookmarklet' }
      // A capture that comes back empty — rate limit, restricted page.
      window.__tidyCapture = async () => undefined
      window.__escSeen = 0
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__escSeen += 1 })
    }, ENDPOINT)
    await guard.evaluate(() => window.__tidy.open())
    await composer(guard)

    step(
      'an unavailable screenshot is not silently promised',
      (await zf(guard, '.check input').isChecked()) === false &&
        (await zf(guard, '.check').innerText()).includes('unavailable'),
    )

    // Escape must not reach the page: it would close the dialog being commented on.
    await guard.keyboard.press('Escape')
    step('escape does not leak to the page', (await guard.evaluate(() => window.__escSeen)) === 0)
    await guard.close()
  }

  {
    // A collector that is up but has not allowed this origin must not be reported
    // as "unreachable" — the remedy is `tidy allow`, not starting a server.
    const denied = createServer((q, r) => {
      r.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': q.headers.origin ?? '*' })
      r.end(JSON.stringify({ ok: true, name: 'tidy', originAllowed: false, pending: 0 }))
    })
    await new Promise((done) => denied.listen(7905, '127.0.0.1', done))
    const page2 = await overlayPage(browser, () => {
      window.__tidyConfig = { endpoint: 'http://127.0.0.1:7905', source: 'bookmarklet' }
      window.__tidyCapture = async () => undefined
    })
    await page2.evaluate(() => window.__tidy.open())
    await sessionName(page2).filter({ hasText: 'origin not allowed' }).waitFor({ timeout: 5000 })
    step(
      'a disallowed origin names the real remedy',
      (await sessionName(page2).getAttribute('title')).includes('tidy allow'),
    )
    await page2.close()
    await new Promise((done) => denied.close(done))
  }

  {
    // A CDK dialog is in the top layer, so the overlay has to be there too or the
    // highlight, the composer and the toolbar are all painted underneath it — the
    // picker still resolves the element, the user just cannot see that it did.
    const page3 = await overlayPage(browser, (endpoint) => {
      window.__tidyConfig = { endpoint, source: 'bookmarklet' }
      window.__tidyCapture = async () => undefined
    }, ENDPOINT)
    await page3.evaluate(() => document.getElementById('cdk-host').showPopover())
    await page3.evaluate(() => window.__tidy.open())
    await composer(page3)

    step('the toolbar stays clickable over a top-layer dialog', await onTop(page3, '.bar'))
    step('the composer is not buried by a top-layer dialog', await onTop(page3, '.panel'))

    await page3.keyboard.press('Alt+KeyE')
    const thumb = await page3.locator('#thumb').boundingBox()
    await page3.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
    await zf(page3, '.highlight').waitFor({ timeout: 5000 })
    // The highlight is pointer-events:none, so hit testing cannot see it. Read the
    // pixel instead: its 2px border is the only indigo on a white dialog.
    const border = await page3.evaluate(() => {
      const rect = document.querySelector('[data-tidy=root]').shadowRoot.querySelector('.highlight').getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y) + 1, width: 1, height: 1 }
    })
    const pixel = await page3.evaluate(async (data) => {
      const image = new Image()
      image.src = `data:image/png;base64,${data}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
    }, (await page3.screenshot({ clip: border })).toString('base64'))
    step(
      'the hover highlight paints above a top-layer dialog',
      Math.abs(pixel[0] - 79) < 24 && Math.abs(pixel[1] - 70) < 24 && Math.abs(pixel[2] - 229) < 24,
    )

    await page3.mouse.click(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
    await composer(page3)
    step(
      'picking inside a top-layer dialog selects the element under the cursor',
      (await zf(page3, '.target').innerText()).includes('#thumb'),
    )
    await page3.close()
  }

  {
    // The other order: tidy is already open when the dialog appears. Without a
    // re-assert the backdrop covers the toolbar, and the click meant for tidy lands
    // on the backdrop instead — closing the dialog the user came to comment on.
    const page4 = await overlayPage(browser, (endpoint) => {
      window.__tidyConfig = { endpoint, source: 'bookmarklet' }
      window.__tidyCapture = async () => undefined
    }, ENDPOINT)
    await page4.evaluate(() => window.__tidy.open())
    await composer(page4)
    await page4.evaluate(() => document.getElementById('cdk-host').showPopover())
    // The toggle event that drives the re-assert is queued, not synchronous.
    const recovered = await page4
      .waitForFunction(() => {
        const host = document.querySelector('[data-tidy=root]')
        const rect = host.shadowRoot.querySelector('.bar').getBoundingClientRect()
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + 4) === host
      }, undefined, { timeout: 5000 })
      .then(() => true, () => false)
    step('a dialog opening after the overlay does not bury it', recovered)
    step('the composer is still reachable after the dialog opens', await onTop(page4, '.panel'))
    await page4.close()
  }

  await page.evaluate(() => {
    window.__pageClicks = 0
    document.getElementById('save-btn').addEventListener('click', () => { window.__pageClicks += 1 })
    window.__tidy.open()
  })
  // capture() hides the overlay for its shot; asserting on rendered text before
  // the composer lands races that.
  await composer(page)
  await page.keyboard.press('Alt+KeyE')
  step('alt+E arms picking from the keyboard', (await zf(page, '.bar button.on').innerText()).startsWith('Pick element'))
  await page.click('#save-btn')
  step('the selection click never reaches the page', (await page.evaluate(() => window.__pageClicks)) === 0)

  await browser.close()
}

// ------------------------------------------------------------------ extension

{
  // The shipped manifest is activeTab-only, and activeTab is granted only by a
  // real toolbar click or keyboard command — neither of which Playwright can
  // fire. Test a copy carrying <all_urls> so injection and capture are reachable.
  const dir = mkdtempSync(join(tmpdir(), 'tidy-ext-'))
  cpSync(EXTENSION, dir, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  manifest.host_permissions = ['<all_urls>']
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'tidy-profile-')), {
    executablePath,
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  })

  let worker = context.serviceWorkers()[0]
  if (worker === undefined) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 })
  step('extension service worker starts', worker.url().endsWith('background.js'))
  const runtimeManifest = await worker.evaluate(() => chrome.runtime.getManifest())
  step('manifest parses as MV3', runtimeManifest.manifest_version === 3)
  step('icon click is not intercepted by a popup', runtimeManifest.action?.default_popup === undefined)
  step('settings moved to an options page', runtimeManifest.options_ui?.page === 'popup.html')
  step(
    'action click opens the overlay',
    await worker.evaluate(() => chrome.action.onClicked.hasListeners()),
  )
  const shortcuts = await worker.evaluate(() => new Promise((resolve) => chrome.commands.getAll((c) => resolve(c.map((x) => x.shortcut)))))
  // Chrome renders the accelerator with platform glyphs — "⌥⇧F" on macOS.
  step('Alt+Shift+F is bound', shortcuts.includes('Alt+Shift+F') || shortcuts.includes('⌥⇧F'))

  await worker.evaluate((endpoint) => chrome.storage.sync.set({ endpoint, channel: 'ext-channel' }), ENDPOINT)
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${PAGE_PORT}`)

  const activated = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['console-hook.js'] })
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js', 'overlay.js'] })
    return chrome.tabs.sendMessage(tab.id, { type: 'tidy:toggle' })
  })
  step('background injects and toggles the overlay', activated?.ok === true && activated?.open === true)
  await composer(page)
  step('overlay renders under the extension', await zf(page, '.bar').isVisible())
  step('console hook lands in the page MAIN world', await page.evaluate(() => window.__tidyHooked === true))

  // Arm picking: without it this posts a whole-page item and the crop path below
  // is never executed, while the assertion still claims it was.
  await page.keyboard.press('Alt+KeyE')
  await page.click('#save-btn')
  await composer(page)
  step('chrome.tabs.captureVisibleTab produced a preview', await zf(page, '.shot').isVisible())

  await zf(page, 'textarea').fill('Sent through the loaded extension.')
  await zf(page, '.actions button.primary').click()
  await page.waitForSelector('[data-tidy=root] .toast', { timeout: 8000 })

  const item = listFeedback({ channel: 'ext-channel' })[0]
  step('collector stored the extension item', item?.source === 'extension')
  step('the extension item carries the picked element', item?.mode === 'element' && item?.element?.selector?.includes('#save-btn') === true)
  step('background cropped and stored a screenshot', typeof item?.screenshot === 'string' && existsSync(item.screenshot))
  // A crop of one button must be far smaller than the 1280x720 viewport shot.
  step('the stored screenshot is cropped to the element', statSync(item.screenshot).size < 40_000)

  await context.close()
}

pageServer.close()
collector.server?.close()
process.stdout.write(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
