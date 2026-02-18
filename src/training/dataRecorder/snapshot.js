const { round } = require('./utils')

function buildNearbyBlocksGrid(bot, radius = 2, originPosition = null) {
  const basePosition = originPosition || bot?.entity?.position
  if (!basePosition) return []

  const points = []
  const base = basePosition.floored()
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const block = bot.blockAt(base.offset(dx, dy, dz))
        points.push({
          dx,
          dy,
          dz,
          block: block?.name || 'unknown',
        })
      }
    }
  }

  return points
}

function buildNearbyEntities(bot, maxDistance = 10, originEntity = null) {
  const self = originEntity || bot?.entity
  if (!self?.position) return []

  const entities = Object.values(bot.entities || {})
    .filter((entity) => entity && entity.id !== self.id && entity.position)
    .map((entity) => {
      const dist = self.position.distanceTo(entity.position)
      return {
        entity,
        dist,
      }
    })
    .filter(({ dist }) => Number.isFinite(dist) && dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 20)

  return entities.map(({ entity, dist }) => ({
    id: entity.id,
    type: entity.type || 'unknown',
    name: entity.name || entity.username || entity.displayName || 'unknown',
    distance: round(dist, 3),
    position: {
      x: round(entity.position.x),
      y: round(entity.position.y),
      z: round(entity.position.z),
    },
  }))
}

function getFacingStep(yawValue = null) {
  const yaw = Number(yawValue || 0)
  const dx = Math.round(-Math.sin(yaw))
  const dz = Math.round(-Math.cos(yaw))
  return {
    dx,
    dz,
  }
}

function getBlockContext(bot, subjectEntity = null) {
  const entity = subjectEntity || bot?.entity
  if (!entity?.position || !bot?.blockAt) {
    return {
      blockBelow: 'unknown',
      blockFront: 'unknown',
    }
  }

  const base = entity.position.floored()
  const facing = getFacingStep(entity?.yaw)
  const blockBelow = bot.blockAt(base.offset(0, -1, 0))
  const blockFront = bot.blockAt(base.offset(facing.dx, 0, facing.dz))

  return {
    blockBelow: blockBelow?.name || 'unknown',
    blockFront: blockFront?.name || 'unknown',
  }
}

function buildInventorySnapshot(bot) {
  const items = bot?.inventory?.items?.() || []
  return items.map((item) => ({
    name: item?.name || 'unknown',
    count: Number(item?.count || 0),
    slot: Number(item?.slot ?? -1),
    type: Number(item?.type ?? -1),
    metadata: Number(item?.metadata ?? 0),
  }))
}

function getControlSnapshot(bot) {
  const keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
  const state = {}
  for (const key of keys) {
    try {
      state[key] = Boolean(bot.getControlState?.(key))
    } catch {
      state[key] = false
    }
  }
  return state
}

function inferManualActionFromControls(controlState) {
  const moving = Boolean(
    controlState?.forward ||
    controlState?.back ||
    controlState?.left ||
    controlState?.right ||
    controlState?.jump
  )
  if (moving) return 'MANUAL_MOVE'
  if (Boolean(controlState?.sneak)) return 'MANUAL_SNEAK'
  return 'MANUAL_IDLE'
}

module.exports = {
  buildNearbyBlocksGrid,
  buildNearbyEntities,
  getBlockContext,
  buildInventorySnapshot,
  getControlSnapshot,
  inferManualActionFromControls,
}
