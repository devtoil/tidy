function ago(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

function firstLine(text) {
  const line = String(text ?? '').split('\n')[0]
  return line.length > 100 ? `${line.slice(0, 100)}…` : line
}

export function formatSummary(item) {
  const where = item.element?.selector ?? (item.mode === 'region' ? `region ${item.region?.width}×${item.region?.height}` : 'page')
  return `${item.id}  ${ago(item.createdAt).padStart(7)}  ${item.mode.padEnd(7)}  ${firstLine(item.comment)}\n         ${item.page.url}\n         ${where}`
}

export function formatDetail(item) {
  const lines = [
    `# Feedback ${item.id}`,
    '',
    `- when: ${item.createdAt} (${ago(item.createdAt)})`,
    `- status: ${item.status}`,
    `- source: ${item.source}${item.channel === undefined ? '' : ` · channel ${item.channel}`}`,
    `- page: ${item.page.title ?? ''} — ${item.page.url}`,
    `- viewport: ${item.page.viewport?.width}×${item.page.viewport?.height} @${item.page.devicePixelRatio}x, scrolled to (${item.page.viewport?.scrollX}, ${item.page.viewport?.scrollY})`,
    `- mode: ${item.mode}`,
  ]

  if (item.screenshot !== undefined) lines.push(`- screenshot: ${item.screenshot}`)

  lines.push('', '## Comment', '', item.comment)

  if (item.element !== undefined) {
    const el = item.element
    lines.push(
      '',
      '## Selected element',
      '',
      `- selector: \`${el.selector}\``,
      `- tag: \`<${el.tag}>\`${el.classes.length === 0 ? '' : ` · classes: ${el.classes.join(' ')}`}`,
      `- accessible name: ${el.accessibleName === '' ? '(none)' : `"${el.accessibleName}"`}`,
      `- component chain: ${el.componentChain.length === 0 ? '(no custom elements)' : el.componentChain.map((tag) => `<${tag}>`).join(' ‹ ')}`,
      `- box: ${el.rect.width}×${el.rect.height} at viewport (${el.rect.x}, ${el.rect.y}) / page (${el.pageRect.x}, ${el.pageRect.y})`,
    )
    const attributes = Object.entries(el.attributes ?? {})
    if (attributes.length > 0) {
      lines.push('- attributes:', ...attributes.map(([key, value]) => `  - ${key}="${value}"`))
    }
    if (el.text !== undefined && el.text !== '') lines.push('', '### Element text', '', '```', el.text, '```')
    lines.push('', '### Computed styles', '', '```', ...Object.entries(el.styles ?? {}).map(([k, v]) => `${k}: ${v}`), '```')
    lines.push('', '### outerHTML', '', '```html', el.outerHTML ?? '', '```')
  }

  if (item.region !== undefined) {
    lines.push('', '## Selected region', '', `${item.region.width}×${item.region.height} at (${item.region.x}, ${item.region.y}) in the viewport`)
  }

  if (item.console.length > 0) {
    lines.push('', '## Console (captured since the overlay loaded)', '', '```', ...item.console.map((entry) => `[${entry.level}] ${entry.text}`), '```')
  }

  return lines.join('\n')
}

export const helpers = { ago }
