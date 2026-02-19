const { round, safeString, angularDistance } = require('./utils')

function toObserverState(entity) {
  return {
    position: {
      x: round(entity?.position?.x || 0),
      y: round(entity?.position?.y || 0),
      z: round(entity?.position?.z || 0),
    },
    velocity: {
      vx: round(entity?.velocity?.x || 0),
      vy: round(entity?.velocity?.y || 0),
      vz: round(entity?.velocity?.z || 0),
    },
    yaw: round(entity?.yaw || 0),
    pitch: round(entity?.pitch || 0),
    onGround: Boolean(entity?.onGround),
  }
}

function createObserverSampler({
  enabled,
  observerUsername,
  observerCaptureRadius,
  observerSampleMinMs,
  observerIdleSampleMinMs,
  observerMoveSampleMinDistance,
  getObserverEntity,
}) {
  let observerEnabled = Boolean(enabled)
  let observerPrevState = null
  let lastObserverMissingLogAt = 0
  let lastObserverSampleAt = 0
  let lastObserverLoggedState = null

  function inferObserverAction(currentObserverState) {
    const prev = observerPrevState
    observerPrevState = currentObserverState
    if (!prev) return 'OBSERVER_IDLE'

    const dx = Number(currentObserverState?.position?.x || 0) - Number(prev?.position?.x || 0)
    const dy = Number(currentObserverState?.position?.y || 0) - Number(prev?.position?.y || 0)
    const dz = Number(currentObserverState?.position?.z || 0) - Number(prev?.position?.z || 0)
    const horizontal = Math.sqrt(dx * dx + dz * dz)
    const yawDelta = Math.abs(Number(currentObserverState?.yaw || 0) - Number(prev?.yaw || 0))

    if (dy > 0.35) return 'OBSERVER_JUMP'
    if (horizontal > 0.55) return 'OBSERVER_SPRINT'
    if (horizontal > 0.03) return 'OBSERVER_MOVE'
    if (yawDelta > 0.08) return 'OBSERVER_LOOK'
    return 'OBSERVER_IDLE'
  }

  function resetState() {
    observerPrevState = null
    lastObserverLoggedState = null
  }

  function sampleObserverState({ botEntity, liveConsole }) {
    if (!observerEnabled) return null

    const observerEntity = getObserverEntity?.()
    const observerDistance = botEntity.position.distanceTo(observerEntity?.position || botEntity.position)
    const captureRadius = Number(observerCaptureRadius || 0)
    const hasRadiusLimit = captureRadius > 0
    const inRange = !hasRadiusLimit || observerDistance <= captureRadius

    if (!observerEntity?.position || !inRange) {
      resetState()
      const now = Date.now()
      if (liveConsole && now - lastObserverMissingLogAt >= 10_000) {
        const expectedObserver = safeString(observerUsername || '') || 'unknown-player'
        const radiusHint = Number(observerCaptureRadius || 0) > 0
          ? `${Number(observerCaptureRadius || 0)} blocks`
          : 'no radius cap (server tracking only)'
        console.log(
          `[TRAINING] observer mode waiting: player="${expectedObserver}" not found by server tracking or outside configured radius (${radiusHint}).`
        )
        lastObserverMissingLogAt = now
      }
      return {
        skipped: true,
      }
    }

    const observerState = toObserverState(observerEntity)
    const observerData = {
      username: safeString(observerEntity?.username || observerEntity?.displayName || observerEntity?.name || 'unknown'),
      distance: round(observerDistance),
      ...observerState,
    }

    const actionLabel = inferObserverAction(observerState)
    const now = Date.now()
    const minGap = actionLabel === 'OBSERVER_IDLE'
      ? Math.max(800, Number(observerIdleSampleMinMs || 4000))
      : actionLabel === 'OBSERVER_LOOK'
        ? Math.max(1200, Number(observerSampleMinMs || 1500) * 2)
        : Math.max(400, Number(observerSampleMinMs || 1500))
    if (now - lastObserverSampleAt < minGap) {
      return { skipped: true }
    }

    if (actionLabel === 'OBSERVER_IDLE' && lastObserverLoggedState) {
      const moveDx = Number(observerState.position.x) - Number(lastObserverLoggedState.position?.x || 0)
      const moveDy = Number(observerState.position.y) - Number(lastObserverLoggedState.position?.y || 0)
      const moveDz = Number(observerState.position.z) - Number(lastObserverLoggedState.position?.z || 0)
      const moved = Math.sqrt(moveDx * moveDx + moveDy * moveDy + moveDz * moveDz)
      const yawDelta = Math.abs(Number(observerState.yaw || 0) - Number(lastObserverLoggedState.yaw || 0))
      if (moved < 0.12 && yawDelta < 0.08) {
        return { skipped: true }
      }
    }

    if (lastObserverLoggedState) {
      const moveDx = Number(observerState.position.x) - Number(lastObserverLoggedState.position?.x || 0)
      const moveDy = Number(observerState.position.y) - Number(lastObserverLoggedState.position?.y || 0)
      const moveDz = Number(observerState.position.z) - Number(lastObserverLoggedState.position?.z || 0)
      const moved = Math.sqrt(moveDx * moveDx + moveDy * moveDy + moveDz * moveDz)
      const horizontalMoved = Math.sqrt(moveDx * moveDx + moveDz * moveDz)
      const velDx = Number(observerState.velocity.vx || 0) - Number(lastObserverLoggedState.velocity?.vx || 0)
      const velDy = Number(observerState.velocity.vy || 0) - Number(lastObserverLoggedState.velocity?.vy || 0)
      const velDz = Number(observerState.velocity.vz || 0) - Number(lastObserverLoggedState.velocity?.vz || 0)
      const velocityChanged = Math.sqrt(velDx * velDx + velDy * velDy + velDz * velDz)
      const yawDelta = angularDistance(observerState.yaw, lastObserverLoggedState.yaw)
      const pitchDelta = angularDistance(observerState.pitch, lastObserverLoggedState.pitch)
      const bothGrounded = Boolean(observerState.onGround) === Boolean(lastObserverLoggedState.onGround)

      const globallyNearDuplicate =
        horizontalMoved < 0.2 &&
        velocityChanged < 0.08 &&
        yawDelta < 0.1 &&
        pitchDelta < 0.05 &&
        bothGrounded
      if (globallyNearDuplicate) {
        return { skipped: true }
      }

      const mostlyStaticLook =
        (actionLabel === 'OBSERVER_IDLE' || actionLabel === 'OBSERVER_LOOK') &&
        horizontalMoved < 0.2 &&
        velocityChanged < 0.08 &&
        yawDelta < 0.1 &&
        pitchDelta < 0.05 &&
        bothGrounded
      if (mostlyStaticLook) {
        return { skipped: true }
      }

      const isLookAction = actionLabel === 'OBSERVER_LOOK'
      const lookTurnSignificant = yawDelta >= 0.14 || pitchDelta >= 0.1
      if (isLookAction && !lookTurnSignificant) {
        return { skipped: true }
      }

      const minMoveDistance = Math.max(0.1, Number(observerMoveSampleMinDistance || 1.0))
      const moveLikeAction = actionLabel === 'OBSERVER_MOVE' || actionLabel === 'OBSERVER_SPRINT'
      if (moveLikeAction && horizontalMoved < minMoveDistance) {
        return { skipped: true }
      }

      if (moved < 0.08 && velocityChanged < 0.035 && yawDelta < 0.03 && pitchDelta < 0.02 && bothGrounded) {
        return { skipped: true }
      }
    }

    lastObserverSampleAt = now
    lastObserverLoggedState = observerState

    return {
      skipped: false,
      actionLabel,
      actionSuccess: null,
      actionSource: 'observer-mode',
      actionMetadata: {
        observer: observerData.username,
        distance: observerData.distance,
      },
      observerData,
      observerState,
      observerEntity,
      isObserverSample: true,
    }
  }

  return {
    sampleObserverState,
    setEnabled: (value) => {
      observerEnabled = Boolean(value)
      if (!observerEnabled) {
        resetState()
      }
    },
    isEnabled: () => observerEnabled,
  }
}

module.exports = {
  createObserverSampler,
}
