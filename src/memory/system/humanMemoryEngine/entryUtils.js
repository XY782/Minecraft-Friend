const { randomUUID } = require('crypto')

function parseTime(value) {
  const t = Date.parse(value || '')
  return Number.isFinite(t) ? t : Date.now()
}

function isHighImportance(entry) {
  return Number(entry?.importance || 0) >= 0.75
}

function isKeepRawEntry(entry) {
  const type = String(entry?.type || '').toLowerCase()
  if (type === 'summary' || type === 'error' || type === 'world') return true
  if (isHighImportance(entry)) return true
  const emotion = String(entry?.emotion || 'neutral').toLowerCase()
  if (emotion === 'negative') return true
  return false
}

function createNormalizeLegacyEntry({ normalizeText, inferTags, inferImportance, inferEmotion, inferContext }) {
  return function normalizeLegacyEntry(entry) {
    if (!entry) return null

    if (entry.content && entry.createdAt) {
      return {
        ...entry,
        id: entry.id || randomUUID(),
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        references: Array.isArray(entry.references) ? entry.references : [],
        context: Array.isArray(entry.context) ? entry.context : [],
        meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : {},
        accessCount: Number(entry.accessCount || 0),
        repeatCount: Number(entry.repeatCount || entry?.meta?.repeatCount || 1),
        consolidated: Boolean(entry.consolidated),
        createdAt: entry.createdAt,
      }
    }

    const content = normalizeText(entry.text || entry.content || '')
    if (!content) return null

    const type = String(entry.type || 'note')
    const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {}

    return {
      id: randomUUID(),
      content,
      type,
      tags: inferTags({ content, type, meta }),
      importance: inferImportance({ text: content, type, meta }),
      emotion: inferEmotion(content, type),
      context: inferContext(meta),
      createdAt: entry.at || new Date().toISOString(),
      references: [],
      summary: null,
      meta,
      accessCount: 0,
      repeatCount: Number(meta.repeatCount || 1),
      consolidated: false,
    }
  }
}

module.exports = {
  parseTime,
  isHighImportance,
  isKeepRawEntry,
  createNormalizeLegacyEntry,
}
