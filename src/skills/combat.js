let lastMobAttackAt = 0

function nearestHostile({ bot, nearestEntity, distanceToEntity, maxDistance }) {
  const mob = nearestEntity(bot, (entity) => entity?.type === 'mob')
  if (!mob) return null
  return distanceToEntity(bot, mob) <= maxDistance ? mob : null
}

async function attackOrEvade({
  bot,
  goals,
  hostile,
  state,
  stopExploring,
  safeChat,
  randInt,
  attackEnabled,
  attackDistance,
  keepMoving = false,
}) {
  if (!hostile || !bot.entity) return false

  const distance = bot.entity.position.distanceTo(hostile.position)

  if (attackEnabled && distance <= attackDistance) {
    try {
      state.setMode('attack')
      if (!keepMoving) stopExploring()
      bot.setControlState('sprint', true)
      const strafeLeft = Math.random() < 0.5
      bot.setControlState(strafeLeft ? 'left' : 'right', true)
      setTimeout(() => {
        try {
          bot.setControlState('left', false)
          bot.setControlState('right', false)
        } catch {}
      }, 160)
      await bot.lookAt(hostile.position.offset(0, 1.2, 0), true)
      await bot.attack(hostile)
      safeChat('Defending myself.')
      return true
    } catch (e) {
      console.log('attack error', e)
    } finally {
      try {
        if (!keepMoving) bot.setControlState('sprint', false)
        bot.setControlState('left', false)
        bot.setControlState('right', false)
      } catch {}
      if (state.getMode() === 'attack') state.setMode('idle')
    }
  }

  try {
    state.setMode('evade')
    if (!keepMoving) stopExploring()
    bot.setControlState('sprint', true)
    const origin = bot.entity.position
    const awayX = origin.x + (origin.x - hostile.position.x) * 1.8
    const awayZ = origin.z + (origin.z - hostile.position.z) * 1.8
    const safeX = Math.floor(awayX + randInt(-5, 5))
    const safeY = Math.floor(origin.y)
    const safeZ = Math.floor(awayZ + randInt(-5, 5))

    bot.pathfinder.setGoal(new goals.GoalNear(safeX, safeY, safeZ, 2), false)
    safeChat('Backing away from danger.')
    return true
  } catch (e) {
    console.log('evade error', e)
    return false
  } finally {
    try {
      if (!keepMoving) bot.setControlState('sprint', false)
    } catch {}
    if (state.getMode() === 'evade') state.setMode('idle')
  }
}

async function attackHostileMob({
  bot,
  goals,
  hostile,
  state,
  stopExploring,
  safeChat,
  attackDistance,
  keepMoving = false,
}) {
  if (!hostile || !bot.entity) return false

  try {
    state.setMode('attack-mob')
    if (!keepMoving) stopExploring()
    bot.setControlState('sprint', true)

    const distance = bot.entity.position.distanceTo(hostile.position)
    if (distance > attackDistance + 1) {
      bot.pathfinder.setGoal(new goals.GoalFollow(hostile, 1.2), true)
      return true
    }

    if (distance < Math.max(1.4, attackDistance - 1.0)) {
      const awayX = bot.entity.position.x + (bot.entity.position.x - hostile.position.x) * 1.2
      const awayZ = bot.entity.position.z + (bot.entity.position.z - hostile.position.z) * 1.2
      bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(awayX), Math.floor(bot.entity.position.y), Math.floor(awayZ), 1), false)
      return true
    }

    const now = Date.now()
    if (now - lastMobAttackAt < 500) return true

    const strafeLeft = Math.random() < 0.5
    bot.setControlState(strafeLeft ? 'left' : 'right', true)
    setTimeout(() => {
      try {
        bot.setControlState('left', false)
        bot.setControlState('right', false)
      } catch {}
    }, 170)

    await bot.lookAt(hostile.position.offset(0, 1.1, 0), true)
    await bot.attack(hostile)
    lastMobAttackAt = now
    safeChat(`Engaging ${hostile.name || 'mob'}.`)
    return true
  } catch (e) {
    console.log('attack hostile error', e)
    return false
  } finally {
    try {
      if (!keepMoving) bot.setControlState('sprint', false)
      bot.setControlState('left', false)
      bot.setControlState('right', false)
    } catch {}
    if (state.getMode() === 'attack-mob') state.setMode('idle')
  }
}

module.exports = {
  nearestHostile,
  attackOrEvade,
  attackHostileMob,
}
