const fs = require('fs')
const path = require('path')

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function round(value, digits = 3) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  const factor = Math.pow(10, digits)
  return Math.round(n * factor) / factor
}

function safeString(value) {
  return String(value == null ? '' : value).trim()
}

function safeNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : Number(fallback)
}

function createTrainingRecorder({
  bot,
  rootDir,
  sessionMemory,
  enabled = true,
  intervalMs = 1000,
  liveConsole = true,
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

  function buildNearbyBlocksGrid(radius = 2) {
    const entity = bot?.entity
    if (!entity?.position) return []

    const points = []
    const base = entity.position.floored()
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          const block = bot.blockAt(base.offset(dx, dy, dz))
          points.push({
            dx,
            dy,
            dz,
            block: block?.name || 'unknown',
          })
        }
      }
    }

    return points
  }

  function buildNearbyEntities(maxDistance = 10) {
    const self = bot?.entity
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

    return entities.map(({ entity, dist }) => ({
      id: entity.id,
      type: entity.type || 'unknown',
      name: entity.name || entity.username || entity.displayName || 'unknown',
      distance: round(dist, 3),
      position: {
        x: round(entity.position.x),
        y: round(entity.position.y),
        z: round(entity.position.z),
      },
    }))
  }

  function getFacingStep() {
    const yaw = Number(bot?.entity?.yaw || 0)
    const dx = Math.round(-Math.sin(yaw))
    const dz = Math.round(-Math.cos(yaw))
    return {
      dx,
      dz,
    }
  }

  function getBlockContext() {
    const entity = bot?.entity
    if (!entity?.position || !bot?.blockAt) {
      return {
        blockBelow: 'unknown',
        blockFront: 'unknown',
      }
    }

    const base = entity.position.floored()
    const facing = getFacingStep()
    const blockBelow = bot.blockAt(base.offset(0, -1, 0))
    const blockFront = bot.blockAt(base.offset(facing.dx, 0, facing.dz))

    return {
      blockBelow: blockBelow?.name || 'unknown',
      blockFront: blockFront?.name || 'unknown',
    }
  }

  function buildInventorySnapshot() {
    const items = bot?.inventory?.items?.() || []
    return items.map((item) => ({
      name: item?.name || 'unknown',
      count: Number(item?.count || 0),
      slot: Number(item?.slot ?? -1),
      type: Number(item?.type ?? -1),
      metadata: Number(item?.metadata ?? 0),
    }))
  }

  function getControlSnapshot() {
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

  function inferManualActionFromControls(controlState) {
    const moving = Boolean(
      controlState?.forward ||
      controlState?.back ||
      controlState?.left ||
      controlState?.right ||
      controlState?.jump
    )
    if (moving) return 'MANUAL_MOVE'
    if (Boolean(controlState?.sneak)) return 'MANUAL_SNEAK'
    return 'MANUAL_IDLE'
  }

  function buildSample() {
    const entity = bot?.entity
    if (!entity?.position) return null

    const manualControlActive = Boolean(bot?.__puppetActive)
    const intent = manualControlActive ? 'manual-control' : safeString(getIntent())
    const mode = manualControlActive ? 'manual-puppet' : (safeString(getMode()) || 'idle')
    const lastAction = safeString(getLastAction()) || null
    const recentChat = Array.isArray(getRecentChat()) ? getRecentChat().slice(-8) : []
    const actionAgeMs = Date.now() - Number(actionOutcome.at || 0)
    const freshOutcome = actionAgeMs <= 15_000
    const controlState = getControlSnapshot()
    const nearbyBlockRadius = manualControlActive ? 1 : 2
    const nearbyEntityDistance = manualControlActive ? 8 : 10
    const outcomeSource = safeString(actionOutcome.source || 'none').toLowerCase()
    const isManualOutcome = outcomeSource === 'puppet' || outcomeSource === 'first-person-puppet'
    const selectedHotbarSlot = safeNumber(bot?.quickBarSlot, -1)
    const heldItemName = safeString(bot?.heldItem?.name || 'none') || 'none'
    const heldItemType = safeNumber(bot?.heldItem?.type, -1)
    const blockContext = getBlockContext()

    let actionLabel = freshOutcome ? actionOutcome.action : (lastAction || 'IDLE')
    let actionSuccess = freshOutcome ? actionOutcome.success : null
    let actionSource = freshOutcome ? actionOutcome.source : 'state-only'
    let actionMetadata = freshOutcome ? actionOutcome.details : null

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

    return {
      timestamp: new Date().toISOString(),
      state: {
        position: {
          x: round(entity.position.x),
          y: round(entity.position.y),
          z: round(entity.position.z),
        },
        velocity: {
          vx: round(entity.velocity?.x || 0),
          vy: round(entity.velocity?.y || 0),
          vz: round(entity.velocity?.z || 0),
        },
        onGround: Boolean(entity.onGround),
        inAir: !Boolean(entity.onGround),
        health: safeNumber(bot?.health, 20),
        hunger: safeNumber(bot?.food, 20),
        selectedHotbarSlot,
        heldItem: {
          name: heldItemName,
          type: heldItemType,
        },
        controls: controlState,
        blockBelow: blockContext.blockBelow,
        blockFront: blockContext.blockFront,
        nearbyBlocks: buildNearbyBlocksGrid(nearbyBlockRadius),
        nearbyEntities: buildNearbyEntities(nearbyEntityDistance),
        inventory: buildInventorySnapshot(),
        lastChatMessages: recentChat,
        activeIntent: intent,
        activeMode: mode,
        lastBrainAction: lastAction,
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
      const goal = sample.state.activeIntent || 'none'
      const status = action.success == null ? 'n/a' : (action.success ? 'ok' : 'fail')
      console.log(
        `[TRAINING] ${sample.timestamp} | action=${action.label} (${status}) | pos=${pos.x},${pos.y},${pos.z} | intent=${goal}`
      )
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
