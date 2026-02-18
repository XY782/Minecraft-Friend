function nearestAttackTarget(bot, maxDistance = 4.5) {
  const self = bot?.entity
  if (!self?.position) return null

  const entities = Object.values(bot.entities || {})
    .filter((entity) => {
      if (!entity || !entity.position) return false
      if (entity.id === self.id) return false
      if (entity.type !== 'mob' && entity.type !== 'player') return false
      if (entity.type === 'player' && entity.username === bot.username) return false
      return self.position.distanceTo(entity.position) <= maxDistance
    })
    .sort((a, b) => self.position.distanceTo(a.position) - self.position.distanceTo(b.position))

  return entities[0] || null
}

module.exports = {
  nearestAttackTarget,
}
