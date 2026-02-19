const { round } = require('./utils')

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function normalizeSigned(value, scale) {
  const denom = Math.max(1e-6, Number(scale) || 1)
  return round(clamp(Number(value || 0) / denom, -1, 1), 4)
}

function normalizeAngle(value) {
  const tau = Math.PI * 2
  let angle = Number(value || 0)
  while (angle > Math.PI) angle -= tau
  while (angle < -Math.PI) angle += tau
  return angle
}

function getFluidInfo(blockName = '', metadata = 0) {
  const lower = String(blockName || '').toLowerCase()
  if (lower.includes('water')) {
    return {
      fluidType: 'water',
      fluidLevel: Number.isFinite(Number(metadata)) ? Number(metadata) : null,
    }
  }
  if (lower.includes('lava')) {
    return {
      fluidType: 'lava',
      fluidLevel: Number.isFinite(Number(metadata)) ? Number(metadata) : null,
    }
  }
  return {
    fluidType: null,
    fluidLevel: null,
  }
}

function inferBlockTags(name = '', hardness = null) {
  const lower = String(name || '').toLowerCase()
  const hard = Number(hardness)
  const burnable = /wood|log|plank|leaves|wool|hay|bookshelf|tnt/.test(lower)
  const instant = /tall_grass|grass|snow|flower|vine|torch/.test(lower)
  const breakableByHand = instant || (Number.isFinite(hard) && hard > 0 && hard <= 0.8)

  return {
    flammable: burnable,
    breakableByHand,
  }
}

function getDurabilitySnapshot(item) {
  if (!item) return null
  const maxDurability = Number(item?.maxDurability)
  const durabilityUsed = Number(item?.durabilityUsed)
  if (!Number.isFinite(maxDurability) || maxDurability <= 0 || !Number.isFinite(durabilityUsed)) {
    return null
  }

  const remaining = Math.max(0, maxDurability - durabilityUsed)
  return {
    used: durabilityUsed,
    max: maxDurability,
    remaining,
    ratio: round(remaining / Math.max(1, maxDurability), 4),
  }
}

function extractEnchantments(item) {
  if (!item) return []
  if (Array.isArray(item?.enchants)) {
    return item.enchants.map((enchant) => ({
      id: String(enchant?.name || enchant?.id || 'unknown'),
      level: Number(enchant?.lvl || enchant?.level || 0),
    }))
  }
  return []
}

function serializeItem(item) {
  return {
    name: item?.name || 'unknown',
    count: Number(item?.count || 0),
    slot: Number(item?.slot ?? -1),
    type: Number(item?.type ?? -1),
    metadata: Number(item?.metadata ?? 0),
    durability: getDurabilitySnapshot(item),
    enchantments: extractEnchantments(item),
  }
}

function getBlockMetadata(bot, block) {
  const name = block?.name || 'unknown'
  const registryBlock = bot?.registry?.blocksByName?.[name]
  const hardness = Number.isFinite(Number(block?.hardness))
    ? Number(block.hardness)
    : (Number.isFinite(Number(registryBlock?.hardness)) ? Number(registryBlock.hardness) : null)
  const metadata = Number.isFinite(Number(block?.metadata)) ? Number(block.metadata) : null
  const skyLight = Number.isFinite(Number(block?.skyLight)) ? Number(block.skyLight) : null
  const blockLight = Number.isFinite(Number(block?.light)) ? Number(block.light) : null
  const biome = Number.isFinite(Number(block?.biome?.id))
    ? Number(block.biome.id)
    : (Number.isFinite(Number(block?.biome)) ? Number(block.biome) : null)
  const fluid = getFluidInfo(name, metadata)
  const tags = inferBlockTags(name, hardness)

  return {
    hardness,
    metadata,
    skyLight,
    blockLight,
    biome,
    fluidType: fluid.fluidType,
    fluidLevel: fluid.fluidLevel,
    tags,
  }
}

function buildNearbyBlocksGrid(bot, radius = 2, originPosition = null) {
  const basePosition = originPosition || bot?.entity?.position
  if (!basePosition) return []

  const points = []
  const base = basePosition.floored()
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const block = bot.blockAt(base.offset(dx, dy, dz))
        const metadata = getBlockMetadata(bot, block)
        points.push({
          dx,
          dy,
          dz,
          ndx: round(dx / Math.max(1, radius), 4),
          ndy: round(dy / Math.max(1, radius), 4),
          ndz: round(dz / Math.max(1, radius), 4),
          block: block?.name || 'unknown',
          hardness: metadata.hardness,
          metadata: metadata.metadata,
          fluidType: metadata.fluidType,
          fluidLevel: metadata.fluidLevel,
          lightLevel: {
            skyLight: metadata.skyLight,
            blockLight: metadata.blockLight,
          },
          tags: metadata.tags,
        })
      }
    }
  }

  return points
}

