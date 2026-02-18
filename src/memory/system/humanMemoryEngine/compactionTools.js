const { randomUUID } = require('crypto')

const ENABLE_DETAILED_PERIODIC_SUMMARY = true
const MIN_SUMMARY_LINES = 40
const TARGET_SUMMARY_LINES = 46
const MAX_SUMMARY_LINES = 50

function createCompactionTools({
  session,
  markDirty,
  touchSessionLimits,
  parseTime,
  isHighImportance,
  isKeepRawEntry,
  workingWindowMs,
  compactSummary,
}) {
  function addSummaryEntry(summary, meta = {}) {
    if (!summary) return

    session.entries.push({
      id: randomUUID(),
      content: summary.content,
      type: summary.type,
      tags: summary.tags,
      importance: summary.importance,
      emotion: summary.emotion,
      context: [],
      createdAt: new Date().toISOString(),
      references: summary.references,
      summary: summary.content,
      meta,
      accessCount: 0,
      repeatCount: 1,
      consolidated: false,
    })
    touchSessionLimits()
    markDirty()
  }

  function maybeAddSummary() {
    if (!ENABLE_DETAILED_PERIODIC_SUMMARY) return

    const normalEntries = session.entries.filter((entry) => entry.type !== 'summary')
    if (normalEntries.length < 40) return

    const recent = normalEntries.slice(-30)
    const now = Date.now()
    const hasRecentSummary = session.entries
      .slice(-30)
      .some((entry) => {
        if (entry.type !== 'summary') return false
        return (now - parseTime(entry.createdAt)) <= 180_000
      })

    if (hasRecentSummary) return

    const summary = compactSummary(recent)
    if (!summary) return

    addSummaryEntry(summary, { source: 'pattern-window' })
  }

  function maybeAggregateRecent(item) {
    const now = Date.now()
    const recent = session.entries
      .slice(-40)
      .reverse()
      .find((entry) => {
        if (!entry) return false
        if (entry.type !== item.type) return false
        if (entry.content !== item.content) return false
        if (entry.type === 'summary') return false
        if (isHighImportance(entry) || isHighImportance(item)) return false
        const ageMs = now - parseTime(entry.createdAt)
        return ageMs <= workingWindowMs
      })

    if (!recent) return false

    recent.repeatCount = Number(recent.repeatCount || 1) + 1
    recent.meta = recent.meta && typeof recent.meta === 'object' ? recent.meta : {}
    recent.meta.repeatCount = recent.repeatCount
    recent.meta.lastSeenAt = new Date().toISOString()

    if (!isHighImportance(recent)) {
      recent.importance = Math.max(0.18, Number(recent.importance || 0.3) * 0.85)
    }

    recent.references = Array.from(new Set([...(recent.references || []), ...(item.references || [])])).slice(-8)
    recent.consolidated = false
    markDirty()
    return true
  }

  function consolidateWorkingMemory() {
    if (!ENABLE_DETAILED_PERIODIC_SUMMARY) return

    const now = Date.now()
    const recent = session.entries.filter((entry) => {
      if (!entry || entry.consolidated) return false
      if (entry.type === 'summary') return false
      const ageMs = now - parseTime(entry.createdAt)
      return ageMs <= workingWindowMs
    })

    if (recent.length < 12) return

    const grouped = new Map()
    const successActions = new Map()
    const failedActions = new Map()
    const playerMentions = new Map()
    const notableErrors = []
    const typeCounts = new Map()
    const tagCounts = new Map()
    const contextCounts = new Map()
    const emotionCounts = new Map()
    const intentMentions = []
    const locationMentions = []
    let totalImportance = 0
    let highImportanceCount = 0
    let repeatTotal = 0

    function bump(map, key) {
      if (!key) return
      map.set(key, (map.get(key) || 0) + 1)
    }

    function parseAction(content = '') {
      const line = String(content || '')
      const matched = line.match(/(?:Action|Fallback action)\s+(?:success|failed):\s*([A-Z_]+)/i)
      return matched?.[1] ? String(matched[1]).toUpperCase() : null
    }

    function topByCount(map, max = 5) {
      return Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, max)
        .map(([name, count]) => `${name} x${count}`)
    }

    function pushLine(lines, text) {
      lines.push(String(text || '').trim())
    }

    function padLines(lines) {
      const fallbackOperationalLines = [
        '- additional signal: no extra high-priority risk detected',
        '- additional signal: maintain current intent unless blocked',
        '- additional signal: prefer resource-positive actions',
        '- additional signal: avoid repeated failing action path',
        '- additional signal: preserve nearby player safety constraints',
      ]
      let fallbackIndex = 0
      while (lines.length < MIN_SUMMARY_LINES) {
        lines.push(fallbackOperationalLines[fallbackIndex % fallbackOperationalLines.length])
        fallbackIndex += 1
      }
      if (lines.length > MAX_SUMMARY_LINES) return lines.slice(0, MAX_SUMMARY_LINES)
      return lines
    }

    function extractIntent(content = '') {
      const line = String(content || '')
      const matched = line.match(/Intent\s+(?:selected|completed):\s*(.+)$/i)
      return matched?.[1] ? matched[1].trim() : ''
    }

    function extractLocation(content = '') {
      const line = String(content || '')
      const xyz = line.match(/\bX\s*=\s*(-?\d+)\s*,\s*Y\s*=\s*(-?\d+)\s*,\s*Z\s*=\s*(-?\d+)/i)
      if (!xyz) return ''
      return `X=${xyz[1]} Y=${xyz[2]} Z=${xyz[3]}`
    }

    for (const entry of recent) {
      if (isKeepRawEntry(entry)) continue
      const type = String(entry.type || 'note').toLowerCase()
      const dominantTag = (entry.tags || []).find((tag) => tag !== type) || type
      const key = `${type}|${dominantTag}`
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key).push(entry)

      typeCounts.set(type, (typeCounts.get(type) || 0) + 1)
      emotionCounts.set(String(entry.emotion || 'neutral'), (emotionCounts.get(String(entry.emotion || 'neutral')) || 0) + 1)
      totalImportance += Number(entry.importance || 0)
      repeatTotal += Number(entry.repeatCount || 1)
      if (isHighImportance(entry)) highImportanceCount += 1

      for (const tag of entry.tags || []) {
        const safeTag = String(tag || '').trim().toLowerCase()
        if (!safeTag) continue
        tagCounts.set(safeTag, (tagCounts.get(safeTag) || 0) + 1)
      }

      for (const contextItem of entry.context || []) {
        const safeContext = String(contextItem || '').trim().toLowerCase()
        if (!safeContext) continue
        contextCounts.set(safeContext, (contextCounts.get(safeContext) || 0) + 1)
      }

      const actionName = parseAction(entry.content)
      if (actionName && type === 'action-success') bump(successActions, actionName)
      if (actionName && type === 'action-fail') bump(failedActions, actionName)

      for (const tag of entry.tags || []) {
        if (String(tag).startsWith('player:')) bump(playerMentions, String(tag).replace('player:', ''))
      }

      if (type === 'error' || String(entry.content || '').toLowerCase().includes('error')) {
        notableErrors.push(String(entry.content || '').slice(0, 80))
      }

      const intent = extractIntent(entry.content)
      if (intent) intentMentions.push(intent)

      const loc = extractLocation(entry.content)
      if (loc) locationMentions.push(loc)
    }

    const groups = Array.from(grouped.values()).filter((items) => items.length >= 2)
    if (!groups.length) return

    const parts = groups.map((items) => {
      const label = String(items[0]?.type || 'note')
      return `${items.length} ${label}`
    })

    const successPart = topByCount(successActions, 6)
    const failPart = topByCount(failedActions, 6)
    const playerPart = topByCount(playerMentions, 6)
    const errorPart = notableErrors.slice(-2)
    const typePart = topByCount(typeCounts, 8)
    const tagPart = topByCount(tagCounts, 8)
    const contextPart = topByCount(contextCounts, 8)
    const emotionPart = topByCount(emotionCounts, 6)
    const recentIntentPart = Array.from(new Set(intentMentions)).slice(-4)
    const recentLocations = Array.from(new Set(locationMentions)).slice(-4)
    const averageImportance = recent.length ? (totalImportance / recent.length) : 0
    const averageRepeat = recent.length ? (repeatTotal / recent.length) : 0

    const lines = []
    pushLine(lines, '=== AUTONOMY CONSOLIDATED SUMMARY ===')
    pushLine(lines, `window: ~${Math.round(workingWindowMs / 1000)}s`) 
    pushLine(lines, `generatedAt: ${new Date().toISOString()}`)
    pushLine(lines, `eventsAnalyzed: ${recent.length}`)
    pushLine(lines, `groupClusters: ${groups.length}`)
    pushLine(lines, `highImportanceCount: ${highImportanceCount}`)
    pushLine(lines, `avgImportance: ${averageImportance.toFixed(3)}`)
    pushLine(lines, `avgRepeatCount: ${averageRepeat.toFixed(2)}`)

    pushLine(lines, '--- event type distribution ---')
    for (const row of typePart) pushLine(lines, `- ${row}`)

    pushLine(lines, '--- dominant tags ---')
    for (const row of tagPart) pushLine(lines, `- ${row}`)

    pushLine(lines, '--- dominant context cues ---')
    for (const row of contextPart) pushLine(lines, `- ${row}`)

    pushLine(lines, '--- emotional profile ---')
    for (const row of emotionPart) pushLine(lines, `- ${row}`)

    pushLine(lines, '--- action outcomes ---')
    pushLine(lines, successPart.length ? `- successes: ${successPart.join(', ')}` : '- successes: none')
    pushLine(lines, failPart.length ? `- failures: ${failPart.join(', ')}` : '- failures: none')
    pushLine(lines, playerPart.length ? `- player activity: ${playerPart.join(', ')}` : '- player activity: none')

    pushLine(lines, '--- intents and direction ---')
    pushLine(lines, recentIntentPart.length ? `- recent intents: ${recentIntentPart.join(' | ')}` : '- recent intents: none detected')
    pushLine(lines, parts.length ? `- mixed event signatures: ${parts.join(', ')}` : '- mixed event signatures: limited')

    pushLine(lines, '--- world observations ---')
    pushLine(lines, recentLocations.length ? `- location cues: ${recentLocations.join(' | ')}` : '- location cues: no explicit XYZ in recent events')
    pushLine(lines, errorPart.length ? `- notable errors: ${errorPart.join(' | ')}` : '- notable errors: none')

    pushLine(lines, '--- operational guidance ---')
    pushLine(lines, '- prioritize survival-critical actions before progression')
    pushLine(lines, '- if repeated failures on same action, pivot to fallback resource actions')
    pushLine(lines, '- keep intent stable unless risk level rises sharply')
    pushLine(lines, '- use nearby players as social/assist opportunities only when safe')
    pushLine(lines, '- avoid redundant action loops by honoring recent success/fail memory')

    const finalLines = padLines(lines).slice(0, TARGET_SUMMARY_LINES <= MAX_SUMMARY_LINES ? TARGET_SUMMARY_LINES : MAX_SUMMARY_LINES)

    const references = groups.flatMap((items) => items.map((item) => item.id)).slice(-32)
    const tags = ['summary', 'consolidated-window', 'structured', 'long-summary']
    for (const items of groups) {
      for (const tag of items[0]?.tags || []) {
        if (!tags.includes(tag)) tags.push(tag)
      }
    }

    addSummaryEntry({
      content: finalLines.join('\n'),
      type: 'summary',
      tags: tags.slice(0, 12),
      importance: failPart.length ? 0.7 : 0.58,
      emotion: failPart.length ? 'negative' : 'neutral',
      references,
    }, { source: 'structured-consolidation-v2', lineCount: finalLines.length })

    for (const items of groups) {
      for (const entry of items) {
        entry.consolidated = true
        if (!isHighImportance(entry)) {
          entry.importance = Math.max(0.15, Number(entry.importance || 0.3) * 0.85)
        }
      }
    }

    touchSessionLimits()
    markDirty()
  }

  return {
    addSummaryEntry,
    maybeAddSummary,
    maybeAggregateRecent,
    consolidateWorkingMemory,
  }
}

module.exports = {
  createCompactionTools,
}
