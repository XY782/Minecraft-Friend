function nearestDroppedItem({ bot, nearestEntity, distanceToEntity, maxDistance }) {
  const item = nearestEntity(bot, (entity) => entity.type === 'object' && entity.name === 'item')
  if (!item) return null
  return distanceToEntity(bot, item) <= maxDistance ? item : null
}

async function collectNearbyItem({ bot, goals, itemEntity, state, stopExploring }) {
  if (!itemEntity) return false

  try {
    state.setMode('collect')
    stopExploring()
    bot.pathfinder.setGoal(new goals.GoalNear(itemEntity.position.x, itemEntity.position.y, itemEntity.position.z, 1), false)
    return true
  } catch (e) {
    console.log('collect item error', e)
    return false
  } finally {
    if (state.getMode() === 'collect') state.setMode('idle')
  }
}

module.exports = {
  nearestDroppedItem,
  collectNearbyItem,
}
