function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function round2(value) {
  return Math.round(clamp01(value) * 100) / 100
}

function computeMood({ energy, frustration, confidence, socialDesire }) {
  if (frustration >= 0.72) return 'frustrated'
  if (energy <= 0.26) return 'tired'
  if (confidence >= 0.74 && frustration <= 0.3) return 'confident'
  if (socialDesire >= 0.72) return 'social'
  if (energy >= 0.62 && frustration <= 0.45) return 'curious'
  return 'focused'
}

function focusFromMode(mode = 'idle', lastAction = '') {
  const action = String(lastAction || '').toUpperCase()
  const lowerMode = String(mode || '').toLowerCase()

  if (['attack', 'attack-mob', 'attack-player', 'defend', 'evade'].includes(lowerMode) || action.includes('ATTACK')) return 'combat'
  if (action.includes('COLLECT') || action.includes('MINE') || action.includes('BREAK')) return 'resource-gathering'
  if (action.includes('BUILD')) return 'building'
  if (action.includes('CRAFT') || action.includes('FURNACE') || action.includes('ENCHANT')) return 'crafting'
  if (action.includes('SOCIAL') || lowerMode === 'follow') return 'social'
  if (action.includes('EAT')) return 'survival'
  return lowerMode === 'idle' ? 'scouting' : lowerMode
}

function createInternalStateController({ bot }) {
  const data = {
    mood: 'curious',
    energy: 0.72,
    focus: 'scouting',
    frustration: 0.18,
    confidence: 0.62,
    socialDesire: 0.34,
    ego: 0.52,
    shortTermGoal: 'scan nearby area',
    longTermDesire: 'stay safe while progressing gear',
    lastUpdatedAt: new Date().toISOString(),
  }

  function updateDerived(mode, lastAction) {
    data.focus = focusFromMode(mode, lastAction)
    data.mood = computeMood(data)
    data.shortTermGoal =
      data.focus === 'combat' ? 'win nearby fight safely'
      : data.focus === 'resource-gathering' ? 'gather useful materials'
      : data.focus === 'crafting' ? 'upgrade tools and loadout'
      : data.focus === 'social' ? 'stay with nearby players'
      : data.focus === 'survival' ? 'recover hunger and health'
      : 'scout and adapt'

    const health = Number(bot?.health ?? 20)
    if (health <= 8 || data.energy <= 0.25) data.longTermDesire = 'stabilize survival first'
    else if (data.confidence >= 0.72) data.longTermDesire = 'push progression and stronger gear'
    else data.longTermDesire = 'stay adaptive and reduce risk'

    data.lastUpdatedAt = new Date().toISOString()
  }

  function onTick({ mode = 'idle', lastAction = null, nearbyPlayers = 0, nearbyHostiles = 0 } = {}) {
    const combat = nearbyHostiles > 0 || String(mode).toLowerCase().includes('attack') || String(mode).toLowerCase() === 'evade'
    const idle = String(mode).toLowerCase() === 'idle'

    if (combat) data.energy = clamp01(data.energy - 0.035)
    else if (idle) data.energy = clamp01(data.energy + 0.02)
    else data.energy = clamp01(data.energy - 0.012)

    if (nearbyPlayers > 0) data.socialDesire = clamp01(data.socialDesire + 0.03)
    else data.socialDesire = clamp01(data.socialDesire - 0.015)

    if (!combat) data.frustration = clamp01(data.frustration - 0.015)
    updateDerived(mode, lastAction)
  }

  function onActionOutcome({ action, success }) {
    const name = String(action || '').toUpperCase()
    if (success) {
      data.confidence = clamp01(data.confidence + 0.04)
      data.frustration = clamp01(data.frustration - 0.03)
      data.ego = clamp01(data.ego + 0.02)
      if (name === 'EAT') data.energy = clamp01(data.energy + 0.1)
    } else {
      data.confidence = clamp01(data.confidence - 0.045)
      data.frustration = clamp01(data.frustration + 0.06)
      data.ego = clamp01(data.ego - 0.025)
    }

    updateDerived(data.focus, action)
  }

  function onChatSignal(direction = 'in') {
    const kind = String(direction || '').toLowerCase()
    if (kind === 'in') {
      data.socialDesire = clamp01(data.socialDesire + 0.06)
      data.confidence = clamp01(data.confidence + 0.01)
    } else {
      data.socialDesire = clamp01(data.socialDesire - 0.02)
    }
    updateDerived(data.focus, null)
  }

  function getSnapshot() {
    return {
      mood: data.mood,
      energy: round2(data.energy),
      focus: data.focus,
      frustration: round2(data.frustration),
      confidence: round2(data.confidence),
      socialDesire: round2(data.socialDesire),
      ego: round2(data.ego),
      shortTermGoal: data.shortTermGoal,
      longTermDesire: data.longTermDesire,
      lastUpdatedAt: data.lastUpdatedAt,
    }
  }

  return {
    onTick,
    onActionOutcome,
    onChatSignal,
    getSnapshot,
  }
}

module.exports = {
  createInternalStateController,
}
