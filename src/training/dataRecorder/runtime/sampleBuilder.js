function createSampleBuilder({
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
}) {
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
  } = snapshot

  let lastRecordedState = null
  let lastFrameAt = 0
  let lastVelocity = null
  let lastLook = null
  let lastSaturation = null
  let lastEntityCount = 0
  let actionSequence = []

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

  function normalizeObservedItem(item, fallback = {}) {
    if (!item || typeof item !== 'object') return null
    return {
      name: String(item?.name || fallback?.name || 'unknown'),
      count: Number.isFinite(Number(item?.count)) ? Number(item.count) : Number(fallback?.count || 1),
      slot: Number.isFinite(Number(item?.slot)) ? Number(item.slot) : Number(fallback?.slot ?? -1),
      type: Number.isFinite(Number(item?.type)) ? Number(item.type) : Number(fallback?.type ?? -1),
      metadata: Number.isFinite(Number(item?.metadata)) ? Number(item.metadata) : Number(fallback?.metadata ?? 0),
      durability: item?.durability || null,
      enchantments: Array.isArray(item?.enchantments) ? item.enchantments : [],
    }
  }

  function normalizeTelemetryPosition(position, fallback = null) {
    if (!position || typeof position !== 'object') return fallback
    return {
      x: round(Number(position.x ?? fallback?.x ?? 0)),
      y: round(Number(position.y ?? fallback?.y ?? 0)),
      z: round(Number(position.z ?? fallback?.z ?? 0)),
    }
  }

  function normalizeTelemetryVelocity(velocity, fallback = null) {
    if (!velocity || typeof velocity !== 'object') return fallback
    return {
      vx: round(Number(velocity.vx ?? fallback?.vx ?? 0)),
      vy: round(Number(velocity.vy ?? fallback?.vy ?? 0)),
      vz: round(Number(velocity.vz ?? fallback?.vz ?? 0)),
    }
  }

  function resolveSubjectVitals(observerEntity, isObserverSample) {
    if (!isObserverSample) {
      return {
        health: safeNumber(bot?.health, 20),
        hunger: safeNumber(bot?.food, 20),
        armorValue: Number.isFinite(Number(bot?.entity?.equipment?.armor)) ? Number(bot.entity.equipment.armor) : null,
      }
    }

    const observerHealth = Number(observerEntity?.health)
    return {
      health: Number.isFinite(observerHealth) ? observerHealth : safeNumber(bot?.health, 20),
      hunger: null,
      armorValue: Number.isFinite(Number(observerEntity?.armor)) ? Number(observerEntity.armor) : null,
    }
  }

  function buildSubjectArmorSnapshot(observerEntity, isObserverSample) {
    if (!isObserverSample) return buildArmorSnapshot()

    const equipment = Array.isArray(observerEntity?.equipment) ? observerEntity.equipment.filter(Boolean) : []
    const equipped = equipment
      .map((item) => normalizeObservedItem(serializeItem(item), { count: 1 }))
      .filter(Boolean)

    return {
      value: Number.isFinite(Number(observerEntity?.armor)) ? Number(observerEntity.armor) : null,
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

  function buildSample({ observerModeActive, actionOutcome }) {
    const entity = bot?.entity
    if (!entity?.position) return null

    const mode = safeString(getMode()) || 'idle'
    const recentChat = Array.isArray(getRecentChat()) ? getRecentChat().slice(-8) : []
    const actionAgeMs = Date.now() - Number(actionOutcome.at || 0)
    const freshOutcome = actionAgeMs <= 15_000
    const controlState = getControlSnapshot(bot)
    const nearbyBlockRadius = 2
    const nearbyEntityDistance = 10
    let selectedHotbarSlot = safeNumber(bot?.quickBarSlot, -1)
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
      actionMetadata = { reason: 'invalid-intent-step' }
    }

    let observerData = null
    let observerState = null
    let isObserverSample = false
    let observerEntity = null
    const userTelemetry = typeof getUserTelemetry === 'function' ? getUserTelemetry() : null
    const telemetryState = userTelemetry?.state && typeof userTelemetry.state === 'object' ? userTelemetry.state : null
    const telemetryAction = userTelemetry?.action && typeof userTelemetry.action === 'object' ? userTelemetry.action : null
    const telemetryHasPosition = Boolean(telemetryState?.position && typeof telemetryState.position === 'object')
    const telemetryObserverActive = observerModeActive && telemetryHasPosition

    if (telemetryObserverActive) {
      const telemetryObserverPosition = normalizeTelemetryPosition(telemetryState.position)
      const telemetryObserverVelocity = normalizeTelemetryVelocity(telemetryState.velocity, { vx: 0, vy: 0, vz: 0 })
      observerState = {
        position: telemetryObserverPosition,
        velocity: telemetryObserverVelocity,
        yaw: round(Number(telemetryState?.yaw ?? 0)),
        pitch: round(Number(telemetryState?.pitch ?? 0)),
        onGround: Boolean(telemetryState?.onGround),
      }
      observerData = {
        username: safeString(userTelemetry?.player?.name || 'telemetry-player') || 'telemetry-player',
        distance: 0,
        ...observerState,
      }
      isObserverSample = true
      actionLabel = String(telemetryAction?.label || actionLabel || 'OBSERVER_IDLE').trim().toUpperCase()
      actionSuccess = telemetryAction?.success == null ? actionSuccess : Boolean(telemetryAction.success)
      actionSource = safeString(telemetryAction?.source || 'user-telemetry') || 'user-telemetry'
      actionMetadata = {
        ...(actionMetadata || {}),
        ...(telemetryAction?.metadata && typeof telemetryAction.metadata === 'object' ? telemetryAction.metadata : {}),
        telemetryPov: true,
      }
    }

    const observerTelemetryMissing = observerModeActive && !telemetryObserverActive

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

    if (telemetryState?.position && typeof telemetryState.position === 'object') {
      const telemetryPosition = normalizeTelemetryPosition(telemetryState.position, subjectPosition)
      subjectPosition.x = telemetryPosition.x
      subjectPosition.y = telemetryPosition.y
      subjectPosition.z = telemetryPosition.z
    }
    if (telemetryState?.velocity && typeof telemetryState.velocity === 'object') {
      const telemetryVelocity = normalizeTelemetryVelocity(telemetryState.velocity, subjectVelocity)
      subjectVelocity.vx = telemetryVelocity.vx
      subjectVelocity.vy = telemetryVelocity.vy
      subjectVelocity.vz = telemetryVelocity.vz
    }
    const subjectEntity = isObserverSample ? observerEntity : entity
    const subjectBlockRadius = isObserverSample ? 1 : nearbyBlockRadius
    const subjectEntityDistance = isObserverSample ? 8 : nearbyEntityDistance
    const subjectBlockContext = isObserverSample ? getBlockContext(bot, subjectEntity) : blockContext
    if (typeof telemetryState?.blockBelow === 'string') {
      subjectBlockContext.blockBelow = telemetryState.blockBelow
    }
    if (typeof telemetryState?.blockFront === 'string') {
      subjectBlockContext.blockFront = telemetryState.blockFront
    }
    const groundFlags = sanitizeGroundFlags(
      isObserverSample ? observerState?.onGround : entity.onGround,
      isObserverSample ? !Boolean(observerState?.onGround) : !Boolean(entity.onGround),
      subjectVelocity?.vy
    )

    const fullNearbyBlocks = Array.isArray(telemetryState?.nearbyBlocksRaw)
      ? telemetryState.nearbyBlocksRaw
      : buildNearbyBlocksGrid(bot, subjectBlockRadius, subjectEntity?.position || entity.position)
    const compressedBlocks = (
      telemetryState?.nearbyBlocksEncoding && Array.isArray(telemetryState?.nearbyBlocks)
    )
      ? {
          encoding: String(telemetryState.nearbyBlocksEncoding || 'external'),
          blocks: telemetryState.nearbyBlocks,
          surface: Array.isArray(telemetryState?.nearbyBlocksSurface) ? telemetryState.nearbyBlocksSurface : [],
          stats: telemetryState?.nearbyBlocksStats || null,
        }
      : compressNearbyBlocks(fullNearbyBlocks, subjectBlockRadius, blockCompressionMode)
    const nearbyBlocks = compressedBlocks.blocks
    const nearbyEntities = Array.isArray(telemetryState?.nearbyEntities)
      ? telemetryState.nearbyEntities
      : buildNearbyEntities(bot, subjectEntityDistance, subjectEntity)
    let inventory = buildInventorySnapshot(bot)
    const view = getViewContext(bot, subjectEntity, Number(lineOfSightMaxDistance || 8))
    const environment = getEnvironmentSnapshot(bot, subjectEntity)
    const normalizedVelocity = getNormalizedVelocity(subjectVelocity)
    const now = Date.now()
    const frameDelta = lastFrameAt > 0 ? Math.max(0.001, (now - lastFrameAt) / 1000) : Number(intervalMs || 350) / 1000
    const yawNow = round(Number(telemetryState?.yaw ?? (subjectEntity?.yaw || observerState?.yaw || 0)))
    const pitchNow = round(Number(telemetryState?.pitch ?? (subjectEntity?.pitch || observerState?.pitch || 0)))
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
    const armor = buildSubjectArmorSnapshot(observerEntity, isObserverSample)
    const saturation = Number.isFinite(Number(bot?.foodSaturation ?? bot?.foodSaturationLevel))
      ? Number(bot?.foodSaturation ?? bot?.foodSaturationLevel)
      : null
    const saturationDecayRate = (lastSaturation != null && saturation != null)
      ? round((Number(lastSaturation) - Number(saturation)) / frameDelta, 4)
      : null
    const interactionSlices = deriveInteractionSlices(fullNearbyBlocks)
    let heldItemRaw = bot?.heldItem || null
    let heldItem = heldItemRaw
      ? serializeItem(heldItemRaw)
      : {
          name: heldItemName,
          type: heldItemType,
          count: 0,
          durability: null,
          enchantments: [],
        }

    if (isObserverSample) {
      selectedHotbarSlot = -1
      heldItemRaw = null
    }

    if (Array.isArray(telemetryState?.inventory)) {
      inventory = telemetryState.inventory.map((item, index) => normalizeObservedItem(item, { slot: index })).filter(Boolean)
    }
    if (telemetryState?.heldItem && typeof telemetryState.heldItem === 'object') {
      heldItem = normalizeObservedItem(telemetryState.heldItem, { count: 1 }) || heldItem
    }
    if (Number.isFinite(Number(telemetryState?.selectedHotbarSlot))) {
      selectedHotbarSlot = Number(telemetryState.selectedHotbarSlot)
    }

    const mountEntity = isObserverSample
      ? (subjectEntity?.vehicle || null)
      : (bot?.vehicle || bot?.entity?.vehicle || null)
    const statusEffects = extractStatusEffects(isObserverSample ? subjectEntity?.effects : bot?.entity?.effects)
    const hasSpeedEffect = statusEffects.some((effect) => String(effect?.name || effect?.id || '').toLowerCase().includes('speed'))
    const projectiles = nearbyEntities
      .filter((entry) => entry?.projectile)
      .slice(0, 16)
      .map((entry) => ({
        id: entry.id,
        type: entry.projectile.type,
        position: entry.position,
        velocity: entry.velocity,
        owner: entry.projectile.owner,
        damagePotential: entry.projectile.damagePotential,
      }))

    const subjectVitals = resolveSubjectVitals(observerEntity, isObserverSample)
    if (Number.isFinite(Number(telemetryState?.health))) {
      subjectVitals.health = Number(telemetryState.health)
    }
    if (Number.isFinite(Number(telemetryState?.hunger))) {
      subjectVitals.hunger = Number(telemetryState.hunger)
    }
    if (Number.isFinite(Number(telemetryState?.armor))) {
      subjectVitals.armorValue = Number(telemetryState.armor)
    }

    const currentStateSummary = {
      onGround: groundFlags.onGround,
      vy: subjectVelocity?.vy,
      health: subjectVitals.health,
      hunger: subjectVitals.hunger,
      yaw: yawNow,
      pitch: pitchNow,
      nearbyEntities: nearbyEntities.length,
      inventorySig: inventorySignature(inventory),
    }
    const events = buildEvents(currentStateSummary, lastRecordedState)

    const likelyActions = actionLabeling.inferLikelyActions({
      state: currentStateSummary,
      entities: nearbyEntities,
      inventory,
      blockFront: subjectBlockContext.blockFront,
      blockBelow: subjectBlockContext.blockBelow,
      nearbyBlocks: fullNearbyBlocks,
      heldItem,
    })

    if (isObserverSample) {
      const inferredObserverAction = actionLabeling.classifyObserverInteractionAction({
        actionLabel,
        likelyActions,
        heldItem,
        inventory,
        nearbyEntities,
        nearbyBlocksSurface: compressedBlocks.surface,
        lineOfSight: view?.lineOfSight || [],
      })

      if (inferredObserverAction !== actionLabel) {
        actionLabel = inferredObserverAction
        actionSource = 'observer-derived'
        actionMetadata = {
          ...(actionMetadata || {}),
          observerDerived: true,
        }
      }

      const promotedObserverLabel = actionLabeling.promoteObserverActionLabel(actionLabel, likelyActions)
      if (promotedObserverLabel !== actionLabel) {
        actionMetadata = {
          ...(actionMetadata || {}),
          observerPromotion: {
            from: actionLabel,
            to: promotedObserverLabel,
          },
        }
        actionLabel = promotedObserverLabel
      }
    }

    if (typeof telemetryAction?.label === 'string' && telemetryAction.label.trim()) {
      actionLabel = telemetryAction.label.trim().toUpperCase()
      actionSource = String(telemetryAction.source || 'user-telemetry')
      actionSuccess = telemetryAction.success == null ? actionSuccess : Boolean(telemetryAction.success)
      actionMetadata = {
        ...(actionMetadata || {}),
        ...(telemetryAction.metadata && typeof telemetryAction.metadata === 'object' ? telemetryAction.metadata : {}),
        telemetryOverride: true,
      }
    }

    actionMetadata = {
      ...(actionMetadata || {}),
      observerTelemetryMissing,
      likelyActions,
      labelQuality: actionLabeling.labelQuality({
        actionSource,
        observerDerived: Boolean(actionMetadata?.observerDerived),
        isObserverSample,
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

    const telemetryView = telemetryState?.view && typeof telemetryState.view === 'object' ? telemetryState.view : null
    const telemetryEnvironment = {
      weather: telemetryState?.weather && typeof telemetryState.weather === 'object' ? telemetryState.weather : null,
      timeOfDay: telemetryState?.timeOfDay && typeof telemetryState.timeOfDay === 'object' ? telemetryState.timeOfDay : null,
      biome: telemetryState?.biome && typeof telemetryState.biome === 'object' ? telemetryState.biome : null,
      dimension: typeof telemetryState?.dimension === 'string' ? telemetryState.dimension : null,
      heightLimits: telemetryState?.heightLimits && typeof telemetryState.heightLimits === 'object' ? telemetryState.heightLimits : null,
      chunkRegion: telemetryState?.chunkRegion && typeof telemetryState.chunkRegion === 'object' ? telemetryState.chunkRegion : null,
      lightLevel: telemetryState?.lightLevel && typeof telemetryState.lightLevel === 'object' ? telemetryState.lightLevel : null,
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
        health: subjectVitals.health,
        armor,
        hunger: subjectVitals.hunger,
        saturation,
        saturationDecayRate,
        statusEffects,
        experience: {
          level: !isObserverSample && Number.isFinite(Number(bot?.experience?.level)) ? Number(bot.experience.level) : null,
          totalXP: !isObserverSample && Number.isFinite(Number(bot?.experience?.total)) ? Number(bot.experience.total) : null,
          progress: !isObserverSample && Number.isFinite(Number(bot?.experience?.progress)) ? Number(bot.experience.progress) : null,
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
        cameraTarget: telemetryView?.cameraTarget || telemetryState?.cameraTarget || view?.cameraTarget || null,
        lineOfSight: Array.isArray(telemetryView?.lineOfSight)
          ? telemetryView.lineOfSight
          : (Array.isArray(telemetryState?.lineOfSight) ? telemetryState.lineOfSight : (view?.lineOfSight || [])),
        lightLevel: telemetryEnvironment.lightLevel || environment?.lightLevel || { skyLight: null, blockLight: null },
        weather: telemetryEnvironment.weather || environment?.weather || { rain: false, thunder: false, snow: false },
        timeOfDay: telemetryEnvironment.timeOfDay || environment?.timeOfDay || { age: null, day: null, time: null, isDay: null },
        biome: telemetryEnvironment.biome || environment?.biome || { id: null, name: null, category: null, temperature: null, rainfall: null },
        dimension: telemetryEnvironment.dimension || environment?.dimension || 'unknown',
        heightLimits: telemetryEnvironment.heightLimits || environment?.heightLimits || { floor: null, ceiling: null },
        chunkRegion: telemetryEnvironment.chunkRegion || environment?.chunkRegion || { chunkX: null, chunkZ: null, regionX: null, regionZ: null, loaded: null },
        redstoneStates: interactionSlices.redstoneStates,
        crops: interactionSlices.crops,
        interactables: interactionSlices.interactables,
        fluids: interactionSlices.fluids,
        trapDetection: interactionSlices.trapDetection,
        particleEffects: [],
        playerLookTarget: telemetryView?.lookVector || telemetryState?.playerLookTarget || view?.lookVector || null,
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
        view: telemetryView || view,
        events,
        lastChatMessages: isObserverSample ? [] : recentChat,
        observer: observerData,
        subject: {
          perspective: isObserverSample ? 'player-pov' : 'bot-self',
          inventorySource: Array.isArray(telemetryState?.inventory)
            ? 'user-telemetry'
            : 'bot-inventory',
          heldItemSource: telemetryState?.heldItem
            ? 'user-telemetry'
            : 'bot-held-item',
          telemetryActive: Boolean(userTelemetry),
          telemetryPov: telemetryObserverActive,
        },
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

  function reset() {
    lastRecordedState = null
    lastFrameAt = 0
    lastVelocity = null
    lastLook = null
    lastSaturation = null
    lastEntityCount = 0
    actionSequence = []
  }

  return {
    buildSample,
    reset,
  }
}

module.exports = {
  createSampleBuilder,
}
