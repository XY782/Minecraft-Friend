const { STATIONARY_ACTIONS, MOVEMENT_ACTIONS, COMBAT_ACTIONS } = require('./constants')

function heuristicCandidates(snapshot, config) {
  const steps = []

  if (snapshot.nearestMobDistance !== null && snapshot.nearestMobDistance <= config.dangerRadius) {
    steps.push('DEFEND', 'ATTACK_MOB', 'TOGGLE_OFFHAND')
  }

  if ((snapshot.nearbyMobCount || 0) > 0) {
    steps.push('ATTACK_MOB')
  }
  if (typeof snapshot.food === 'number' && snapshot.food <= config.lowFoodThreshold) steps.push('EAT')
  if (snapshot.hasWearableGear) steps.push('EQUIP')

  if (snapshot.isCreative) {
    steps.push('GET_ITEMS', 'USE_ITEM', 'FLY')
  }

  if (snapshot.hasTrident) steps.push('USE_TRIDENT')
  if (snapshot.isNight && snapshot.hasBedNearby) steps.push('SLEEP')
  if (snapshot.rawFoodCount > 0 && snapshot.hasFurnaceNearby) steps.push('USE_FURNACE')
  if (snapshot.hasCraftingTableNearby) steps.push('CRAFT')
  if (snapshot.hasEnchantingTableNearby) steps.push('ENCHANT')
  if (snapshot.hasAnvilNearby) steps.push('USE_ANVIL')
  if (snapshot.hasBuildBlocks) steps.push('BUILD', 'BREAK')

  steps.push('COLLECT')

  if (snapshot.nearbyPlayerCount > 0) {
    steps.push('SOCIAL', 'HELP_PLAYER', 'BUILD', 'BREAK')
    if (config.attackPlayers) steps.push('ATTACK_PLAYER')
  }

  steps.push('EXPLORE')

  return Array.from(new Set(steps)).slice(0, Math.max(6, config.planMaxSteps || 5))
}

function actionSlot(action) {
  if (STATIONARY_ACTIONS.has(action)) return 'stationary'
  if (MOVEMENT_ACTIONS.has(action)) return 'movement'
  if (COMBAT_ACTIONS.has(action)) return 'combat'
  return 'utility'
}

function buildBundleFromRanked(ranked, maxActions = 3) {
  const limit = Math.max(1, Math.min(3, Number(maxActions) || 1))
  const bundle = []
  const usedSlots = new Set()

  for (const action of ranked) {
    if (!action) continue
    if (bundle.includes(action)) continue

    const slot = actionSlot(action)
    if (slot === 'stationary') {
      if (bundle.length) continue
      bundle.push(action)
      break
    }

    if (usedSlots.has('stationary')) continue
    if (usedSlots.has(slot)) continue

    bundle.push(action)
    usedSlots.add(slot)
    if (bundle.length >= limit) break
  }

  if (!bundle.length && ranked[0]) return [ranked[0]]
  return bundle
}

module.exports = {
  heuristicCandidates,
  buildBundleFromRanked,
}
