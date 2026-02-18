const { buildWorldSnapshot } = require('../chooser/worldSnapshot')

function extractActionText(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''

  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') {
      return parsed.action.trim()
    }
  } catch {}

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed && typeof parsed.action === 'string') return parsed.action.trim()
    } catch {}
  }

  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
}

function extractUrgentActions(raw) {
  const text = String(raw || '').trim()
  if (!text) return []

  function normalizeList(value) {
    if (!Array.isArray(value)) return []
    return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 2)
  }

  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      return normalizeList(parsed.urgent)
    }
  } catch {}

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      return normalizeList(parsed?.urgent)
    } catch {}
  }

  return text
    .split(/\r?\n|,/)
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 2)
}

function extractIntentPlan(raw) {
  const text = String(raw || '').trim()
  if (!text) return { intent: '', steps: [] }

  function normalize(parsed) {
    const intent = String(parsed?.intent || '').trim()
    const steps = Array.isArray(parsed?.steps)
      ? parsed.steps.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 6)
      : []
    return { intent, steps }
  }

  try {
    return normalize(JSON.parse(text))
  } catch {}

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      return normalize(JSON.parse(jsonMatch[0]))
    } catch {}
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const intent = lines[0] || ''
  const steps = lines.slice(1).map((line) => line.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean).slice(0, 6)
  return { intent, steps }
}

function extractActionList(raw) {
  const text = String(raw || '').trim()
  if (!text) return []

  function normalize(value) {
    if (!Array.isArray(value)) return []
    return value.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 6)
  }

  try {
    const parsed = JSON.parse(text)
    return normalize(parsed?.actions)
  } catch {}

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      return normalize(parsed?.actions)
    } catch {}
  }

  return text
    .split(/\r?\n|,/)
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 6)
}

function fallbackAction(snapshot, drives) {
  if (!snapshot) return 'explore nearby'
  if (snapshot.nearestMobDistance != null && snapshot.nearestMobDistance <= 7) return 'defend from nearest hostile'
  if (typeof snapshot.food === 'number' && snapshot.food <= 10) return 'eat food'
  if (snapshot.nearbyPlayerCount > 0 && Number(drives?.socialDesire || 0) >= 0.6) return 'talk to nearby player'
  if (snapshot.rawFoodCount > 0 && snapshot.hasFurnaceNearby) return 'use furnace to cook food'
  if (snapshot.hasWearableGear) return 'equip better gear'
  if (snapshot.nearbyPlayerCount > 0) return 'follow nearby player'
  return 'explore around and collect useful items'
}

function pickDiverseFallback(snapshot, drives, { failedAction } = {}) {
  const pool = []
  if (snapshot?.nearestMobDistance != null && snapshot.nearestMobDistance <= 8) pool.push('defend from nearest hostile')
  if (typeof snapshot?.food === 'number' && snapshot.food <= 10) pool.push('eat food')
  if (snapshot?.nearbyPlayerCount > 0 && Number(drives?.socialDesire || 0) >= 0.5) pool.push('talk to nearby player')
  if (snapshot?.rawFoodCount > 0 && snapshot?.hasFurnaceNearby) pool.push('use furnace to cook food')
  if (snapshot?.hasWearableGear) pool.push('equip better gear')
  pool.push('collect dropped item', 'explore around and collect useful items')

  const unique = Array.from(new Set(pool.filter(Boolean)))
  const filtered = unique.filter((entry) => String(entry).toLowerCase() !== String(failedAction || '').toLowerCase())
  const choices = filtered.length ? filtered : unique
  return choices[0] || fallbackAction(snapshot, drives)
}

function deriveAutonomousGoal(snapshot, drives) {
  const health = Number(snapshot?.health ?? 20)
  const food = Number(snapshot?.food ?? 20)
  const mobDistance = Number(snapshot?.nearestMobDistance ?? Number.POSITIVE_INFINITY)
  const players = Number(snapshot?.nearbyPlayerCount ?? 0)
  const focus = String(drives?.focus || '').toLowerCase()

  if (health <= 9 || food <= 8) return 'stabilize survival and avoid risky fights'
  if (mobDistance <= 8) return 'control nearby threats without overextending'
  if (!snapshot?.hasWearableGear) return 'improve gear quality before major combat'
  if (snapshot?.rawFoodCount > 0 && snapshot?.hasFurnaceNearby) return 'convert raw food into reliable supplies'
  if (players > 0 && (focus === 'social' || Number(drives?.socialDesire || 0) >= 0.55)) return 'support nearby players and stay combat ready'
  if (snapshot?.hasCraftingTableNearby || snapshot?.hasAnvilNearby || snapshot?.hasEnchantingTableNearby) return 'progress equipment and utility setup'
  return 'scout safely and gather useful resources'
}

