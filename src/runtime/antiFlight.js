function createAntiFlightGuard({ bot, isFlightAllowedMode, enforceNoCreativeFlight }) {
  let lastNoFlightEnforceAt = 0

  const antiFlyState = {
    lastY: null,
    upwardTicks: 0,
    hoverTicks: 0,
    lastFlightAllowed: null,
    lastModeSwitchAt: 0,
    lastHurtAt: 0,
    recoveringFromHit: false,
    recoveryUntil: 0,
    forceNoJumpUntil: 0,
    waterTicks: 0,
  }

  function nearestDamageThreat(maxDistance = 12) {
    if (!bot?.entity?.position) return null
    let best = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const entity of Object.values(bot.entities || {})) {
      if (!entity || !entity.position) continue
      if (entity.type !== 'mob' && entity.type !== 'player') continue
      if (entity.type === 'player' && entity.username === bot.username) continue
      const distance = bot.entity.position.distanceTo(entity.position)
      if (!Number.isFinite(distance) || distance > maxDistance) continue
      if (distance < bestDistance) {
        bestDistance = distance
        best = entity
      }
    }
    return best
  }

  function inWaterLikeState() {
    try {
      if (bot?.entity?.isInWater || bot?.entity?.isInLava) return true
      if (!bot?.entity?.position || !bot?.blockAt) return false
      const pos = bot.entity.position
      const feet = bot.blockAt(pos)
      const head = bot.blockAt(pos.offset(0, 1, 0))
      const feetName = String(feet?.name || '').toLowerCase()
      const headName = String(head?.name || '').toLowerCase()
      return feetName.includes('water') || headName.includes('water') || feetName.includes('bubble_column') || headName.includes('bubble_column')
    } catch {
      return false
    }
  }

  function enforceSurvivalNoFlight(reason = 'unknown') {
    const now = Date.now()
    if (now - lastNoFlightEnforceAt < 1_500) return
    if (isFlightAllowedMode(bot)) return

    const didEnforce = enforceNoCreativeFlight(bot)
    if (!didEnforce) return

    lastNoFlightEnforceAt = now
  }

  function hardResetFlightState(reason = 'mode-transition') {
    enforceSurvivalNoFlight(reason)

    try {
      bot.setControlState('jump', false)
      bot.setControlState('sprint', false)
    } catch {}

    try {
      if (bot.pathfinder?.isMoving?.() && !isFlightAllowedMode(bot)) {
        bot.pathfinder.setGoal(null)
      }
    } catch {}

    antiFlyState.upwardTicks = 0
    antiFlyState.hoverTicks = 0
    antiFlyState.lastModeSwitchAt = Date.now()
  }

  function nearVerticalAssistBlock() {
    if (!bot.entity) return false
    const pos = bot.entity.position
    const checks = [
      pos,
      pos.offset(0, -1, 0),
      pos.offset(0, 1, 0),
    ]

    for (const p of checks) {
      const block = bot.blockAt?.(p)
      const name = String(block?.name || '').toLowerCase()
      if (!name) continue
      if (
        name.includes('ladder') ||
        name.includes('vine') ||
        name.includes('water') ||
        name.includes('bubble_column') ||
        name.includes('scaffolding') ||
        name.includes('cobweb')
      ) {
        return true
      }
    }

    return false
  }

  function onEntityHurt(entity) {
    if (!entity || entity !== bot.entity) return

    const now = Date.now()
    antiFlyState.recoveringFromHit = true
    antiFlyState.recoveryUntil = now + 450
    antiFlyState.forceNoJumpUntil = now + 1_200
    bot.__movementPauseUntil = now + 500
    antiFlyState.lastHurtAt = now
    antiFlyState.upwardTicks = 0
    antiFlyState.hoverTicks = 0

    try {
      bot.pathfinder.setGoal(null)
    } catch {}

    const threat = nearestDamageThreat(12)
    bot.__lastHurtAt = now
    bot.__lastDamageContext = {
      at: now,
      threatType: String(threat?.type || ''),
      threatName: String(threat?.username || threat?.name || ''),
      threatId: threat?.id || null,
      distance: threat && bot?.entity?.position ? Number(bot.entity.position.distanceTo(threat.position).toFixed(2)) : null,
    }
    bot.__envEmergencyReason = 'hurt'
    bot.__envEmergencyUntil = now + 1_500

    try {
      bot.setControlState('jump', false)
      bot.setControlState('sprint', false)
    } catch {}
  }

  function onPhysicsTick() {
    if (!bot.entity) return

    const now = Date.now()
    if (antiFlyState.recoveringFromHit && now >= Number(antiFlyState.recoveryUntil || 0)) {
      antiFlyState.recoveringFromHit = false
      bot.__movementPauseUntil = 0
    }

    const flightAllowed = isFlightAllowedMode(bot)
    if (antiFlyState.lastFlightAllowed == null) {
      antiFlyState.lastFlightAllowed = flightAllowed
    }

    if (antiFlyState.lastFlightAllowed !== flightAllowed) {
      antiFlyState.lastFlightAllowed = flightAllowed
      if (!flightAllowed) {
        hardResetFlightState('flight-mode-disabled')
      }
    }

    if (flightAllowed) {
      antiFlyState.lastY = Number(bot.entity.position?.y || 0)
      antiFlyState.upwardTicks = 0
      antiFlyState.hoverTicks = 0
      return
    }

    const inWater = inWaterLikeState()
    if (inWater) {
      antiFlyState.waterTicks += 1
      bot.__envEmergencyReason = 'water'
      bot.__envEmergencyUntil = now + 1_000

      if (antiFlyState.waterTicks >= 2) {
        try {
          bot.setControlState('forward', true)
          bot.setControlState('jump', true)
          bot.setControlState('sprint', false)
        } catch {}
      }
    } else {
      const hadWaterState = antiFlyState.waterTicks > 0
      antiFlyState.waterTicks = 0
      if (hadWaterState) {
        try {
          bot.setControlState('forward', false)
          bot.setControlState('jump', false)
        } catch {}
      }
    }

    if (now < Number(antiFlyState.forceNoJumpUntil || 0)) {
      try {
        bot.setControlState('jump', false)
      } catch {}
    }

    const vy = Number(bot.entity.velocity?.y || 0)
    const y = Number(bot.entity.position?.y || 0)
    const previousY = antiFlyState.lastY
    antiFlyState.lastY = y

    const recentlyHurt = (now - Number(antiFlyState.lastHurtAt || 0)) < 1_500
    const upwardThreshold = recentlyHurt ? 0.16 : 0.35
    const riseThreshold = recentlyHurt ? 0.006 : 0.015

    const risingNow = previousY != null ? (y - previousY) > riseThreshold : false
    const sustainedUpward = !bot.entity.onGround && vy > upwardThreshold && risingNow
    antiFlyState.upwardTicks = sustainedUpward ? antiFlyState.upwardTicks + 1 : Math.max(0, antiFlyState.upwardTicks - 1)

    const nearZeroVerticalSpeed = Math.abs(vy) < 0.035
    antiFlyState.hoverTicks = (!bot.entity.onGround && nearZeroVerticalSpeed)
      ? antiFlyState.hoverTicks + 1
      : Math.max(0, antiFlyState.hoverTicks - 2)

    const justSwitchedFromFlight = (Date.now() - Number(antiFlyState.lastModeSwitchAt || 0)) <= 3_000
    const sustainedLiftBug = antiFlyState.upwardTicks >= (justSwitchedFromFlight ? 9 : 15)
    const hoveringInAirBug = antiFlyState.hoverTicks >= 14

    if ((sustainedLiftBug || hoveringInAirBug) && !nearVerticalAssistBlock()) {
      enforceSurvivalNoFlight('vertical-launch-guard')

      antiFlyState.upwardTicks = 0
      antiFlyState.hoverTicks = 0
    }
  }

  return {
    enforceSurvivalNoFlight,
    hardResetFlightState,
    onEntityHurt,
    onPhysicsTick,
  }
}

module.exports = {
  createAntiFlightGuard,
}
