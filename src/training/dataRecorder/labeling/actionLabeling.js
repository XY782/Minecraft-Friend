function createActionLabeling({ inventorySignature = () => '' } = {}) {
  let lastObserverInteractionState = null

  function inferLikelyActions({ state, entities, inventory, blockFront, blockBelow, nearbyBlocks, heldItem }) {
    const scores = new Map()
    const add = (action, weight) => {
      const key = String(action || '').toUpperCase()
      if (!key) return
      const prev = Number(scores.get(key) || 0)
      scores.set(key, prev + Number(weight || 0))
    }

    const hunger = Number(state?.hunger || 20)
    const health = Number(state?.health || 20)
    const entitiesList = Array.isArray(entities) ? entities : []
    const inventoryList = Array.isArray(inventory) ? inventory : []
    const blocksList = Array.isArray(nearbyBlocks) ? nearbyBlocks : []
    const heldName = String(heldItem?.name || '').toLowerCase()
    const front = String(blockFront || '').toLowerCase()
    const below = String(blockBelow || '').toLowerCase()

    const hasItemDrops = entitiesList.some((entity) => String(entity?.name || '').toLowerCase() === 'item')
    const hasHostiles = entitiesList.some((entity) => String(entity?.type || '').toLowerCase() === 'mob')
    const hasPlayers = entitiesList.some((entity) => String(entity?.type || '').toLowerCase() === 'player')
    const hasInventory = inventoryList.length > 0

    const hasFood = inventoryList.some((item) => {
      const n = String(item?.name || '').toLowerCase()
      return /bread|beef|pork|chicken|carrot|potato|apple|stew|food/.test(n)
    })
    const hasWeapon = inventoryList.some((item) => {
      const n = String(item?.name || '').toLowerCase()
      return /sword|axe|trident|bow|crossbow/.test(n)
    })
    const hasBuildBlocks = inventoryList.some((item) => {
      const n = String(item?.name || '').toLowerCase()
      return /planks|cobblestone|stone|dirt|sand|gravel|netherrack|brick|block/.test(n)
    })

    const hasMiningToolInHand = /pickaxe|axe|shovel|hoe/.test(heldName)
    const frontSolid = front && front !== 'air' && front !== 'cave_air' && front !== 'void_air'
    const frontResource = /log|ore|stone|deepslate|dirt|grass_block|gravel|sand|clay|netherrack|blackstone|basalt/.test(front)
    const nearCraftingTable = blocksList.some((entry) => String(entry?.block || '').toLowerCase() === 'crafting_table')
    const nearFurnace = blocksList.some((entry) => String(entry?.block || '').toLowerCase().includes('furnace'))
    const nearEnchant = blocksList.some((entry) => String(entry?.block || '').toLowerCase().includes('enchanting_table'))
    const nearAnvil = blocksList.some((entry) => String(entry?.block || '').toLowerCase().includes('anvil'))

    if (hasHostiles || health <= 10) add('DEFEND', 1.2)
    if (hasHostiles && hasWeapon) add('ATTACK_MOB', 1.0)
    if (hasItemDrops) add('COLLECT', 1.15)
    if (hunger <= 12 && (hasInventory || hasFood)) add('EAT', 0.95)
    if (hasPlayers) {
      add('SOCIAL', 0.95)
      add('HELP_PLAYER', 0.6)
    }

    if (frontSolid && frontResource && (hasMiningToolInHand || hasWeapon)) add('BREAK', 1.2)
    if (hasBuildBlocks && !frontSolid && below && below !== 'air' && below !== 'cave_air' && below !== 'void_air') add('BUILD', 0.9)
    if (nearCraftingTable) add('CRAFT', 0.85)
    if (nearFurnace) add('USE_FURNACE', 0.7)
    if (nearEnchant) add('ENCHANT', 0.65)
    if (nearAnvil) add('USE_ANVIL', 0.65)

    add('EXPLORE', 0.45)
    if (!scores.size) add('IDLE', 0.4)

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
      .slice(0, 6)
  }

  function classifyObserverInteractionAction({
    actionLabel,
    likelyActions,
    heldItem,
    inventory,
    nearbyEntities,
    nearbyBlocksSurface,
    lineOfSight,
  }) {
    const currentLabel = String(actionLabel || '').toUpperCase()
    const motionOnly = /^OBSERVER_(IDLE|MOVE|SPRINT|JUMP|LOOK)$/.test(currentLabel)
    if (!motionOnly) return currentLabel

    const airLike = (name) => {
      const n = String(name || '').toLowerCase()
      return n === 'air' || n === 'cave_air' || n === 'void_air' || n === 'unknown'
    }

    const sumInventory = (items = []) => (Array.isArray(items) ? items : []).reduce((sum, item) => sum + Number(item?.count || 0), 0)
    const inventorySig = inventorySignature(inventory)
    const surfaceSig = (Array.isArray(nearbyBlocksSurface) ? nearbyBlocksSurface : [])
      .slice(0, 16)
      .map((entry) => `${entry?.dx}:${entry?.dz}:${entry?.topDy}:${String(entry?.block || 'unknown')}`)
      .join('|')
    const lookHit = (Array.isArray(lineOfSight) ? lineOfSight : []).find((entry) => !airLike(entry?.block)) || null
    const lookBlock = String(lookHit?.block || 'air').toLowerCase()
    const lookDist = Number(lookHit?.distance || 99)
    const heldName = String(heldItem?.name || '').toLowerCase()
    const hasTool = /pickaxe|axe|shovel|hoe/.test(heldName)
    const hasWeapon = /sword|axe|trident|bow|crossbow/.test(heldName)
    const hasFoodInHand = /bread|beef|pork|chicken|carrot|potato|apple|stew|food/.test(heldName)
    const hostileCount = (Array.isArray(nearbyEntities) ? nearbyEntities : []).filter((entity) => String(entity?.aggressionLevel || '').toLowerCase() === 'hostile').length
    const nearestHostileDist = (Array.isArray(nearbyEntities) ? nearbyEntities : [])
      .filter((entity) => String(entity?.aggressionLevel || '').toLowerCase() === 'hostile')
      .reduce((min, entity) => Math.min(min, Number(entity?.distance || 99)), 99)

    const prev = lastObserverInteractionState
    const totalInventory = sumInventory(inventory)

    let inferred = currentLabel
    if (prev) {
      const inventoryDelta = totalInventory - Number(prev.totalInventory || 0)
      const inventoryChanged = inventorySig !== String(prev.inventorySig || '')
      const surfaceChanged = surfaceSig !== String(prev.surfaceSig || '')
      const lookChangedToAir = !airLike(prev.lookBlock) && airLike(lookBlock)
      const lookChangedFromAir = airLike(prev.lookBlock) && !airLike(lookBlock)
      const closeInteractRange = Number.isFinite(lookDist) && lookDist <= 4.6

      if (surfaceChanged && closeInteractRange && lookChangedToAir && (hasTool || hasWeapon)) {
        inferred = 'OBSERVER_BREAK'
      } else if (surfaceChanged && closeInteractRange && lookChangedFromAir) {
        inferred = 'OBSERVER_BUILD'
      } else if (inventoryChanged && inventoryDelta > 0) {
        inferred = 'OBSERVER_COLLECT'
      } else if (inventoryChanged && inventoryDelta < 0 && hasFoodInHand) {
        inferred = 'OBSERVER_EAT'
      } else if (hostileCount > 0 && nearestHostileDist <= 4.2 && hasWeapon) {
        inferred = 'OBSERVER_ATTACK'
      } else if (hostileCount > 0 && nearestHostileDist <= 3.0) {
        inferred = 'OBSERVER_DEFEND'
      }
    }

    const likelyTop = String((likelyActions || [])[0] || '').toUpperCase()
    if (inferred === currentLabel && likelyTop) {
      if (likelyTop === 'BREAK') inferred = 'OBSERVER_BREAK'
      else if (likelyTop === 'BUILD') inferred = 'OBSERVER_BUILD'
      else if (likelyTop === 'COLLECT') inferred = 'OBSERVER_COLLECT'
      else if (likelyTop === 'ATTACK_MOB' || likelyTop === 'ATTACK_PLAYER') inferred = 'OBSERVER_ATTACK'
      else if (likelyTop === 'DEFEND') inferred = 'OBSERVER_DEFEND'
      else if (likelyTop === 'CRAFT') inferred = 'OBSERVER_CRAFT'
      else if (likelyTop === 'USE_FURNACE') inferred = 'OBSERVER_USE_FURNACE'
      else if (likelyTop === 'ENCHANT') inferred = 'OBSERVER_ENCHANT'
      else if (likelyTop === 'USE_ANVIL') inferred = 'OBSERVER_USE_ANVIL'
      else if (likelyTop === 'EAT') inferred = 'OBSERVER_EAT'
    }

    lastObserverInteractionState = {
      inventorySig,
      totalInventory,
      surfaceSig,
      lookBlock,
      lookDist,
      hostileCount,
      nearestHostileDist,
      heldName,
      at: Date.now(),
    }

    return inferred
  }

  function promoteObserverActionLabel(actionLabel, likelyActions = []) {
    const current = String(actionLabel || '').toUpperCase()
    if (!/^OBSERVER_(IDLE|MOVE|SPRINT|JUMP|LOOK)$/.test(current)) return current

    const preferred = Array.isArray(likelyActions) ? likelyActions.map((x) => String(x || '').toUpperCase()) : []
    const first = preferred[0] || ''
    const topMap = {
      BREAK: 'OBSERVER_BREAK',
      BUILD: 'OBSERVER_BUILD',
      COLLECT: 'OBSERVER_COLLECT',
      ATTACK_MOB: 'OBSERVER_ATTACK',
      ATTACK_PLAYER: 'OBSERVER_ATTACK',
      DEFEND: 'OBSERVER_DEFEND',
      CRAFT: 'OBSERVER_CRAFT',
      USE_FURNACE: 'OBSERVER_USE_FURNACE',
      ENCHANT: 'OBSERVER_ENCHANT',
      USE_ANVIL: 'OBSERVER_USE_ANVIL',
      EAT: 'OBSERVER_EAT',
      SOCIAL: 'OBSERVER_LOOK',
    }

    const promoted = topMap[first]
    return promoted || current
  }

  function labelQuality({ actionSource, observerDerived = false, isObserverSample = false }) {
    const source = String(actionSource || '').toLowerCase()
    if (source === 'user-telemetry') return 'ground-truth-outcome'
    if (observerDerived || source === 'observer-derived') return 'heuristic-inferred'
    if (source === 'observer-mode') return 'observer-motion'
    if (source === 'decision-engine' || source === 'policy-model' || source === 'dynamic-decision' || source === 'intent-step' || source === 'forced-action') {
      return 'ground-truth-outcome'
    }
    if (source === 'state-only' || source === 'sanitized-state') return 'state-fallback'
    return isObserverSample ? 'observer-motion' : 'state-fallback'
  }

  function resetObserverInteractionState() {
    lastObserverInteractionState = null
  }

  return {
    inferLikelyActions,
    classifyObserverInteractionAction,
    promoteObserverActionLabel,
    labelQuality,
    resetObserverInteractionState,
  }
}

module.exports = {
  createActionLabeling,
}
