const fs = require('fs')
const path = require('path')

const {
  round,
  safeString,
  safeNumber,
  angularDistance,
  sanitizeGroundFlags,
} = require('./utils')
const {
  buildNearbyBlocksGrid,
  compressNearbyBlocks,
  buildNearbyEntities,
  getBlockContext,
  getViewContext,
  getNormalizedVelocity,
  buildInventorySnapshot,
  getControlSnapshot,
  getEnvironmentSnapshot,
  normalizeAngle,
  serializeItem,
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
  getObserverEntity = () => null,
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
  let lastRecordedState = null
  let lastFrameAt = 0
  let lastVelocity = null
  let lastLook = null
  let lastSaturation = null
  let lastEntityCount = 0
  let lastWrittenSample = null
  let lastWrittenAt = 0
  let dedupSkippedCount = 0
  let dedupKeptCount = 0
  let lastDedupLogAt = 0
  let actionSequence = []
  let actionOutcome = {
    at: 0,
    action: 'IDLE',
    success: null,
    source: 'none',
    details: null,
  }

  const observerSampler = createObserverSampler({
    enabled: observerModeActive,
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

  function clamp(value, min, max) {
    const n = Number(value)
    if (!Number.isFinite(n)) return min
    return Math.min(max, Math.max(min, n))
  }

  function inventorySignature(items) {
    return (items || [])
      .map((item) => `${String(item?.name || 'unknown')}:${Number(item?.count || 0)}`)
      .sort()
      .join('|')
  }

  function computeVelocityLocal(velocity, yaw) {
    const vx = Number(velocity?.vx || 0)
    const vy = Number(velocity?.vy || 0)
    const vz = Number(velocity?.vz || 0)
    const headingX = -Math.sin(Number(yaw || 0))
    const headingZ = -Math.cos(Number(yaw || 0))
    const rightX = Math.cos(Number(yaw || 0))
    const rightZ = -Math.sin(Number(yaw || 0))
    return {
      forward: round(vx * headingX + vz * headingZ, 4),
      side: round(vx * rightX + vz * rightZ, 4),
      vertical: round(vy, 4),
    }
  }

  function extractStatusEffects(effectMap) {
    if (!effectMap || typeof effectMap !== 'object') return []
    return Object.entries(effectMap).map(([effectId, effect]) => ({
      id: String(effect?.id ?? effectId),
      name: String(effect?.name || effectId),
      amplifier: Number(effect?.amplifier ?? 0),
      duration: Number(effect?.duration ?? 0),
      isDebuff: /poison|wither|slowness|weakness|blindness|hunger/.test(String(effect?.name || effectId).toLowerCase()),
    }))
  }

  function buildArmorSnapshot() {
    const slots = Array.isArray(bot?.inventory?.slots) ? bot.inventory.slots : []
    const armorSlots = [5, 6, 7, 8]
    const equipped = armorSlots
      .map((slot) => slots?.[slot])
      .filter(Boolean)
      .map((item) => serializeItem(item))
    return {
      value: Number.isFinite(Number(bot?.entity?.equipment?.armor)) ? Number(bot.entity.equipment.armor) : null,
      equipped,
    }
  }

  function deriveInteractionSlices(nearbyBlocks = []) {
    const lowerName = (entry) => String(entry?.block || '').toLowerCase()
    const redstoneStates = nearbyBlocks
      .filter((entry) => /redstone|lever|button|repeater|comparator|observer/.test(lowerName(entry)))
      .slice(0, 24)
      .map((entry) => ({
        dx: entry.dx,
        dy: entry.dy,
        dz: entry.dz,
        block: entry.block,
        powerLevel: entry.metadata,
      }))

    const crops = nearbyBlocks
      .filter((entry) => /wheat|carrots|potatoes|beetroots|cocoa|nether_wart/.test(lowerName(entry)))
      .slice(0, 24)
      .map((entry) => ({
        dx: entry.dx,
        dy: entry.dy,
        dz: entry.dz,
        block: entry.block,
        growthStage: entry.metadata,
        age: entry.metadata,
      }))

    const interactables = nearbyBlocks
      .filter((entry) => /door|trapped_chest|pressure_plate|lever/.test(lowerName(entry)))
      .slice(0, 24)
      .map((entry) => ({
        dx: entry.dx,
        dy: entry.dy,
        dz: entry.dz,
        block: entry.block,
        state: entry.metadata,
      }))

    const fluids = nearbyBlocks
      .filter((entry) => entry.fluidType)
      .slice(0, 24)
      .map((entry) => ({
        dx: entry.dx,
        dy: entry.dy,
        dz: entry.dz,
        type: entry.fluidType,
        level: entry.fluidLevel,
        flowDirection: null,
      }))

    const trapDetection = {
      tntPrimedNearby: nearbyBlocks.some((entry) => /tnt|tnt_minecart/.test(lowerName(entry))),
      tripwireNearby: nearbyBlocks.some((entry) => /tripwire/.test(lowerName(entry))),
    }

    return {
      redstoneStates,
      crops,
      interactables,
      fluids,
      trapDetection,
    }
  }

  function inferLikelyActions({ state, entities, inventory, blockFront }) {
    const candidates = new Set()
    const hunger = Number(state?.hunger || 20)
    const health = Number(state?.health || 20)
    const hasItemDrops = (entities || []).some((entity) => String(entity?.name || '').toLowerCase() === 'item')
    const hasHostiles = (entities || []).some((entity) => String(entity?.type || '').toLowerCase() === 'mob')
    const hasPlayers = (entities || []).some((entity) => String(entity?.type || '').toLowerCase() === 'player')
    const hasInventory = (inventory || []).length > 0

    if (hasHostiles || health <= 10) candidates.add('DEFEND')
    if (hasItemDrops) candidates.add('COLLECT')
    if (hunger <= 12 && hasInventory) candidates.add('EAT')
    if (hasPlayers) candidates.add('SOCIAL')
    if (String(blockFront || '').toLowerCase() !== 'air') candidates.add('BREAK')
    candidates.add('EXPLORE')

    return Array.from(candidates).slice(0, 4)
  }

  function buildEvents(current, previous) {
    if (!previous) {
      return {
        jumped: false,
        landed: false,
        inventoryChanged: false,
        healthChanged: false,
        hungerChanged: false,
        lookChanged: false,
        nearbyEntitiesChanged: false,
        hurtRecently: false,
      }
    }

    const jumped = previous.onGround && !current.onGround && Number(current.vy || 0) > 0.12
    const landed = !previous.onGround && current.onGround
    const inventoryChanged = current.inventorySig !== previous.inventorySig
    const healthChanged = Math.abs(Number(current.health || 0) - Number(previous.health || 0)) >= 0.01
    const hungerChanged = Math.abs(Number(current.hunger || 0) - Number(previous.hunger || 0)) >= 0.01
    const lookChanged = angularDistance(current.yaw, previous.yaw) >= 0.08 || angularDistance(current.pitch, previous.pitch) >= 0.06
    const nearbyEntitiesChanged = Number(current.nearbyEntities || 0) !== Number(previous.nearbyEntities || 0)
    const hurtRecently = (Date.now() - Number(bot?.__lastHurtAt || 0)) <= 1500

    return {
      jumped,
      landed,
      inventoryChanged,
      healthChanged,
      hungerChanged,
      lookChanged,
      nearbyEntitiesChanged,
      hurtRecently,
    }
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

  function buildSample() {
    const entity = bot?.entity
    if (!entity?.position) return null

    const mode = safeString(getMode()) || 'idle'
    const recentChat = Array.isArray(getRecentChat()) ? getRecentChat().slice(-8) : []
    const actionAgeMs = Date.now() - Number(actionOutcome.at || 0)
    const freshOutcome = actionAgeMs <= 15_000
    const controlState = getControlSnapshot(bot)
    const nearbyBlockRadius = 2
    const nearbyEntityDistance = 10
    const outcomeSource = safeString(actionOutcome.source || 'none').toLowerCase()
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

    let observerData = null
    let observerState = null
    let isObserverSample = false
    let observerEntity = null
    if (observerModeActive) {
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

    const fullNearbyBlocks = buildNearbyBlocksGrid(bot, subjectBlockRadius, subjectEntity?.position || entity.position)
    const compressedBlocks = compressNearbyBlocks(fullNearbyBlocks, subjectBlockRadius, blockCompressionMode)
    const nearbyBlocks = compressedBlocks.blocks
    const nearbyEntities = buildNearbyEntities(bot, subjectEntityDistance, subjectEntity)
    const inventory = buildInventorySnapshot(bot)
    const view = getViewContext(bot, subjectEntity, Number(lineOfSightMaxDistance || 8))
    const environment = getEnvironmentSnapshot(bot, subjectEntity)
    const normalizedVelocity = getNormalizedVelocity(subjectVelocity)
    const now = Date.now()
    const frameDelta = lastFrameAt > 0 ? Math.max(0.001, (now - lastFrameAt) / 1000) : Number(intervalMs || 350) / 1000
    const yawNow = round(subjectEntity?.yaw || observerState?.yaw || 0)
    const pitchNow = round(subjectEntity?.pitch || observerState?.pitch || 0)
    const velocityLocal = computeVelocityLocal(subjectVelocity, yawNow)
    const acceleration = {
      ax: lastVelocity ? round((Number(subjectVelocity?.vx || 0) - Number(lastVelocity?.vx || 0)) / frameDelta, 4) : 0,
      ay: lastVelocity ? round((Number(subjectVelocity?.vy || 0) - Number(lastVelocity?.vy || 0)) / frameDelta, 4) : 0,
      az: lastVelocity ? round((Number(subjectVelocity?.vz || 0) - Number(lastVelocity?.vz || 0)) / frameDelta, 4) : 0,
    }
    const angularVelocity = {
      yawRate: lastLook ? round(normalizeAngle(yawNow - Number(lastLook.yaw || 0)) / frameDelta, 4) : 0,
      pitchRate: lastLook ? round(normalizeAngle(pitchNow - Number(lastLook.pitch || 0)) / frameDelta, 4) : 0,
    }
    const armor = buildArmorSnapshot()
    const saturation = Number.isFinite(Number(bot?.foodSaturation ?? bot?.foodSaturationLevel))
      ? Number(bot?.foodSaturation ?? bot?.foodSaturationLevel)
      : null
    const saturationDecayRate = (lastSaturation != null && saturation != null)
      ? round((Number(lastSaturation) - Number(saturation)) / frameDelta, 4)
      : null
    const interactionSlices = deriveInteractionSlices(fullNearbyBlocks)
    const heldItemRaw = bot?.heldItem || null
    const heldItem = heldItemRaw
      ? serializeItem(heldItemRaw)
      : {
          name: heldItemName,
          type: heldItemType,
          count: 0,
          durability: null,
          enchantments: [],
        }

    const mountEntity = bot?.vehicle || bot?.entity?.vehicle || null
    const statusEffects = extractStatusEffects(bot?.entity?.effects)
    const hasSpeedEffect = statusEffects.some((effect) => String(effect?.name || effect?.id || '').toLowerCase().includes('speed'))
    const hostileCount = nearbyEntities.filter((entity) => String(entity?.aggressionLevel || '').toLowerCase() === 'hostile').length
    const projectiles = nearbyEntities
      .filter((entity) => entity?.projectile)
      .slice(0, 16)
      .map((entity) => ({
        id: entity.id,
        type: entity.projectile.type,
        position: entity.position,
        velocity: entity.velocity,
        owner: entity.projectile.owner,
        damagePotential: entity.projectile.damagePotential,
      }))

    const currentStateSummary = {
      onGround: groundFlags.onGround,
      vy: subjectVelocity?.vy,
      health: safeNumber(bot?.health, 20),
      hunger: safeNumber(bot?.food, 20),
      yaw: yawNow,
      pitch: pitchNow,
      nearbyEntities: nearbyEntities.length,
      inventorySig: inventorySignature(inventory),
    }
    const events = buildEvents(currentStateSummary, lastRecordedState)

    actionMetadata = {
      ...(actionMetadata || {}),
      likelyActions: inferLikelyActions({
        state: currentStateSummary,
        entities: nearbyEntities,
        inventory,
        blockFront: subjectBlockContext.blockFront,
      }),
      mode,
    }

    const lastAction = {
      label: actionLabel,
      success: actionSuccess,
      duration: Number(actionMetadata?.durationMs ?? actionMetadata?.duration ?? null),
      metadata: actionMetadata,
      cooldowns: actionMetadata?.cooldowns || null,
    }
    actionSequence.push({
      timestamp: new Date(now).toISOString(),
      label: actionLabel,
      success: actionSuccess,
      source: actionSource,
    })
    const maxHistory = Math.max(3, Number(actionHistorySize || 12))
    if (actionSequence.length > maxHistory) {
      actionSequence = actionSequence.slice(actionSequence.length - maxHistory)
    }

    const climbing = {
      ladder: /ladder/.test(String(subjectBlockContext.blockFront || '').toLowerCase()),
      vine: /vine/.test(String(subjectBlockContext.blockFront || '').toLowerCase()),
      soulSand: /soul_sand|soul_soil/.test(String(subjectBlockContext.blockBelow || '').toLowerCase()),
    }

    const eventTriggers = {
      mobSpawn: nearbyEntities.length > lastEntityCount,
      redstonePulse: interactionSlices.redstoneStates.length > 0,
      explosion: false,
      ...events,
    }

    const sample = {
      timestamp: new Date().toISOString(),
      state: {
        position: subjectPosition,
        velocity: subjectVelocity,
        velocityLocal,
        acceleration,
        normalizedVelocity,
        yaw: yawNow,
        pitch: pitchNow,
        angularVelocity,
        fallDistance: round(Number(subjectEntity?.fallDistance || 0), 4),
        onGround: groundFlags.onGround,
        inAir: groundFlags.inAir,
        swimming: Boolean(subjectEntity?.isInWater || subjectEntity?.isInLava),
        climbing,
        sprinting: Boolean(controlState?.sprint || hasSpeedEffect),
        sneaking: Boolean(controlState?.sneak),
        flying: Boolean(subjectEntity?.elytraFlying || subjectEntity?.isElytraFlying),
        mounted: {
          isRiding: Boolean(mountEntity),
          mountType: mountEntity ? String(mountEntity?.name || mountEntity?.type || 'unknown') : null,
        },
        health: safeNumber(bot?.health, 20),
        armor,
        hunger: safeNumber(bot?.food, 20),
        saturation,
        saturationDecayRate,
        statusEffects,
        experience: {
          level: Number.isFinite(Number(bot?.experience?.level)) ? Number(bot.experience.level) : null,
          totalXP: Number.isFinite(Number(bot?.experience?.total)) ? Number(bot.experience.total) : null,
          progress: Number.isFinite(Number(bot?.experience?.progress)) ? Number(bot.experience.progress) : null,
        },
        selectedHotbarSlot,
        heldItem,
        blockBelow: subjectBlockContext.blockBelow,
        blockFront: subjectBlockContext.blockFront,
        nearbyBlocks,
        nearbyBlocksEncoding: compressedBlocks.encoding,
        nearbyBlocksSurface: compressedBlocks.surface,
        nearbyBlocksStats: compressedBlocks.stats,
        nearbyEntities,
        projectiles,
        inventory,
        cameraTarget: view?.cameraTarget || null,
        lineOfSight: view?.lineOfSight || [],
        lightLevel: environment?.lightLevel || { skyLight: null, blockLight: null },
        weather: environment?.weather || { rain: false, thunder: false, snow: false },
        timeOfDay: environment?.timeOfDay || { age: null, day: null, time: null, isDay: null },
        biome: environment?.biome || { id: null, name: null, category: null, temperature: null, rainfall: null },
        dimension: environment?.dimension || 'unknown',
        heightLimits: environment?.heightLimits || { floor: null, ceiling: null },
        chunkRegion: environment?.chunkRegion || { chunkX: null, chunkZ: null, regionX: null, regionZ: null, loaded: null },
        redstoneStates: interactionSlices.redstoneStates,
        crops: interactionSlices.crops,
        interactables: interactionSlices.interactables,
        fluids: interactionSlices.fluids,
        trapDetection: interactionSlices.trapDetection,
        particleEffects: [],
        playerLookTarget: view?.lookVector || null,
        eventTriggers,
        frameDelta,
        lastAction,
        actionSequence: [...actionSequence],
        temporal: {
          frameDelta,
          lastAction,
          actionSequence: [...actionSequence],
          predictedNextFrameDelta: null,
        },
        predictedEnvironmentDelta: null,
        view,
        events,
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

    lastRecordedState = currentStateSummary
    lastFrameAt = now
    lastVelocity = {
      vx: Number(subjectVelocity?.vx || 0),
      vy: Number(subjectVelocity?.vy || 0),
      vz: Number(subjectVelocity?.vz || 0),
    }
    lastLook = {
      yaw: yawNow,
      pitch: pitchNow,
    }
    lastSaturation = saturation
    lastEntityCount = nearbyEntities.length
    return sample
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
    lastWrittenSample = sample
    lastWrittenAt = Date.now()

    if (liveConsole) {
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
    if (!recorderEnabled) return
    const sample = buildSample()
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
      observerSampler?.setEnabled?.(observerModeActive)
    },
    isObserverModeEnabled: () => observerModeActive,
    recordActionOutcome,
    getDatasetDirectory: () => datasetDir,
  }
}

module.exports = {
  createTrainingRecorder,
}
