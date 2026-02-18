const path = require('path')
const { randomUUID } = require('crypto')
const { createJsonMemoryStore } = require('../fileStore')
const {
  normalizeText,
  tokenize,
  inferEmotion,
  inferImportance,
  inferTags,
  inferContext,
  relevanceScore,
  compactSummary,
} = require('../memoryUtils')
const {
  DEFAULT_DECAYS,
  DEFAULT_CONSOLIDATION_MS,
  DEFAULT_WORKING_WINDOW_MS,
} = require('./constants')
const {
  parseTime,
  isHighImportance,
  isKeepRawEntry,
  createNormalizeLegacyEntry,
} = require('./entryUtils')
const { formatDecayedContext, formatRelevantContext } = require('./contextText')
const { createCompactionTools } = require('./compactionTools')

function createSessionMemory({
  filePath,
  maxSessions = 5,
  decays = DEFAULT_DECAYS,
  maxEntriesPerSession = 160,
  flushIntervalMs = 30_000,
  consolidationIntervalMs = DEFAULT_CONSOLIDATION_MS,
  workingWindowMs = DEFAULT_WORKING_WINDOW_MS,
}) {
  const resolvedPath = filePath || path.join(__dirname, '..', '..', '..', 'data', 'session-memory.json')
  const store = createJsonMemoryStore(resolvedPath)

  const normalizeLegacyEntry = createNormalizeLegacyEntry({
    normalizeText,
    inferTags,
    inferImportance,
    inferEmotion,
    inferContext,
  })

  const loaded = store.load() || { sessions: [] }
  const ram = {
    sessions: Array.isArray(loaded.sessions)
      ? loaded.sessions.map((session) => ({
          ...session,
          entries: Array.isArray(session.entries)
            ? session.entries.map(normalizeLegacyEntry).filter(Boolean)
            : [],
        }))
      : [],
    dirty: false,
  }

  const session = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    entries: [],
    meta: { reactedTo: {} },
  }

  ram.sessions.unshift(session)
  ram.sessions = ram.sessions.slice(0, maxSessions)
  ram.dirty = true

  function markDirty() {
    ram.dirty = true
  }

  function flush() {
    if (!ram.dirty) return
    ram.sessions = ram.sessions.slice(0, maxSessions)
    store.save({ sessions: ram.sessions })
    ram.dirty = false
  }

  const flushTimer = setInterval(() => {
    try {
      flush()
    } catch (e) {
      console.log('session memory flush error', e)
    }
  }, Math.max(10_000, Number(flushIntervalMs) || 30_000))

  if (typeof flushTimer.unref === 'function') flushTimer.unref()

  function pruneConsolidatedNoise() {
    if (!Array.isArray(session.entries)) return
    const now = Date.now()
    session.entries = session.entries.filter((entry) => {
      if (!entry) return false
      if (!entry.consolidated) return true
      if (isKeepRawEntry(entry)) return true

      const ageMs = now - parseTime(entry.createdAt)
      const oldEnough = ageMs >= 30_000
      const lowImportance = Number(entry.importance || 0) < 0.45
      return !(oldEnough && lowImportance)
    })
  }

  function touchSessionLimits() {
    pruneConsolidatedNoise()

    if (session.entries.length > maxEntriesPerSession) {
      const overflow = session.entries.length - maxEntriesPerSession
      let removed = 0

      session.entries = session.entries.filter((entry) => {
        if (removed >= overflow) return true
        if (!entry?.consolidated) return true
        if (isKeepRawEntry(entry)) return true
        removed += 1
        return false
      })

      if (session.entries.length > maxEntriesPerSession) {
        session.entries = session.entries.slice(-maxEntriesPerSession)
      }
    }
  }

  function findAssociations(nextEntry, maxRefs = 4) {
    const candidates = ram.sessions
      .slice(0, maxSessions)
      .flatMap((s) => (Array.isArray(s.entries) ? s.entries : []))
      .filter((entry) => entry && entry.id && entry.id !== nextEntry.id)
      .slice(-220)

    const queryTokens = tokenize(nextEntry.content)
    const contextTokens = (nextEntry.context || []).map((x) => String(x).toLowerCase())

    return candidates
      .map((entry) => ({ entry, score: relevanceScore(entry, { queryTokens, contextTokens }) }))
      .filter((x) => x.score >= 0.55)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxRefs)
      .map((x) => x.entry.id)
  }

  const {
    maybeAddSummary,
    maybeAggregateRecent,
    consolidateWorkingMemory,
  } = createCompactionTools({
    session,
    markDirty,
    touchSessionLimits,
    parseTime,
    isHighImportance,
    isKeepRawEntry,
    workingWindowMs,
    compactSummary,
  })

  function addMemory(text, type = 'note', meta = {}) {
    const content = normalizeText(text)
    if (!content) return

    const safeMeta = meta && typeof meta === 'object' ? meta : {}
    const item = {
      id: randomUUID(),
      content,
      type: String(type || 'note'),
      tags: inferTags({ content, type, meta: safeMeta }),
      importance: inferImportance({ text: content, type, meta: safeMeta }),
      emotion: String(safeMeta.emotion || inferEmotion(content, type)),
      context: inferContext(safeMeta),
      createdAt: new Date().toISOString(),
      references: [],
      summary: safeMeta.summary ? normalizeText(safeMeta.summary) : null,
      meta: safeMeta,
      accessCount: 0,
      repeatCount: Number(safeMeta.repeatCount || 1),
      consolidated: false,
    }

    item.references = findAssociations(item)

    if (maybeAggregateRecent(item)) {
      maybeAddSummary()
      return
    }

    session.entries.push(item)
    touchSessionLimits()
    maybeAddSummary()
    markDirty()
  }

  const consolidationTimer = setInterval(() => {
    try {
      consolidateWorkingMemory()
    } catch (e) {
      console.log('session memory consolidation error', e)
    }
  }, Math.max(10_000, Number(consolidationIntervalMs) || DEFAULT_CONSOLIDATION_MS))

  if (typeof consolidationTimer.unref === 'function') consolidationTimer.unref()

  function recentlyReacted(key, withinMs = 60_000) {
    const map = session.meta?.reactedTo || {}
    const last = parseTime(map[String(key || '').toLowerCase()])
    return (Date.now() - last) <= Math.max(1_000, Number(withinMs) || 60_000)
  }

  function markReaction(key) {
    if (!session.meta || typeof session.meta !== 'object') session.meta = { reactedTo: {} }
    if (!session.meta.reactedTo || typeof session.meta.reactedTo !== 'object') session.meta.reactedTo = {}
    session.meta.reactedTo[String(key || '').toLowerCase()] = new Date().toISOString()
    markDirty()
  }

  function endSession() {
    session.endedAt = new Date().toISOString()
    markDirty()
    flush()
    clearInterval(flushTimer)
    clearInterval(consolidationTimer)
  }

  function collectRanked({ query = '', contextText = '', tags = [], perSession = 8, limit = 20 } = {}) {
    const queryTokens = tokenize(query)
    const contextTokens = [...tokenize(contextText), ...tags.map((x) => String(x).toLowerCase())]
    const now = Date.now()

    const ranked = []
    const sessions = ram.sessions.slice(0, maxSessions)

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]
      const sessionDecay = typeof decays[i] === 'number' ? decays[i] : 0
      if (!sessionDecay) continue

      const entries = Array.isArray(s.entries) ? s.entries.slice(-Math.max(4, perSession * 4)) : []
      for (const entry of entries) {
        const score = relevanceScore(entry, { queryTokens, contextTokens, now }) * sessionDecay
        ranked.push({ entry, score, sessionIndex: i, sessionId: s.id, decay: sessionDecay })
      }
    }

    return ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit))
      .map((row) => {
        row.entry.accessCount = Number(row.entry.accessCount || 0) + 1
        return {
          sessionIndex: row.sessionIndex,
          sessionId: row.sessionId,
          decay: row.decay,
          score: row.score,
          id: row.entry.id,
          at: row.entry.createdAt,
          type: row.entry.type,
          text: row.entry.content,
          content: row.entry.content,
          tags: row.entry.tags || [],
          context: row.entry.context || [],
          importance: row.entry.importance,
          emotion: row.entry.emotion,
          references: row.entry.references || [],
          meta: row.entry.meta || {},
        }
      })
  }

  function getDecayedMemories({ perSession = 6 } = {}) {
    return collectRanked({ perSession, limit: Math.max(8, perSession * maxSessions) })
  }

  function getRelevantMemories({ query = '', contextText = '', tags = [], perSession = 8, limit = 14 } = {}) {
    return collectRanked({ query, contextText, tags, perSession, limit })
  }

  function getDecayedContextText({ perSession = 6 } = {}) {
    return formatDecayedContext(getDecayedMemories({ perSession }))
  }

  function getRelevantContextText({ query = '', contextText = '', tags = [], perSession = 8, limit = 14 } = {}) {
    return formatRelevantContext(getRelevantMemories({ query, contextText, tags, perSession, limit }))
  }

  function getSessionSummary() {
    return {
      totalSessions: ram.sessions.length,
      currentSessionId: session.id,
      decayProfile: decays.slice(0, maxSessions),
      storage: {
        mode: 'ram+periodic-json-backup',
        filePath: store.resolvedPath,
        flushIntervalMs: Math.max(10_000, Number(flushIntervalMs) || 30_000),
        consolidationIntervalMs: Math.max(10_000, Number(consolidationIntervalMs) || DEFAULT_CONSOLIDATION_MS),
        workingWindowMs: Math.max(10_000, Number(workingWindowMs) || DEFAULT_WORKING_WINDOW_MS),
      },
      sessions: ram.sessions.slice(0, maxSessions).map((s, index) => ({
        id: s.id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        entries: Array.isArray(s.entries) ? s.entries.length : 0,
        decay: typeof decays[index] === 'number' ? decays[index] : 0,
      })),
    }
  }

  flush()

  return {
    addMemory,
    endSession,
    flush,
    recentlyReacted,
    markReaction,
    getDecayedMemories,
    getDecayedContextText,
    getRelevantMemories,
    getRelevantContextText,
    getSessionSummary,
  }
}

module.exports = {
  createSessionMemory,
}
