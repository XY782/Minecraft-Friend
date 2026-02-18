function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function chance(probability) {
  return Math.random() < probability
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function distanceToEntity(bot, entity) {
  if (!entity || !bot.entity) return Number.POSITIVE_INFINITY
  return bot.entity.position.distanceTo(entity.position)
}

function nearestEntity(bot, filterFn) {
  if (!bot.entity) return null
  let winner = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const entity of Object.values(bot.entities)) {
    if (!entity || !filterFn(entity)) continue
    const d = distanceToEntity(bot, entity)
    if (d < bestDistance) {
      bestDistance = d
      winner = entity
    }
  }

  return winner
}

function getNearbyPlayers(bot, maxDistance = 16) {
  return Object.values(bot.entities)
    .filter((entity) => entity && entity.type === 'player' && entity.username && entity.username !== bot.username)
    .map((entity) => ({ entity, distance: distanceToEntity(bot, entity) }))
    .filter((entry) => entry.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
}

module.exports = {
  randInt,
  chance,
  wait,
  distanceToEntity,
  nearestEntity,
  getNearbyPlayers,
}
