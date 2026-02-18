const { Vec3 } = require('vec3')

const buildState = {
  cooldownUntil: 0,
  lastErrorLogAt: 0,
}

function isAirLike(blockName) {
  const n = String(blockName || '').toLowerCase()
  return n === 'air' || n === 'cave_air' || n === 'void_air'
}

function choosePlaceableItem(bot) {
  const items = bot.inventory?.items?.() || []
  const priority = ['cobblestone', 'dirt', 'oak_planks', 'spruce_planks', 'birch_planks', 'netherrack']

  for (const name of priority) {
    const found = items.find((item) => String(item.name || '') === name)
    if (found) return found
  }

  return items.find((item) => {
    const name = String(item.name || '').toLowerCase()
    return name.endsWith('_planks') || name.includes('stone') || name.includes('dirt')
  }) || null
}

function findPlacementCandidates(bot) {
  if (!bot.entity) return null
  const pos = bot.entity.position.floored()
  const results = []

  const faceVectors = [
    new Vec3(0, 1, 0),
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ]

  const candidates = [
    pos.offset(1, -1, 0),
    pos.offset(-1, -1, 0),
    pos.offset(0, -1, 1),
    pos.offset(0, -1, -1),
  ]

  for (const p of candidates) {
    const block = bot.blockAt(p)
    if (!block || isAirLike(block.name)) continue
    if (typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(block)) continue

    for (const faceVector of faceVectors) {
      const targetPos = block.position.plus(faceVector)
      const targetBlock = bot.blockAt(targetPos)
      if (!targetBlock || !isAirLike(targetBlock.name)) continue

      if (targetPos.y !== pos.y - 1) continue

      const belowTarget = bot.blockAt(targetPos.offset(0, -1, 0))
      if (belowTarget && !isAirLike(belowTarget.name)) continue

      const distance = bot.entity.position.distanceTo(targetPos)
      if (distance > 3.2) continue

      results.push({ reference: block, faceVector, targetPos })
    }
  }

  return results
}

async function buildIfWanted({ bot, state, stopExploring, keepMoving = false }) {
  const now = Date.now()
  if (now < buildState.cooldownUntil) return false
  if (keepMoving) return false

  const item = choosePlaceableItem(bot)
  if (!item) return false

  const candidates = findPlacementCandidates(bot)
  if (!candidates?.length) return false

  try {
    state.setMode('build')
    stopExploring()
    await bot.equip(item, 'hand')

    for (const candidate of candidates.slice(0, 5)) {
      try {
        await bot.placeBlock(candidate.reference, candidate.faceVector)
        return true
      } catch (e) {
        const message = String(e?.message || '')
        const timedOut = message.includes('did not fire within timeout')
        const blocked = message.includes('No block has been placed') || message.includes('out of range')
        if (!timedOut && !blocked) throw e
      }
    }

    buildState.cooldownUntil = Date.now() + 20_000
    return false
  } catch (e) {
    if (Date.now() - buildState.lastErrorLogAt >= 15_000) {
      buildState.lastErrorLogAt = Date.now()
      console.log('build error', e)
    }
    buildState.cooldownUntil = Date.now() + 20_000
    return false
  } finally {
    if (state.getMode() === 'build') state.setMode('idle')
  }
}

module.exports = {
  buildIfWanted,
}
