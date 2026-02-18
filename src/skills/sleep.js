function isNight(bot) {
  const timeOfDay = bot.time?.timeOfDay
  if (typeof timeOfDay !== 'number') return false
  return timeOfDay >= 12541 && timeOfDay <= 23458
}

function getBedBlockIds(bot) {
  const blocksByName = bot.registry?.blocksByName || {}
  return Object.values(blocksByName)
    .filter((block) => block && String(block.name || '').endsWith('_bed'))
    .map((block) => block.id)
}

function findNearbyBed(bot, searchRadius) {
  const bedIds = getBedBlockIds(bot)
  if (!bedIds.length) return null

  return bot.findBlock({
    matching: (block) => bedIds.includes(block.type),
    maxDistance: searchRadius,
  })
}

async function sleepIfNeeded({ bot, goals, state, stopExploring, searchRadius, safeChat }) {
  if (!isNight(bot) || bot.isSleeping) return false

  const bed = findNearbyBed(bot, searchRadius)
  if (!bed) return false

  try {
    state.setMode('sleep')
    stopExploring()
    bot.pathfinder.setGoal(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 1), false)
    await bot.sleep(bed)
    safeChat('Sleeping for the night.')
    return true
  } catch (e) {
    console.log('sleep error', e)
    return false
  } finally {
    if (!bot.isSleeping && state.getMode() === 'sleep') state.setMode('idle')
  }
}

module.exports = {
  sleepIfNeeded,
}
