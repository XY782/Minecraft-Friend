const { Vec3 } = require('vec3')

function createMovementSkill({ bot, goals, config, safeChat, randInt, chance, wait, state }) {
  let exploring = false
  let exploreTimer = null
  let autonomyTimer = null
  let lookAroundTimer = null
  let followStopTimer = null

  function isManualOverrideActive() {
    return Boolean(bot?.__puppetActive)
  }

  function clearExploreTimer() {
    if (!exploreTimer) return
    clearTimeout(exploreTimer)
    exploreTimer = null
  }

  function clearAutonomyTimer() {
    if (!autonomyTimer) return
    clearTimeout(autonomyTimer)
    autonomyTimer = null
  }

  function clearLookAroundTimer() {
    if (!lookAroundTimer) return
    clearTimeout(lookAroundTimer)
    lookAroundTimer = null
  }

  function clearFollowStopTimer() {
    if (!followStopTimer) return
    clearTimeout(followStopTimer)
    followStopTimer = null
  }

  function stopExploring() {
    exploring = false
    clearExploreTimer()
    try {
      bot.setControlState('sprint', false)
      bot.setControlState('jump', false)
    } catch {}
    if (state.getMode() === 'explore') state.setMode('idle')
    if (bot.pathfinder?.isMoving?.()) {
      bot.pathfinder.setGoal(null)
    }
  }

  function resumeExploreSoon(delayMs = 1_000) {
    if (!config.autoExploreOnSpawn) return
    if (isManualOverrideActive()) return
    clearAutonomyTimer()
    autonomyTimer = setTimeout(() => {
      if (isManualOverrideActive()) return
      if (state.getMode() === 'idle') startExploring(false)
    }, delayMs)
  }

  function isAirLike(block) {
    const name = String(block?.name || '').toLowerCase()
    return !name || name === 'air' || name === 'cave_air' || name === 'void_air'
  }

  function hasSafeSupportAt(x, y, z) {
    if (!bot?.blockAt) return true

    const feet = bot.blockAt(new Vec3(x, y, z))
    const head = bot.blockAt(new Vec3(x, y + 1, z))
    const below = bot.blockAt(new Vec3(x, y - 1, z))
    if (!isAirLike(feet) || !isAirLike(head) || isAirLike(below)) return false

    let supportCount = 0
    const offsets = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]
    for (const [ox, oz] of offsets) {
      const nearbyBelow = bot.blockAt(new Vec3(x + ox, y - 1, z + oz))
      if (!isAirLike(nearbyBelow)) supportCount += 1
    }

    return supportCount >= 2
  }

  function chooseSafeExploreTarget(origin) {
    const targetY = Math.floor(origin.y)

    for (let attempt = 0; attempt < 9; attempt++) {
      const dx = Math.floor((Math.random() * 2 - 1) * config.exploreRadius)
      const dz = Math.floor((Math.random() * 2 - 1) * config.exploreRadius)
      const targetX = Math.floor(origin.x + dx)
      const targetZ = Math.floor(origin.z + dz)
      if (!hasSafeSupportAt(targetX, targetY, targetZ)) continue
      return { targetX, targetY, targetZ }
    }

    return null
  }

  async function runExploreStep() {
    if (!exploring || !bot.entity) return
    if (isManualOverrideActive()) {
      stopExploring()
      return
    }

    const origin = bot.entity.position
    const target = chooseSafeExploreTarget(origin)
    if (!target) {
      clearExploreTimer()
      exploreTimer = setTimeout(runExploreStep, Math.max(900, Math.floor(config.explorePauseMs * 0.5)))
      return
    }
    const { targetX, targetY, targetZ } = target

    try {
      if (config.humanizeBehavior && !bot.pathfinder?.isMoving?.() && chance(0.18)) {
        const lookTarget = origin.offset(randInt(-6, 6), randInt(-1, 2), randInt(-6, 6))
        await bot.lookAt(lookTarget, true)
        await wait(randInt(150, 700))
      }

      const stableFooting = hasSafeSupportAt(Math.floor(origin.x), Math.floor(origin.y), Math.floor(origin.z))
      if (config.humanizeBehavior && chance(0.1) && bot.entity?.onGround && stableFooting) {
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), randInt(120, 240))
      }

      const shouldSprint = config.humanizeBehavior ? chance(0.7) : true
      bot.setControlState('sprint', shouldSprint)

      bot.pathfinder.setGoal(new goals.GoalNear(targetX, targetY, targetZ, 2), false)
      await wait(randInt(450, 900))
    } catch (e) {
      console.log('explore step error', e)
    } finally {
      if (!exploring) return
      clearExploreTimer()
      const baseDelay = Math.max(260, Math.floor((config.explorePauseMs || 5000) * 0.18))
      const jitter = config.humanizeBehavior ? randInt(60, 280) : 0
      exploreTimer = setTimeout(runExploreStep, baseDelay + jitter)
    }
  }

  function startExploring(announce = true) {
    if (isManualOverrideActive()) return
    if (exploring) {
      if (announce) safeChat('Already roaming around.')
      return
    }

    bot.pathfinder.setGoal(null)
    clearFollowStopTimer()
    exploring = true
    state.setMode('explore')
    if (announce) safeChat('Heading out to explore.')
    clearExploreTimer()
    exploreTimer = setTimeout(runExploreStep, 800)
  }

  function stopFollowingSoon(ms = randInt(8_000, 22_000)) {
    clearFollowStopTimer()
    followStopTimer = setTimeout(() => {
      if (state.getMode() === 'follow') {
        try {
          bot.setControlState('sprint', false)
        } catch {}
        bot.pathfinder.setGoal(null)
        state.setMode('idle')
        resumeExploreSoon(randInt(700, 2_000))
      }
    }, ms)
  }

  function startFollowingPlayer(playerEntity) {
    if (isManualOverrideActive()) return false
    if (!playerEntity || !config.followPlayers) return false
    stopExploring()
    state.setMode('follow')
    try {
      bot.setControlState('sprint', true)
    } catch {}
    bot.pathfinder.setGoal(new goals.GoalFollow(playerEntity, 2), true)
    stopFollowingSoon()
    return true
  }

  function handleGoalReached() {
    const mode = state.getMode()

    if (mode === 'explore') {
      resumeExploreSoon(700)
      return
    }

    if (mode === 'collect' || mode === 'evade' || mode === 'attack') {
      state.setMode('idle')
      resumeExploreSoon(700)
    }
  }

  function onDeath() {
    state.setMode('idle')
    stopExploring()
    try {
      bot.setControlState('sprint', false)
      bot.setControlState('jump', false)
    } catch {}
    clearFollowStopTimer()
  }

  function scheduleLookAround() {
    clearLookAroundTimer()

    lookAroundTimer = setTimeout(async () => {
      try {
        if (isManualOverrideActive()) return
        if (!bot.entity || !config.humanizeBehavior) return
        if (state.getMode() !== 'explore') return
        if (bot.pathfinder?.isMoving?.()) return

        const origin = bot.entity.position
        const lookTarget = origin.offset(randInt(-8, 8), randInt(-2, 3), randInt(-8, 8))
        await bot.lookAt(lookTarget, true)
      } catch (e) {
        console.log('look around error', e)
      } finally {
        scheduleLookAround()
      }
    }, config.lookAroundIntervalMs + randInt(0, 4000))
  }

  function shutdown() {
    try {
      bot.setControlState('sprint', false)
    } catch {}
    clearExploreTimer()
    clearAutonomyTimer()
    clearLookAroundTimer()
    clearFollowStopTimer()
  }

  return {
    startExploring,
    stopExploring,
    resumeExploreSoon,
    startFollowingPlayer,
    handleGoalReached,
    onDeath,
    scheduleLookAround,
    shutdown,
  }
}

module.exports = {
  createMovementSkill,
}
