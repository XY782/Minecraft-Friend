const fs = require('fs')
const path = require('path')

const {
  angularDistance,
  safeString,
  round,
  safeNumber,
  sanitizeGroundFlags,
} = require('./utils')
const snapshot = require('./snapshot')
const { createActionLabeling } = require('./labeling/actionLabeling')
const { createSampleBuilder } = require('./runtime/sampleBuilder')

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function createTrainingRecorder({
  bot,
  rootDir,
  sessionMemory,
  enabled = true,
  intervalMs = 1000,
  liveConsole = true,
  observerModeEnabled = false,
  adaptiveInterval = true,
  targetFps = 4,
  minIntervalMs = 200,
  maxIntervalMs = 500,
  lineOfSightMaxDistance = 8,
  actionHistorySize = 12,
  blockCompressionMode = 'air-rle',
  deduplicateFrames = true,
  minPositionDelta = 0.14,
  minYawDelta = 0.08,
  minPitchDelta = 0.06,
  minVelocityDelta = 0.08,
  forceRecordMs = 1500,
  logDedupSkips = false,
  dedupLogIntervalMs = 10000,
  getUserTelemetry = () => null,
  getIntent = () => '',
  getMode = () => 'idle',
  getLastAction = () => null,
  getRecentChat = () => [],
}) {
  let recorderEnabled = Boolean(enabled)
  let observerModeActive = Boolean(observerModeEnabled)

  const trainingRoot = path.join(rootDir, 'Training')
  const datasetDir = path.join(trainingRoot, 'datasets')
  const modelDir = path.join(trainingRoot, 'models')
  const logsDir = path.join(trainingRoot, 'logs')

  ensureDir(trainingRoot)
  ensureDir(datasetDir)
  ensureDir(modelDir)
  ensureDir(logsDir)

  let timer = null
  let writeQueue = []
  let isFlushingQueue = false
  let lastWrittenSample = null
  let lastWrittenAt = 0
  let dedupSkippedCount = 0
  let dedupKeptCount = 0
  let lastDedupLogAt = 0

  let actionOutcome = {
    at: 0,
    action: 'IDLE',
    success: null,
    source: 'none',
    details: null,
  }

  function inventorySignature(items) {
    return (items || [])
      .map((item) => `${String(item?.name || 'unknown')}:${Number(item?.count || 0)}`)
      .sort()
      .join('|')
  }

  const actionLabeling = createActionLabeling({ inventorySignature })

  const sampleBuilder = createSampleBuilder({
    bot,
    round,
    safeString,
    safeNumber,
    angularDistance,
    sanitizeGroundFlags,
    snapshot,
    getMode,
    getLastAction,
    getRecentChat,
    actionLabeling,
    getUserTelemetry,
    intervalMs,
    lineOfSightMaxDistance,
    blockCompressionMode,
    actionHistorySize,
  })

  function dateKey() {
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  function filePathForToday() {
    return path.join(datasetDir, `state-action-${dateKey()}.jsonl`)
  }

  function clamp(value, min, max) {
    const n = Number(value)
    if (!Number.isFinite(n)) return min
    return Math.min(max, Math.max(min, n))
  }

  function computeAdaptiveDelay(sample) {
    const fpsFloorDelay = Math.max(1, Math.round(1000 / Math.max(1, Number(targetFps || 4))))
    const minDelay = Math.max(200, Number(minIntervalMs || 200), fpsFloorDelay)
    const maxDelay = Math.max(minDelay, Number(maxIntervalMs || 500))
    const fixedDelay = clamp(Number(intervalMs || 350), minDelay, maxDelay)

    if (!adaptiveInterval) return fixedDelay
    if (!sample) return maxDelay

    const source = String(sample?.action?.source || '').toLowerCase()
    const events = sample?.state?.events || {}
    const speed = Number(sample?.state?.normalizedVelocity?.horizontalSpeed || 0)

    if (source && source !== 'state-only') return minDelay
    if (events.hurtRecently || events.jumped || events.landed || events.inventoryChanged || events.healthChanged) return minDelay
    if (speed >= 0.8) return minDelay
    if (speed >= 0.35 || Number(sample?.state?.nearbyEntities?.length || 0) > 0) return clamp((minDelay + maxDelay) / 2, minDelay, maxDelay)
    return maxDelay
  }

  function shouldSkipNearDuplicate(sample) {
    if (!deduplicateFrames || !sample || !lastWrittenSample) return false

    const elapsed = Date.now() - Number(lastWrittenAt || 0)
    const forcedInterval = Math.max(300, Number(forceRecordMs || 1500))
    if (elapsed >= forcedInterval) return false

    const source = String(sample?.action?.source || '').toLowerCase()
    if (source && source !== 'state-only' && source !== 'sanitized-state') return false

    const events = sample?.state?.events || {}
    if (
      events.jumped || events.landed || events.inventoryChanged || events.healthChanged ||
      events.hungerChanged || events.hurtRecently || events.nearbyEntitiesChanged
    ) {
      return false
    }

    const currPos = sample?.state?.position || {}
    const prevPos = lastWrittenSample?.state?.position || {}
    const posDx = Number(currPos.x || 0) - Number(prevPos.x || 0)
    const posDy = Number(currPos.y || 0) - Number(prevPos.y || 0)
    const posDz = Number(currPos.z || 0) - Number(prevPos.z || 0)
    const posDelta = Math.sqrt(posDx * posDx + posDy * posDy + posDz * posDz)

    const currVel = sample?.state?.velocity || {}
    const prevVel = lastWrittenSample?.state?.velocity || {}
    const velDx = Number(currVel.vx || 0) - Number(prevVel.vx || 0)
    const velDy = Number(currVel.vy || 0) - Number(prevVel.vy || 0)
    const velDz = Number(currVel.vz || 0) - Number(prevVel.vz || 0)
    const velDelta = Math.sqrt(velDx * velDx + velDy * velDy + velDz * velDz)

    const yawDelta = angularDistance(sample?.state?.yaw, lastWrittenSample?.state?.yaw)
    const pitchDelta = angularDistance(sample?.state?.pitch, lastWrittenSample?.state?.pitch)

    const smallMotion = posDelta < Math.max(0.02, Number(minPositionDelta || 0.14))
    const smallVelocity = velDelta < Math.max(0.01, Number(minVelocityDelta || 0.08))
    const smallLook = (
      yawDelta < Math.max(0.01, Number(minYawDelta || 0.08)) &&
      pitchDelta < Math.max(0.01, Number(minPitchDelta || 0.06))
    )

    return smallMotion && smallVelocity && smallLook
  }

  function maybeLogDedupStats() {
    if (!liveConsole || !logDedupSkips) return
    const now = Date.now()
    const interval = Math.max(1000, Number(dedupLogIntervalMs || 10000))
    if (now - lastDedupLogAt < interval) return

    const total = dedupSkippedCount + dedupKeptCount
    const skippedPct = total > 0 ? (dedupSkippedCount * 100) / total : 0
    console.log(
      `[TRAINING] dedup stats | skipped=${dedupSkippedCount} kept=${dedupKeptCount} skipRate=${skippedPct.toFixed(1)}% ` +
      `thresholds(pos=${Number(minPositionDelta || 0).toFixed(2)}, yaw=${Number(minYawDelta || 0).toFixed(2)}, ` +
      `pitch=${Number(minPitchDelta || 0).toFixed(2)}, vel=${Number(minVelocityDelta || 0).toFixed(2)})`
    )
    lastDedupLogAt = now
  }

  function flushWriteQueue() {
    if (isFlushingQueue || !writeQueue.length) return

    isFlushingQueue = true
    const currentFile = filePathForToday()
    const chunk = writeQueue.join('')
    writeQueue = []

    fs.appendFile(currentFile, chunk, 'utf8', (error) => {
      isFlushingQueue = false
      if (error) {
        console.log('[TRAINING] write error', error)
      }
      if (writeQueue.length) flushWriteQueue()
    })
  }

  function writeSample(sample) {
    writeQueue.push(JSON.stringify(sample) + '\n')
    flushWriteQueue()
    lastWrittenSample = sample
    lastWrittenAt = Date.now()

    if (liveConsole) {
      const pos = sample.state.position
      const action = sample.action
      const status = action.success == null ? 'n/a' : (action.success ? 'ok' : 'fail')
      const observer = sample.state?.observer
      if ((action.source === 'observer-mode' || action.source === 'observer-derived') && observer?.username) {
        console.log(
          `[TRAINING] ${sample.timestamp} | observerAction=${action.label} (${status}) | observer=${observer.username} | observerPos=${pos.x},${pos.y},${pos.z} | distance=${observer.distance}`
        )
      } else {
        console.log(
          `[TRAINING] ${sample.timestamp} | action=${action.label} (${status}) | pos=${pos.x},${pos.y},${pos.z} | source=${action.source || 'state-only'}`
        )
      }
    }
  }

  function tick() {
    if (!recorderEnabled) return null
    const sample = sampleBuilder.buildSample({ observerModeActive, actionOutcome })
    if (!sample) return null

    if (shouldSkipNearDuplicate(sample)) {
      dedupSkippedCount += 1
      maybeLogDedupStats()
      return null
    }

    dedupKeptCount += 1
    maybeLogDedupStats()
    writeSample(sample)
    return sample
  }

  function scheduleNextTick(delayMs) {
    if (!recorderEnabled) return
    const fpsFloorDelay = Math.max(1, Math.round(1000 / Math.max(1, Number(targetFps || 4))))
    const minDelay = Math.max(200, Number(minIntervalMs || 200), fpsFloorDelay)
    const maxDelay = Math.max(minDelay, Number(maxIntervalMs || 500))
    const waitMs = clamp(Number(delayMs || intervalMs || 350), minDelay, maxDelay)

    timer = setTimeout(() => {
      const sample = tick()
      if (!recorderEnabled) return
      scheduleNextTick(computeAdaptiveDelay(sample))
    }, waitMs)
  }

  function start() {
    if (!recorderEnabled || timer) return
    scheduleNextTick(intervalMs)
    sessionMemory?.addMemory?.('Training recorder started.', 'training')
  }

  function stop() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    flushWriteQueue()
    sessionMemory?.addMemory?.('Training recorder stopped.', 'training')
  }

  function recordActionOutcome({ action, success, source = 'decision-engine', details = null }) {
    actionOutcome = {
      at: Date.now(),
      action: safeString(action) || 'UNKNOWN',
      success: success == null ? null : Boolean(success),
      source: safeString(source) || 'decision-engine',
      details,
    }
  }

  return {
    start,
    stop,
    setEnabled: (value) => {
      const nextEnabled = Boolean(value)
      if (nextEnabled === recorderEnabled) return
      recorderEnabled = nextEnabled
      if (recorderEnabled) start()
      else stop()
    },
    isEnabled: () => recorderEnabled,
    setObserverModeEnabled: (value) => {
      observerModeActive = Boolean(value)
      if (!observerModeActive) {
        actionLabeling.resetObserverInteractionState()
        sampleBuilder.reset()
      }
    },
    isObserverModeEnabled: () => observerModeActive,
    recordActionOutcome,
    getDatasetDirectory: () => datasetDir,
  }
}

module.exports = {
  createTrainingRecorder,
}
