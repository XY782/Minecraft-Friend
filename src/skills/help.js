const { Vec3 } = require('vec3')

const helpState = {
  cooldownUntil: 0,
  lastErrorLogAt: 0,
}

function isAirLike(blockName) {
  const n = String(blockName || '').toLowerCase()
  return n === 'air' || n === 'cave_air' || n === 'void_air'
}

function choosePlaceableItem(bot) {
  const items = bot.inventory?.items?.() || []
  return items.find((item) => {
    const name = String(item?.name || '').toLowerCase()
    return name.endsWith('_planks') || name.includes('stone') || name.includes('dirt') || name === 'scaffolding'
  }) || null
}

function findHelpPlacementCandidates(bot, target) {
  if (!bot.entity || !target?.position) return []

  const base = target.position.floored()
  const refs = [
    base.offset(0, -1, 0),
    base.offset(1, -1, 0),
    base.offset(-1, -1, 0),
    base.offset(0, -1, 1),
    base.offset(0, -1, -1),
  ]

  const faces = [
    new Vec3(0, 1, 0),
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ]

  const out = []
  for (const refPos of refs) {
    const ref = bot.blockAt(refPos)
    if (!ref || isAirLike(ref.name)) continue
    if (typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(ref)) continue

    for (const face of faces) {
      const placePos = ref.position.plus(face)
      const placeBlock = bot.blockAt(placePos)
      if (!placeBlock || !isAirLike(placeBlock.name)) continue
      if (bot.entity.position.distanceTo(placePos) > 5.2) continue
      out.push({ reference: ref, faceVector: face })
    }
  }

  return out
}

async function helpNearbyPlayer({ bot, goals, state, stopExploring, getNearbyPlayers, keepMoving = true }) {
  if (!bot.entity) return false
  if (Date.now() < helpState.cooldownUntil) return false

  const nearby = getNearbyPlayers(bot, 18)
  if (!nearby.length) return false

  const target = nearby[0].entity
  if (!target) return false

  try {
    state.setMode('help-player')
    if (!keepMoving) stopExploring()

    bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2), false)
    await bot.lookAt(target.position.offset(0, 1.3, 0), true)

    const placeable = choosePlaceableItem(bot)
    if (placeable) {
      const candidates = findHelpPlacementCandidates(bot, target)
      if (candidates.length) {
        await bot.equip(placeable, 'hand')

        let placed = false
        for (const candidate of candidates.slice(0, 5)) {
          try {
            await bot.placeBlock(candidate.reference, candidate.faceVector)
            placed = true
            break
          } catch (e) {
            const msg = String(e?.message || '')
            const retryable =
              msg.includes('did not fire within timeout') ||
              msg.includes('No block has been placed') ||
              msg.includes('out of range')
            if (!retryable) throw e
          }
        }

        if (!placed) {
          helpState.cooldownUntil = Date.now() + 18_000
        }
      }
    }

    return true
  } catch (e) {
    if (Date.now() - helpState.lastErrorLogAt >= 15_000) {
      helpState.lastErrorLogAt = Date.now()
      console.log('help player error', e)
    }
    helpState.cooldownUntil = Date.now() + 18_000
    return false
  } finally {
    if (state.getMode() === 'help-player') state.setMode('idle')
  }
}

module.exports = {
  helpNearbyPlayer,
}