function heuristicIntentPlan(snapshot, drives) {
  const intent = deriveAutonomousGoal(snapshot, drives)

  if (String(intent).includes('survival')) {
    return {
      intent,
      steps: ['eat food', 'equip better gear', 'avoid nearby hostiles', 'explore around and collect useful items'],
    }
  }

  if (String(intent).includes('threats')) {
    return {
      intent,
      steps: ['defend from nearest hostile', 'attack mob', 'equip better gear', 'collect dropped item'],
    }
  }

  if (String(intent).includes('gear')) {
    return {
      intent,
      steps: ['equip better gear', 'collect dropped item', 'use furnace to cook food', 'explore around and collect useful items'],
    }
  }

  if (String(intent).includes('support nearby players')) {
    return {
      intent,
      steps: ['follow nearby player', 'help nearby player', 'talk to nearby player', 'collect dropped item'],
    }
  }

  return {
    intent,
    steps: ['collect dropped item', 'explore around and collect useful items', 'equip better gear'],
  }
}

function heuristicSubgoalActions(subgoal, snapshot) {
  const line = String(subgoal || '').toLowerCase()
  if (!line) return []

  if (line.includes('pvp') || line.includes('duel') || line.includes('attack player')) {
    return ['attack player', 'attack player', 'attack player']
  }

  if (line.includes('survive') || line.includes('recover')) {
    return ['eat food', 'equip better gear', 'defend from nearest hostile']
  }

  if (line.includes('gather') || line.includes('collect')) {
    return ['collect dropped item', 'explore around and collect useful items']
  }

  if (line.includes('build')) {
    return ['collect dropped item', 'build something simple nearby']
  }

  if (snapshot?.nearbyPlayerCount > 0) {
    return ['follow nearby player', 'help nearby player']
  }

  return [String(subgoal).trim()]
}

