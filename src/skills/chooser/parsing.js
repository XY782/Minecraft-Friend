const { VALID_ACTIONS } = require('./constants')

function normalizeAction(raw) {
  const action = String(raw || '').trim().toUpperCase()
  return VALID_ACTIONS.has(action) ? action : null
}

function parsePlanText(planText) {
  if (!planText) return []

  try {
    const parsed = JSON.parse(planText)
    if (Array.isArray(parsed)) return parsed.map((item) => normalizeAction(item)).filter(Boolean)
    if (Array.isArray(parsed.plan)) return parsed.plan.map((item) => normalizeAction(item)).filter(Boolean)
  } catch {}

  return String(planText)
    .split(/[\n,]/)
    .map((s) => s.replace(/[-*\d.)\s]/g, '').trim())
    .map((item) => normalizeAction(item))
    .filter(Boolean)
}

module.exports = {
  normalizeAction,
  parsePlanText,
}
