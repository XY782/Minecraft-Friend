function getBlockName(bot, position) {
  try {
    const block = bot.blockAt(position)
    return block?.name || null
  } catch {
    return null
  }
}

function getBiomeName(bot) {
  try {
    if (bot.biome?.name) return bot.biome.name

    const pos = bot.entity?.position
    if (!pos || !bot.world?.getBiome) return 'unknown'

    const biomeId = bot.world.getBiome(pos)
    const biome = bot.registry?.biomes?.[biomeId]
    return biome?.name || 'unknown'
  } catch {
    return 'unknown'
  }
}

function getWeather(bot) {
  const isRaining = Boolean(bot.isRaining)
  const thunder = Number(bot.thunderState || 0)

  if (thunder > 0.4) return 'thunder'
  if (isRaining) return 'rain'
  return 'clear'
}

function summarizeInventory(bot, maxItems = 12) {
  const counts = new Map()
  for (const item of bot.inventory?.items?.() || []) {
    const name = String(item?.name || '')
    if (!name) continue
    counts.set(name, (counts.get(name) || 0) + Number(item.count || 0))
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxItems)
    .map(([name, count]) => `${name} x${count}`)
}

function equipmentSummary(entity) {
  const slots = entity?.equipment || []
  return slots
    .map((item) => String(item?.name || '').trim())
    .filter(Boolean)
    .slice(0, 6)
}

function nearbyPlayerPerception(bot, maxPlayers = 6) {
  const self = bot.entity
  if (!self) return []

  return Object.values(bot.entities || {})
    .filter((entity) => entity && entity.type === 'player' && entity.username && entity.username !== bot.username)
    .map((entity) => ({
      username: entity.username,
      distance: Math.round(self.position.distanceTo(entity.position) * 10) / 10,
      location: {
        x: Math.floor(entity.position.x),
        y: Math.floor(entity.position.y),
        z: Math.floor(entity.position.z),
      },
      heldItem: entity.heldItem?.name || null,
      wornItems: equipmentSummary(entity),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxPlayers)
}

function getSurroundings(bot) {
  const pos = bot.entity?.position
  if (!pos) return []

  const around = [
    pos.offset(1, 0, 0),
    pos.offset(-1, 0, 0),
    pos.offset(0, 0, 1),
    pos.offset(0, 0, -1),
    pos.offset(0, -1, 0),
    pos.offset(0, 1, 0),
  ]

  return around
    .map((p) => getBlockName(bot, p))
    .filter(Boolean)
    .slice(0, 6)
}

function buildProfileContext(bot, behavior = {}) {
  const pos = bot.entity?.position
  const now = new Date()

  const profile = {
    realDateISO: now.toISOString(),
    username: bot.username,
    health: typeof bot.health === 'number' ? bot.health : null,
    food: typeof bot.food === 'number' ? bot.food : null,
    weather: getWeather(bot),
    biome: getBiomeName(bot),
    inGameTimeOfDay: typeof bot.time?.timeOfDay === 'number' ? bot.time.timeOfDay : null,
    location: pos
      ? {
          x: Math.floor(pos.x),
          y: Math.floor(pos.y),
          z: Math.floor(pos.z),
          heightY: Math.floor(pos.y),
        }
      : null,
    surroundings: getSurroundings(bot),
    nearbyPlayers: nearbyPlayerPerception(bot, 6),
    inventoryTop: summarizeInventory(bot, 12),
    behavior: {
      mode: behavior.behaviorMode || null,
      lastAction: behavior.lastAction || null,
      goal: behavior.autonomyGoal || null,
      internalState: behavior.internalState || null,
    },
  }

  return JSON.stringify(profile, null, 2)
}

module.exports = {
  buildProfileContext,
}
