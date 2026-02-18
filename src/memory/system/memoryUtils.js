function normalizeText(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim()
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function tokenize(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_:\-\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function inferEmotion(text, type) {
  const line = String(text || '').toLowerCase()
  if (String(type || '').toLowerCase() === 'error' || line.includes('error') || line.includes('kicked')) return 'negative'
  if (line.includes('died') || line.includes('fail')) return 'negative'
  if (line.includes('success') || line.includes('spawned') || line.includes('found') || line.includes('crafted')) return 'positive'
  return 'neutral'
}

function inferImportance({ text, type, meta }) {
  const line = String(text || '').toLowerCase()
  const t = String(type || '').toLowerCase()

  let importance = 0.38
  if (t === 'error' || t === 'command') importance += 0.25
  if (t === 'action-success' || t === 'action-fail') importance += 0.16
  if (t === 'chat-in' || t === 'chat-out') importance += 0.08
  if (t === 'world' || t === 'session') importance += 0.12

  if (line.includes('dragon') || line.includes('nether') || line.includes('diamond') || line.includes('death')) importance += 0.15
  if (line.includes('kicked') || line.includes('error')) importance += 0.2

  if (meta && typeof meta === 'object') {
    if (meta.important === true) importance += 0.25
    if (typeof meta.importance === 'number') importance = (importance + meta.importance) / 2
  }

  return clamp(importance, 0.08, 1)
}

function inferTags({ content, type, meta }) {
  const tokens = tokenize(content)
  const tags = new Set([String(type || 'note').toLowerCase()])

  const allow = ['minecraft', 'diamond', 'emerald', 'forest', 'cave', 'mine', 'craft', 'furnace', 'sleep', 'chat', 'player', 'follow', 'combat', 'pvp', 'creative', 'survival', 'error', 'kicked', 'spawn']
  for (const token of tokens) {
    if (allow.includes(token)) tags.add(token)
  }

  if (meta && typeof meta === 'object') {
    if (meta.playerName) tags.add(`player:${String(meta.playerName).toLowerCase()}`)
    if (meta.location) tags.add(`location:${String(meta.location).toLowerCase()}`)
    if (Array.isArray(meta.tags)) {
      for (const tag of meta.tags) tags.add(String(tag).toLowerCase())
    }
  }

  return Array.from(tags).slice(0, 16)
}

function inferContext(meta) {
  if (!meta || typeof meta !== 'object') return []
  const ctx = []
  for (const [key, value] of Object.entries(meta)) {
    if (value == null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      ctx.push(`${key}:${String(value).toLowerCase()}`)
    }
  }
  return ctx.slice(0, 20)
}

function relevanceScore(memory, { queryTokens = [], contextTokens = [], now = Date.now(), lambda = 0.08 } = {}) {
  const createdAt = Date.parse(memory.createdAt || memory.at || new Date().toISOString())
  const ageHours = Math.max(0, (now - createdAt) / 3_600_000)
  const recency = Math.exp(-lambda * ageHours)
  const importance = clamp(Number(memory.importance ?? 0.35), 0.05, 1)

  const tags = new Set((memory.tags || []).map((x) => String(x).toLowerCase()))
  const contentTokens = new Set(tokenize(memory.content || memory.text || ''))
  const context = new Set((memory.context || []).map((x) => String(x).toLowerCase()))

  const matches = (tokens) => {
    let count = 0
    for (const token of tokens) {
      if (tags.has(token) || contentTokens.has(token) || context.has(token)) count += 1
    }
    return count
  }

  const queryMatch = queryTokens.length ? matches(queryTokens) / queryTokens.length : 0
  const contextMatch = contextTokens.length ? matches(contextTokens) / contextTokens.length : 0

  const noveltyPenalty = Math.min(0.25, Math.max(0, (Number(memory.accessCount || 0) - 4) * 0.03))

  const score = (importance * 0.55) + (recency * 0.3) + (queryMatch * 0.25) + (contextMatch * 0.2) - noveltyPenalty
  return score
}

function compactSummary(memories = []) {
  if (!memories.length) return null

  const byType = new Map()
  const tagCount = new Map()

  for (const memory of memories) {
    const type = String(memory.type || 'note')
    byType.set(type, (byType.get(type) || 0) + 1)
    for (const tag of memory.tags || []) {
      tagCount.set(tag, (tagCount.get(tag) || 0) + 1)
    }
  }

  const topType = Array.from(byType.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || 'note'
  const topTypeStats = Array.from(byType.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([type, count]) => `${type} x${count}`)
  const topTags = Array.from(tagCount.entries())
    .filter(([tag]) => !String(tag).includes(':'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([tag]) => tag)

  const latest = memories
    .slice(-3)
    .map((m) => String(m.content || m.text || '').slice(0, 70))
    .filter(Boolean)

  const avgImportance = memories.reduce((sum, m) => sum + Number(m.importance || 0), 0) / memories.length
  const positive = memories.filter((m) => String(m.emotion || '').toLowerCase() === 'positive').length
  const negative = memories.filter((m) => String(m.emotion || '').toLowerCase() === 'negative').length
  const emotionalTone = negative > positive ? 'tense' : positive > negative ? 'positive' : 'mixed'

  const summaryText = [
    `Pattern window: ${memories.length} events`,
    `types=${topTypeStats.join(', ') || topType}`,
    `topics=${topTags.join(', ') || topType}`,
    `tone=${emotionalTone}`,
    `avgImp=${avgImportance.toFixed(2)}`,
    latest.length ? `latest=${latest.join(' | ')}` : '',
  ].filter(Boolean).join(' ; ')

  return {
    content: summaryText,
    type: 'summary',
    tags: ['summary', topType, ...topTags].slice(0, 12),
    importance: 0.62,
    emotion: 'neutral',
    references: memories.map((m) => m.id).slice(-20),
  }
}

module.exports = {
  normalizeText,
  clamp,
  tokenize,
  inferEmotion,
  inferImportance,
  inferTags,
  inferContext,
  relevanceScore,
  compactSummary,
}
