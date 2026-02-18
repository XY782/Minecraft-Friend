function normalizeAction(raw) {
  const action = String(raw || '').trim().toUpperCase()
  const valid = new Set([
    'DEFEND',
    'ATTACK_MOB',
    'EAT',
    'EQUIP',
    'FLY',
    'GET_ITEMS',
    'USE_ITEM',
    'USE_TRIDENT',
    'ENCHANT',
    'USE_ANVIL',
    'BUILD',
    'BREAK',
    'SLEEP',
    'USE_FURNACE',
    'CRAFT',
    'COLLECT',
    'ATTACK_PLAYER',
    'HELP_PLAYER',
    'SOCIAL',
    'EXPLORE',
  ])

  return valid.has(action) ? action : null
}

function buildWorldSnapshot({ bot, config, utils }) {
  const nearbyPlayers = utils.getNearbyPlayers(bot, config.followMaxDist)
  const nearestHostileDistance = (() => {
    let best = Number.POSITIVE_INFINITY
    for (const entity of Object.values(bot.entities || {})) {
      if (!entity || entity.type !== 'mob') continue
      const n = String(entity.name || '').toLowerCase()
      if (![
        'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider', 'cave_spider',
        'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'slime', 'magma_cube', 'phantom'
      ].includes(n)) continue
      const d = utils.distanceToEntity(bot, entity)
      if (d < best) best = d
    }
    return Number.isFinite(best) ? Math.round(best * 10) / 10 : null
  })()

  const hasBedNearby = Boolean(bot.findBlock({
    matching: (block) => String(block?.name || '').endsWith('_bed'),
    maxDistance: config.sleepSearchRadius,
  }))

  const hasFurnaceNearby = Boolean(bot.findBlock({
    matching: (block) => {
      const name = String(block?.name || '')
      return name === 'furnace' || name === 'smoker' || name === 'blast_furnace'
    },
    maxDistance: config.furnaceSearchRadius,
  }))

  const hasCraftingTableNearby = Boolean(bot.findBlock({
    matching: (block) => String(block?.name || '') === 'crafting_table',
    maxDistance: config.craftingSearchRadius,
  }))

  const hasEnchantingTableNearby = Boolean(bot.findBlock({
    matching: (block) => String(block?.name || '') === 'enchanting_table',
    maxDistance: config.enchantSearchRadius || config.craftingSearchRadius,
  }))

  const hasAnvilNearby = Boolean(bot.findBlock({
    matching: (block) => {
      const n = String(block?.name || '')
      return n === 'anvil' || n === 'chipped_anvil' || n === 'damaged_anvil'
    },
    maxDistance: config.enchantSearchRadius || config.craftingSearchRadius,
  }))

  const inventoryNames = (bot.inventory?.items?.() || []).map((item) => item.name)
  const rawFoodCount = inventoryNames.filter((name) => ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'kelp'].includes(name)).length
  const hasWearableGear = inventoryNames.some((name) =>
    String(name || '').toLowerCase() === 'elytra' ||
    String(name || '').toLowerCase().endsWith('_helmet') ||
    String(name || '').toLowerCase().endsWith('_chestplate') ||
    String(name || '').toLowerCase().endsWith('_leggings') ||
    String(name || '').toLowerCase().endsWith('_boots')
  )
  const hasTrident = inventoryNames.some((name) => String(name || '').toLowerCase() === 'trident')
  const hasBuildBlocks = inventoryNames.some((name) => {
    const n = String(name || '').toLowerCase()
    return n.endsWith('_planks') || n.includes('stone') || n.includes('dirt')
  })
  const isCreative = String(bot.game?.gameMode || '').toLowerCase() === 'creative'

  return {
    health: typeof bot.health === 'number' ? bot.health : null,
    food: typeof bot.food === 'number' ? bot.food : null,
    isNight: typeof bot.time?.timeOfDay === 'number' ? bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458 : false,
    nearbyPlayerCount: nearbyPlayers.length,
    nearestHostileDistance,
    hasBedNearby,
    hasFurnaceNearby,
    hasCraftingTableNearby,
    hasEnchantingTableNearby,
    hasAnvilNearby,
    rawFoodCount,
    hasWearableGear,
    hasTrident,
    hasBuildBlocks,
    isCreative,
    inventorySample: inventoryNames.slice(0, 16),
  }
}

