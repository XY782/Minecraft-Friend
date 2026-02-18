const fs = require('fs')
const path = require('path')

const {
  round,
  safeString,
  safeNumber,
  sanitizeGroundFlags,
} = require('./utils')
const {
  buildNearbyBlocksGrid,
  buildNearbyEntities,
  getBlockContext,
  buildInventorySnapshot,
  getControlSnapshot,
  inferManualActionFromControls,
} = require('./snapshot')
const { createObserverSampler } = require('./observer')

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
  observerUsername = '',
  observerCaptureRadius = 24,
  observerSampleMinMs = 1500,
  observerIdleSampleMinMs = 4000,
  observerMoveSampleMinDistance = 1.0,
  getObserverEntity = () => null,
  getIntent = () => '',
  getMode = () => 'idle',
  getLastAction = () => null,
  getRecentChat = () => [],
}) {
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
  let actionOutcome = {
    at: 0,
    action: 'IDLE',
    success: null,
    source: 'none',
    details: null,
  }

  const observerSampler = createObserverSampler({
    enabled: observerModeEnabled,
    observerUsername,
    observerCaptureRadius,
    observerSampleMinMs,
    observerIdleSampleMinMs,
    observerMoveSampleMinDistance,
    getObserverEntity,
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

  function buildSample() {
    const entity = bot?.entity
    if (!entity?.position) return null

    const manualControlActive = Boolean(bot?.__puppetActive)
    const mode = manualControlActive ? 'manual-puppet' : (safeString(getMode()) || 'idle')
    const recentChat = Array.isArray(getRecentChat()) ? getRecentChat().slice(-8) : []
    const actionAgeMs = Date.now() - Number(actionOutcome.at || 0)
    const freshOutcome = actionAgeMs <= 15_000
    const controlState = getControlSnapshot(bot)
    const nearbyBlockRadius = manualControlActive ? 1 : 2
    const nearbyEntityDistance = manualControlActive ? 8 : 10
    const outcomeSource = safeString(actionOutcome.source || 'none').toLowerCase()
    const isManualOutcome = outcomeSource === 'puppet' || outcomeSource === 'first-person-puppet'
    const selectedHotbarSlot = safeNumber(bot?.quickBarSlot, -1)
    const heldItemName = safeString(bot?.heldItem?.name || 'none') || 'none'
    const heldItemType = safeNumber(bot?.heldItem?.type, -1)
    const blockContext = getBlockContext(bot)

    const fallbackActionLabel = safeString(getLastAction()) || 'IDLE'
    let actionLabel = freshOutcome ? actionOutcome.action : fallbackActionLabel
    let actionSuccess = freshOutcome ? actionOutcome.success : null
    let actionSource = freshOutcome ? actionOutcome.source : 'state-only'
    let actionMetadata = freshOutcome ? actionOutcome.details : null

    const normalizedKind = safeString(actionMetadata?.normalizedKind || '').toLowerCase()
    const sourceLower = safeString(actionSource).toLowerCase()
    if (normalizedKind === 'invalid' || sourceLower === 'intent-step') {
      const fallbackAction = /^[A-Z_]+$/.test(fallbackActionLabel || '') ? fallbackActionLabel : 'IDLE'
      actionLabel = fallbackAction
      actionSuccess = null
      actionSource = 'sanitized-state'
      actionMetadata = {
        reason: 'invalid-intent-step',
      }
    }

    if (manualControlActive) {
      if (!freshOutcome || !isManualOutcome) {
        actionLabel = inferManualActionFromControls(controlState)
        actionSuccess = null
        actionSource = 'manual-control'
        actionMetadata = {
          controls: controlState,
        }
      }
    }

    let observerData = null
    let observerState = null
    let isObserverSample = false
    let observerEntity = null
    if (observerModeEnabled) {
      const observerResult = observerSampler.sampleObserverState({
        botEntity: entity,
        liveConsole,
      })

      if (observerResult?.skipped) {
        return null
      }

      if (observerResult) {
        observerData = observerResult.observerData
        observerState = observerResult.observerState
        observerEntity = observerResult.observerEntity
        isObserverSample = true
        actionLabel = observerResult.actionLabel
        actionSuccess = observerResult.actionSuccess
        actionSource = observerResult.actionSource
        actionMetadata = observerResult.actionMetadata
      }
    }

    const subjectPosition = isObserverSample
      ? observerState.position
      : {
          x: round(entity.position.x),
          y: round(entity.position.y),
          z: round(entity.position.z),
        }
    const subjectVelocity = isObserverSample
      ? observerState.velocity
      : {
          vx: round(entity.velocity?.x || 0),
          vy: round(entity.velocity?.y || 0),
          vz: round(entity.velocity?.z || 0),
        }
    const subjectEntity = isObserverSample ? observerEntity : entity
    const subjectBlockRadius = isObserverSample ? 1 : nearbyBlockRadius
    const subjectEntityDistance = isObserverSample ? 8 : nearbyEntityDistance
    const subjectBlockContext = isObserverSample ? getBlockContext(bot, subjectEntity) : blockContext
    const groundFlags = sanitizeGroundFlags(
      isObserverSample ? observerState?.onGround : entity.onGround,
      isObserverSample ? !Boolean(observerState?.onGround) : !Boolean(entity.onGround),
      subjectVelocity?.vy
    )

    return {
      timestamp: new Date().toISOString(),
      state: {
        position: subjectPosition,
        velocity: subjectVelocity,
        yaw: round(subjectEntity?.yaw || observerState?.yaw || 0),
        pitch: round(subjectEntity?.pitch || observerState?.pitch || 0),
        onGround: groundFlags.onGround,
        inAir: groundFlags.inAir,
        health: safeNumber(bot?.health, 20),
        hunger: safeNumber(bot?.food, 20),
        selectedHotbarSlot,
        heldItem: {
          name: heldItemName,
          type: heldItemType,
        },
        blockBelow: subjectBlockContext.blockBelow,
        blockFront: subjectBlockContext.blockFront,
        nearbyBlocks: buildNearbyBlocksGrid(bot, subjectBlockRadius, subjectEntity?.position || entity.position),
        nearbyEntities: buildNearbyEntities(bot, subjectEntityDistance, subjectEntity),
        inventory: buildInventorySnapshot(bot),
        lastChatMessages: isObserverSample ? [] : recentChat,
        observer: observerData,
      },
      action: {
        label: actionLabel,
        success: actionSuccess,
        source: actionSource,
        metadata: actionMetadata,
      },
    }
  }

  function flushWriteQueue() {
    if (isFlushingQueue) return
    if (!writeQueue.length) return

    isFlushingQueue = true
    const currentFile = filePathForToday()
    const chunk = writeQueue.join('')
    writeQueue = []

    fs.appendFile(currentFile, chunk, 'utf8', (error) => {
      isFlushingQueue = false
      if (error) {
        console.log('[TRAINING] write error', error)
      }
      if (writeQueue.length) {
        flushWriteQueue()
      }
    })
  }

  function writeSample(sample) {
    writeQueue.push(JSON.stringify(sample) + '\n')
    flushWriteQueue()

    if (liveConsole && !bot?.__puppetActive) {
      const pos = sample.state.position
      const action = sample.action
      const status = action.success == null ? 'n/a' : (action.success ? 'ok' : 'fail')
      const observer = sample.state?.observer
      if (action.source === 'observer-mode' && observer?.username) {
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
    const sample = buildSample()
    if (!sample) return
    writeSample(sample)
  }

  function start() {
    if (!enabled || timer) return
    timer = setInterval(tick, Math.max(250, Number(intervalMs) || 1000))
    sessionMemory?.addMemory?.('Training recorder started.', 'training')
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
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
    recordActionOutcome,
    getDatasetDirectory: () => datasetDir,
  }
}

module.exports = {
  createTrainingRecorder,
}
