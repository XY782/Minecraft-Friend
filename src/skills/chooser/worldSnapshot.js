const { isCreativeMode } = require('../../utils/gamemode')

function buildWorldSnapshot({ bot, config, utils }) {
  const nearbyPlayers = utils.getNearbyPlayers(bot, config.followMaxDist)
  const nearestMobDistance = (() => {
    let best = Number.POSITIVE_INFINITY
    for (const entity of Object.values(bot.entities || {})) {
      if (!entity || entity.type !== 'mob') continue
      const d = utils.distanceToEntity(bot, entity)
      if (d < best) best = d
    }
    return Number.isFinite(best) ? Math.round(best * 10) / 10 : null
  })()

  const nearbyMobCount = Object.values(bot.entities || {}).filter((entity) => entity && entity.type === 'mob').length

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
  const isCreative = isCreativeMode(bot)

  return {
    health: typeof bot.health === 'number' ? bot.health : null,
    food: typeof bot.food === 'number' ? bot.food : null,
    isNight: typeof bot.time?.timeOfDay === 'number' ? bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458 : false,
    nearbyPlayerCount: nearbyPlayers.length,
    nearestMobDistance,
    nearbyMobCount,
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
  }
}

module.exports = {
  buildWorldSnapshot,
}