function isAirLike(blockName = '') {
  const name = String(blockName || '').toLowerCase()
  return name === 'air' || name === 'cave_air' || name === 'void_air'
}

function computeBlockGridStats(blocks = []) {
  const bucketCounts = {
    UNKNOWN: 0,
    AIR: 0,
    WATER: 0,
    LAVA: 0,
    PLANT: 0,
    UTILITY: 0,
    SOLID: 0,
  }
  const layerTotals = { '-1': 0, '0': 0, '1': 0 }
  const layerNonAir = { '-1': 0, '0': 0, '1': 0 }
  let nonAirWeightedDy = 0
  let nonAirCount = 0

  for (const entry of blocks) {
    const name = String(entry?.block || 'unknown')
    const bucket = String((() => {
      const n = name.toLowerCase()
      if (!n || n === 'unknown') return 'UNKNOWN'
      if (n === 'air' || n.includes('air')) return 'AIR'
      if (n.includes('water') || n.includes('bubble_column')) return 'WATER'
      if (n.includes('lava')) return 'LAVA'
      if (['grass', 'flower', 'leaves', 'vine', 'sapling'].some((k) => n.includes(k))) return 'PLANT'
      if (['crafting_table', 'furnace', 'chest', 'anvil', 'enchanting_table', 'bed'].some((k) => n.includes(k))) return 'UTILITY'
      return 'SOLID'
    })())

    bucketCounts[bucket] = Number(bucketCounts[bucket] || 0) + 1

    const dy = String(Number.isFinite(Number(entry?.dy)) ? Math.trunc(Number(entry.dy)) : 0)
    if (dy === '-1' || dy === '0' || dy === '1') {
      layerTotals[dy] += 1
      if (!isAirLike(name)) {
        layerNonAir[dy] += 1
      }
    }

    if (!isAirLike(name)) {
      nonAirCount += 1
      nonAirWeightedDy += Number.isFinite(Number(entry?.dy)) ? Number(entry.dy) : 0
    }
  }

  return {
    totalBlocks: blocks.length,
    nonAirCount,
    airCount: Math.max(0, blocks.length - nonAirCount),
    meanNonAirDy: nonAirCount > 0 ? round(nonAirWeightedDy / nonAirCount, 4) : 0,
    bucketCounts,
    layerTotals,
    layerNonAir,
  }
}

function buildSurfaceInfo(blocks = [], radius = 2) {
  const byColumn = new Map()
  for (const entry of blocks) {
    if (!entry || isAirLike(entry.block)) continue
    const dx = Number(entry.dx)
    const dz = Number(entry.dz)
    const dy = Number(entry.dy)
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) continue
    const key = `${dx}:${dz}`
    const current = byColumn.get(key)
    if (!current || dy > Number(current.dy)) {
      byColumn.set(key, entry)
    }
  }

  const surface = []
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      const key = `${dx}:${dz}`
      const entry = byColumn.get(key)
      if (!entry) continue
      surface.push({
        dx,
        dz,
        topDy: Number(entry.dy),
        block: entry.block,
        hardness: entry.hardness,
        metadata: entry.metadata,
        fluidType: entry.fluidType,
        fluidLevel: entry.fluidLevel,
        lightLevel: entry.lightLevel,
        tags: entry.tags,
      })
    }
  }
  return surface
}