function heuristicPlan(snapshot, config) {
  const steps = []

  if (snapshot.nearestHostileDistance !== null && snapshot.nearestHostileDistance <= config.dangerRadius) {
    steps.push('DEFEND')
    steps.push('ATTACK_MOB')
  }

  if (typeof snapshot.food === 'number' && snapshot.food <= config.lowFoodThreshold) {
    steps.push('EAT')
  }

  if (snapshot.hasWearableGear) {
    steps.push('EQUIP')
  }

  if (snapshot.isCreative) {
    steps.push('GET_ITEMS')
    steps.push('USE_ITEM')
    steps.push('FLY')
  }

  if (snapshot.hasTrident) {
    steps.push('USE_TRIDENT')
  }

  if (snapshot.isNight && snapshot.hasBedNearby) {
    steps.push('SLEEP')
  }

  if (snapshot.rawFoodCount > 0 && snapshot.hasFurnaceNearby) {
    steps.push('USE_FURNACE')
  }

  if (snapshot.hasCraftingTableNearby) {
    steps.push('CRAFT')
  }

  if (snapshot.hasEnchantingTableNearby) {
    steps.push('ENCHANT')
  }

  if (snapshot.hasAnvilNearby) {
    steps.push('USE_ANVIL')
  }

  if (snapshot.hasBuildBlocks) {
    steps.push('BUILD')
    steps.push('BREAK')
  }

  steps.push('COLLECT')

  if (snapshot.nearbyPlayerCount > 0) {
    steps.push('ATTACK_PLAYER')
    steps.push('HELP_PLAYER')
  }

  if (snapshot.nearbyPlayerCount > 0) {
    steps.push('SOCIAL')
  }

  steps.push('EXPLORE')

  return Array.from(new Set(steps)).slice(0, config.planMaxSteps)
}

function parsePlanText(planText) {
  if (!planText) return []

  try {
    const parsed = JSON.parse(planText)
    if (Array.isArray(parsed)) {
      return parsed.map((item) => normalizeAction(item)).filter(Boolean)
    }

    if (Array.isArray(parsed.plan)) {
      return parsed.plan.map((item) => normalizeAction(item)).filter(Boolean)
    }
  } catch {}

  return String(planText)
    .split(/[\n,]/)
    .map((s) => s.replace(/[-*\d.)\s]/g, '').trim())
    .map((item) => normalizeAction(item))
    .filter(Boolean)
}

function createPlannerSkill({ bot, gemini, config, utils, sessionMemory, getProfileContext }) {
  let activePlan = []
  let currentGoal = 'survive and progress'
  let lastPlannedAt = 0
  const actionHistory = []
  const actionStats = new Map()

  function registerOutcome(action, success) {
    if (!action) return
    actionHistory.push(action)
    while (actionHistory.length > 8) actionHistory.shift()

    const prev = actionStats.get(action) || { success: 0, fail: 0 }
    if (success) prev.success += 1
    else prev.fail += 1
    actionStats.set(action, prev)
  }

  function rankActions(actions) {
    const unique = Array.from(new Set(actions.filter(Boolean)))
    return unique
      .map((action) => {
        const stat = actionStats.get(action) || { success: 0, fail: 0 }
        const recentPenalty = actionHistory.slice(-2).includes(action) ? 1.25 : 0
        const score = (stat.success * 1.1) - (stat.fail * 1.3) - recentPenalty
        return { action, score }
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.action)
  }

  async function replanIfNeeded(force = false) {
    const now = Date.now()
    if (!force && activePlan.length && now - lastPlannedAt < config.planIntervalMs) return

    const snapshot = buildWorldSnapshot({ bot, config, utils })
    let plannedActions = []

    if (config.plannerUseGemini && gemini?.generatePlan) {
      try {
        const response = await gemini.generatePlan({
          botName: bot.username,
          worldState: snapshot,
          allowedActions: [
            'DEFEND', 'ATTACK_MOB', 'EAT', 'EQUIP', 'FLY', 'GET_ITEMS', 'USE_ITEM', 'USE_TRIDENT', 'ENCHANT',
            'USE_ANVIL', 'BUILD', 'BREAK', 'SLEEP', 'USE_FURNACE', 'CRAFT', 'COLLECT', 'ATTACK_PLAYER',
            'HELP_PLAYER', 'SOCIAL', 'EXPLORE'
          ],
          maxSteps: config.planMaxSteps,
          sessionContext: sessionMemory?.getDecayedContextText({ perSession: 5 }) || '',
          profileContext: getProfileContext?.() || '',
        })

        plannedActions = parsePlanText(response)
      } catch (e) {
        console.log('planner gemini error', e)
      }
    }

    if (!plannedActions.length) {
      plannedActions = heuristicPlan(snapshot, config)
    }

    const ranked = rankActions(plannedActions)
    activePlan = ranked.slice(0, config.planMaxSteps)
    currentGoal = activePlan[0] ? `execute ${activePlan[0].toLowerCase()}` : 'stay adaptive'
    lastPlannedAt = now
  }

  function takeNextAction() {
    if (!activePlan.length) return null
    return activePlan.shift()
  }

  function consumeAction(action) {
    if (!action) return
    if (activePlan[0] === action) activePlan.shift()
  }

  function clearPlan() {
    activePlan = []
  }

  function getPlan() {
    return [...activePlan]
  }

  function getGoal() {
    return currentGoal
  }

  return {
    replanIfNeeded,
    takeNextAction,
    consumeAction,
    clearPlan,
    getPlan,
    getGoal,
    registerOutcome,
  }
}

module.exports = {
  createPlannerSkill,
}