function createDynamicAgent({ bot, config, gemini, utils, sessionMemory, getProfileContext, getInternalState }) {
  function deriveGoalNow() {
    const snapshot = buildWorldSnapshot({ bot, config, utils })
    const drives = getInternalState?.() || {}
    return {
      goal: deriveAutonomousGoal(snapshot, drives),
      snapshot,
      drives,
    }
  }

  async function decideNextAction({ currentGoal = '' } = {}) {
    const snapshot = buildWorldSnapshot({ bot, config, utils })
    const drives = getInternalState?.() || {}
    const profileContext = getProfileContext?.() || ''
    const recentMemory = sessionMemory?.getRelevantContextText?.({
      query: `${drives.focus || 'adaptive'} ${drives.shortTermGoal || ''}`,
      contextText: profileContext,
      tags: ['autonomy', 'planner', 'summary'],
      perSession: 8,
      limit: 14,
    }) || sessionMemory?.getDecayedContextText?.({ perSession: 5 }) || ''

    if (!gemini?.generateDynamicAction) {
      const fallback = fallbackAction(snapshot, drives)
      return {
        actionText: fallback,
        source: 'fallback-no-gemini',
        snapshot,
        drives,
      }
    }

    try {
      const raw = await gemini.generateDynamicAction({
        botName: bot.username,
        worldState: snapshot,
        drives,
        missionGoal: currentGoal || deriveAutonomousGoal(snapshot, drives),
        recentMemory,
        profileContext,
      })

      const actionText = extractActionText(raw)
      if (!actionText) {
        return {
          actionText: fallbackAction(snapshot, drives),
          source: 'fallback-empty',
          snapshot,
          drives,
          raw,
        }
      }

      return {
        actionText,
        source: 'gemini',
        snapshot,
        drives,
        raw,
      }
    } catch (error) {
      return {
        actionText: fallbackAction(snapshot, drives),
        source: 'fallback-error',
        snapshot,
        drives,
        error: String(error?.message || error),
      }
    }
  }

  async function decideUrgentActions() {
    const snapshot = buildWorldSnapshot({ bot, config, utils })
    const drives = getInternalState?.() || {}
    const profileContext = getProfileContext?.() || ''
    const recentMemory = sessionMemory?.getRelevantContextText?.({
      query: 'urgent survival priority',
      contextText: profileContext,
      tags: ['autonomy', 'emergency', 'summary'],
      perSession: 8,
      limit: 10,
    }) || sessionMemory?.getDecayedContextText?.({ perSession: 4 }) || ''

    const heuristicUrgent = []
    if (snapshot?.nearestMobDistance != null && snapshot.nearestMobDistance <= (config.dangerRadius || 10)) {
      heuristicUrgent.push('defend from nearest hostile')
    }
    if (typeof snapshot?.food === 'number' && snapshot.food <= Number(config.lowFoodThreshold || 10)) {
      heuristicUrgent.push('eat food now')
    }
    if (snapshot?.hasWearableGear && Number(snapshot?.health || 20) <= 12) {
      heuristicUrgent.push('equip better gear')
    }

    if (!heuristicUrgent.length) {
      return {
        urgentActions: [],
        source: 'none',
        snapshot,
        drives,
      }
    }

    if (!gemini?.generateUrgency) {
      return {
        urgentActions: heuristicUrgent.slice(0, 2),
        source: 'heuristic-only',
        snapshot,
        drives,
      }
    }

    return {
      urgentActions: heuristicUrgent.slice(0, 2),
      source: 'heuristic-priority',
      snapshot,
      drives,
    }
  }

  async function proposeIntentPlan({ currentIntent = '', progressNotes = [] } = {}) {
    const snapshot = buildWorldSnapshot({ bot, config, utils })
    const drives = getInternalState?.() || {}
    const profileContext = getProfileContext?.() || ''
    const recentMemory = sessionMemory?.getRelevantContextText?.({
      query: `${currentIntent || 'intent planning'} ${progressNotes.join(' ')}`,
      contextText: profileContext,
      tags: ['autonomy', 'intent', 'summary'],
      perSession: 8,
      limit: 14,
    }) || sessionMemory?.getDecayedContextText?.({ perSession: 5 }) || ''

    if (!gemini?.generateIntentPlan) {
      return heuristicIntentPlan(snapshot, drives)
    }

    try {
      const raw = await gemini.generateIntentPlan({
        botName: bot.username,
        worldState: snapshot,
        drives,
        currentIntent,
        progressNotes,
        recentMemory,
        profileContext,
      })

      const parsed = extractIntentPlan(raw)
      if (!parsed.intent || !parsed.steps.length) {
        return heuristicIntentPlan(snapshot, drives)
      }

      return parsed
    } catch {
      return heuristicIntentPlan(snapshot, drives)
    }
  }

  async function proposeStrategicPlan({ currentIntent = '', progressNotes = [] } = {}) {
    const plan = await proposeIntentPlan({ currentIntent, progressNotes })
    const strategicIntent = String(plan?.intent || '').trim()
    const subgoals = Array.isArray(plan?.steps) ? plan.steps.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 8) : []

    return {
      strategicIntent,
      subgoals,
      priority: strategicIntent.toLowerCase().includes('survive') ? 1.0 : 0.7,
    }
  }

  async function expandSubgoalPlan({ strategicIntent = '', subgoal = '' } = {}) {
    const cleanSubgoal = String(subgoal || '').trim()
    if (!cleanSubgoal) return []

    const snapshot = buildWorldSnapshot({ bot, config, utils })
    const drives = getInternalState?.() || {}
    const profileContext = getProfileContext?.() || ''
    const recentMemory = sessionMemory?.getRelevantContextText?.({
      query: `${strategicIntent} ${cleanSubgoal}`,
      contextText: profileContext,
      tags: ['autonomy', 'intent', 'subgoal'],
      perSession: 8,
      limit: 12,
    }) || sessionMemory?.getDecayedContextText?.({ perSession: 4 }) || ''

    if (!gemini?.generateSubgoalActions) {
      return heuristicSubgoalActions(cleanSubgoal, snapshot)
    }

    try {
      const raw = await gemini.generateSubgoalActions({
        botName: bot.username,
        strategicIntent,
        subgoal: cleanSubgoal,
        worldState: snapshot,
        drives,
        recentMemory,
        profileContext,
      })

      const actions = extractActionList(raw)
      return actions.length ? actions : heuristicSubgoalActions(cleanSubgoal, snapshot)
    } catch {
      return heuristicSubgoalActions(cleanSubgoal, snapshot)
    }
  }

  return {
    decideNextAction,
    decideUrgentActions,
    pickDiverseFallback,
    deriveAutonomousGoal,
    deriveGoalNow,
    proposeIntentPlan,
    proposeStrategicPlan,
    expandSubgoalPlan,
  }
}

module.exports = {
  createDynamicAgent,
}