function compressNearbyBlocks(blocks = [], radius = 2, mode = 'air-rle') {
  const normalizedMode = String(mode || 'air-rle').toLowerCase()
  const stats = computeBlockGridStats(blocks)

  if (normalizedMode === 'all') {
    return {
      encoding: 'all',
      blocks,
      surface: buildSurfaceInfo(blocks, radius),
      stats,
    }
  }

  if (normalizedMode === 'non-air-surface') {
    const nonAirBlocks = blocks.filter((entry) => !isAirLike(entry?.block))
    return {
      encoding: 'non-air-surface',
      blocks: nonAirBlocks,
      surface: buildSurfaceInfo(blocks, radius),
      stats,
    }
  }

  const compressed = []
  let airRun = null

  for (const entry of blocks) {
    const isAir = isAirLike(entry?.block)
    if (isAir) {
      if (!airRun) {
        airRun = {
          kind: 'air_run',
          block: 'air',
          count: 1,
          from: { dx: entry.dx, dy: entry.dy, dz: entry.dz },
          to: { dx: entry.dx, dy: entry.dy, dz: entry.dz },
        }
      } else {
        airRun.count += 1
        airRun.to = { dx: entry.dx, dy: entry.dy, dz: entry.dz }
      }
      continue
    }

    if (airRun) {
      compressed.push(airRun)
      airRun = null
    }

    compressed.push(entry)
  }

  if (airRun) {
    compressed.push(airRun)
  }

  return {
    encoding: 'air-rle',
    blocks: compressed,
    surface: buildSurfaceInfo(blocks, radius),
    stats,
  }
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

  return entities.map(({ entity, dist }) => {
    const relX = entity.position.x - self.position.x
    const relY = entity.position.y - self.position.y
    const relZ = entity.position.z - self.position.z
    const velocity = {
      vx: round(entity?.velocity?.x || 0),
      vy: round(entity?.velocity?.y || 0),
      vz: round(entity?.velocity?.z || 0),
    }
    const statusEffects = entity?.effects
      ? Object.entries(entity.effects).map(([effectId, effect]) => ({
          id: String(effect?.id ?? effectId),
          amplifier: Number(effect?.amplifier ?? 0),
          duration: Number(effect?.duration ?? 0),
        }))
      : []
    const equipment = Array.isArray(entity?.equipment)
      ? entity.equipment.filter(Boolean).map((item) => serializeItem(item))
      : []

    const name = String(entity?.name || entity?.username || entity?.displayName || 'unknown').toLowerCase()
    const isHostile = entity?.type === 'mob' || /zombie|skeleton|creeper|spider|enderman|witch|pillager/.test(name)
    const isFriendly = entity?.type === 'player' || entity?.type === 'animal' || /villager|iron_golem/.test(name)
    const projectileType = /arrow|trident|snowball|egg|fireball/.test(name) ? name : null

    return {
      id: entity.id,
      type: entity.type || 'unknown',
      name: entity.name || entity.username || entity.displayName || 'unknown',
      distance: round(dist, 3),
      velocity,
      acceleration: {
        ax: null,
        ay: null,
        az: null,
      },
      health: Number.isFinite(Number(entity?.health)) ? Number(entity.health) : null,
      armor: Number.isFinite(Number(entity?.armor)) ? Number(entity.armor) : null,
      statusEffects,
      target: entity?.target ? String(entity.target?.name || entity.target?.username || entity.target?.id || 'unknown') : null,
      aggressionLevel: isHostile ? 'hostile' : 'neutral',
      lastAction: null,
      isFriendly,
      equipment,
      relative: {
        dx: round(relX, 3),
        dy: round(relY, 3),
        dz: round(relZ, 3),
        ndx: round(clamp(relX / Math.max(1.0, maxDistance), -1, 1), 4),
        ndy: round(clamp(relY / Math.max(1.0, maxDistance), -1, 1), 4),
        ndz: round(clamp(relZ / Math.max(1.0, maxDistance), -1, 1), 4),
      },
      position: {
        x: round(entity.position.x),
        y: round(entity.position.y),
        z: round(entity.position.z),
      },
      projectile: projectileType ? {
        type: projectileType,
        owner: null,
        damagePotential: null,
      } : null,
    }
  })
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

function getLookVector(entity) {
  const yaw = Number(entity?.yaw || 0)
  const pitch = Number(entity?.pitch || 0)
  const cosPitch = Math.cos(pitch)
  const x = -Math.sin(yaw) * cosPitch
  const y = -Math.sin(pitch)
  const z = -Math.cos(yaw) * cosPitch
  return {
    x: round(x, 4),
    y: round(y, 4),
    z: round(z, 4),
  }
}

function sampleLineOfSight(bot, entity, maxDistance = 8) {
  if (!bot?.blockAt || !entity?.position) return []
  const look = getLookVector(entity)
  const steps = Math.max(2, Math.floor(Number(maxDistance || 8) / 0.5))
  const samples = []

  for (let index = 1; index <= steps; index += 1) {
    const travel = index * 0.5
    const point = entity.position.offset(look.x * travel, look.y * travel, look.z * travel)
    const block = bot.blockAt(point)
    const metadata = getBlockMetadata(bot, block)
    samples.push({
      distance: round(travel, 3),
      block: block?.name || 'unknown',
      metadata: metadata.metadata,
      fluidType: metadata.fluidType,
      fluidLevel: metadata.fluidLevel,
      lightLevel: {
        skyLight: metadata.skyLight,
        blockLight: metadata.blockLight,
      },
      position: {
        x: round(block?.position?.x ?? point.x),
        y: round(block?.position?.y ?? point.y),
        z: round(block?.position?.z ?? point.z),
      },
    })
  }

  return samples
}

function pickLineOfSightHit(samples = []) {
  for (const sample of samples) {
    const name = String(sample?.block || 'air').toLowerCase()
    if (name && name !== 'air' && name !== 'cave_air' && name !== 'void_air') {
      return sample
    }
  }
  return null
}

function getCameraTarget(bot, entity, maxDistance = 8) {
  const distance = Math.max(1, Number(maxDistance || 8))
  let blockTarget = null
  let entityTarget = null

  try {
    blockTarget = bot?.blockAtCursor?.(distance) || null
  } catch {
    blockTarget = null
  }

  try {
    entityTarget = bot?.entityAtCursor?.(distance) || null
  } catch {
    entityTarget = null
  }

  if (entityTarget?.position) {
    return {
      kind: 'entity',
      id: entityTarget.id,
      name: entityTarget.name || entityTarget.username || 'unknown',
      position: {
        x: round(entityTarget.position.x),
        y: round(entityTarget.position.y),
        z: round(entityTarget.position.z),
      },
    }
  }

  if (blockTarget?.position) {
    return {
      kind: 'block',
      id: null,
      name: blockTarget?.name || 'unknown',
      position: {
        x: round(blockTarget.position.x),
        y: round(blockTarget.position.y),
        z: round(blockTarget.position.z),
      },
    }
  }

  const look = getLookVector(entity)
  return {
    kind: 'vector',
    id: null,
    name: null,
    position: {
      x: round(look.x, 4),
      y: round(look.y, 4),
      z: round(look.z, 4),
    },
  }
}

function getEnvironmentSnapshot(bot, entity) {
  const position = entity?.position
  const blockAtFeet = position ? bot?.blockAt?.(position.floored()) : null
  const biome = blockAtFeet?.biome
  const chunkX = Number.isFinite(Number(position?.x)) ? Math.floor(Number(position.x) / 16) : null
  const chunkZ = Number.isFinite(Number(position?.z)) ? Math.floor(Number(position.z) / 16) : null

  const weather = {
    rain: Number(bot?.rainState || 0) > 0.05,
    thunder: Number(bot?.thunderState || 0) > 0.05,
    snow: false,
  }

  return {
    lightLevel: {
      skyLight: Number.isFinite(Number(blockAtFeet?.skyLight)) ? Number(blockAtFeet.skyLight) : null,
      blockLight: Number.isFinite(Number(blockAtFeet?.light)) ? Number(blockAtFeet.light) : null,
    },
    weather,
    timeOfDay: {
      age: Number.isFinite(Number(bot?.time?.age)) ? Number(bot.time.age) : null,
      day: Number.isFinite(Number(bot?.time?.day)) ? Number(bot.time.day) : null,
      time: Number.isFinite(Number(bot?.time?.time)) ? Number(bot.time.time) : null,
      isDay: Boolean(bot?.time?.isDay),
    },
    biome: {
      id: Number.isFinite(Number(biome?.id)) ? Number(biome.id) : (Number.isFinite(Number(biome)) ? Number(biome) : null),
      name: biome?.name || null,
      category: biome?.category || null,
      temperature: Number.isFinite(Number(biome?.temperature)) ? Number(biome.temperature) : null,
      rainfall: Number.isFinite(Number(biome?.rainfall)) ? Number(biome.rainfall) : null,
    },
    dimension: String(bot?.game?.dimension || 'unknown'),
    heightLimits: {
      floor: Number.isFinite(Number(bot?.game?.minY)) ? Number(bot.game.minY) : null,
      ceiling: Number.isFinite(Number(bot?.game?.height)) ? Number(bot.game.height) : null,
    },
    chunkRegion: {
      chunkX,
      chunkZ,
      regionX: Number.isFinite(chunkX) ? Math.floor(chunkX / 32) : null,
      regionZ: Number.isFinite(chunkZ) ? Math.floor(chunkZ / 32) : null,
      loaded: true,
    },
  }
}

function getViewContext(bot, entity, maxDistance = 8) {
  const lookVector = getLookVector(entity)
  const samples = sampleLineOfSight(bot, entity, maxDistance)
  const los = pickLineOfSightHit(samples)
  const cameraTarget = getCameraTarget(bot, entity, maxDistance)
  return {
    lookVector,
    lineOfSight: samples,
    lineOfSightBlock: los,
    cameraTarget,
  }
}

function getNormalizedVelocity(velocity = {}) {
  const vx = Number(velocity?.vx || 0)
  const vy = Number(velocity?.vy || 0)
  const vz = Number(velocity?.vz || 0)
  const horizontalSpeed = Math.sqrt(vx * vx + vz * vz)
  return {
    vx: normalizeSigned(vx, 0.45),
    vy: normalizeSigned(vy, 0.42),
    vz: normalizeSigned(vz, 0.45),
    horizontalSpeed: round(clamp(horizontalSpeed / 0.45, 0, 2), 4),
  }
}

function buildInventorySnapshot(bot) {
  const items = bot?.inventory?.items?.() || []
  return items.map((item) => serializeItem(item))
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

module.exports = {
  buildNearbyBlocksGrid,
  compressNearbyBlocks,
  buildNearbyEntities,
  getBlockContext,
  getViewContext,
  getNormalizedVelocity,
  buildInventorySnapshot,
  getControlSnapshot,
  getEnvironmentSnapshot,
  normalizeAngle,
  serializeItem,
}
