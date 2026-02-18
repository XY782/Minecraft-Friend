const { createIntentLoop } = require('./intentLoop')

function createDecisionEngine({ bot, config, dynamicAgent, runAction, runDynamicAction, sessionMemory, onActionChosen, onGoalChosen, internalState, onActionOutcome = () => {} }) {
  let decisionBusy = false
  let lastDecisionAt = 0
  const actionCooldownUntil = new Map()
  const intentLoop = createIntentLoop({ bot, dynamicAgent, sessionMemory })
  const ENABLE_INTENT_LOOP = true
  const POLICY_ACTIONS = new Set([
    'IDLE', 'DEFEND', 'ATTACK_MOB', 'ATTACK_PLAYER', 'EAT', 'EQUIP', 'FLY', 'GET_ITEMS', 'USE_ITEM',
    'USE_TRIDENT', 'ENCHANT', 'USE_ANVIL', 'BUILD', 'BREAK', 'SLEEP', 'USE_FURNACE', 'CRAFT', 'COLLECT',
    'HELP_PLAYER', 'SOCIAL', 'TOGGLE_OFFHAND', 'EXPLORE', 'RECOVER',
  ])

  function safeNumber(value, fallback = 0) {
    const n = Number(value)
    return Number.isFinite(n) ? n : Number(fallback)
  }

  function safeString(value, fallback = '') {
    const text = String(value == null ? '' : value).trim()
    return text || fallback
  }

  function round(value, digits = 3) {
    const n = Number(value)
    if (!Number.isFinite(n)) return 0
    const factor = Math.pow(10, digits)
    return Math.round(n * factor) / factor
  }

  function getFacingStep(yawValue = 0) {
    const yaw = Number(yawValue || 0)
    const dx = Math.round(-Math.sin(yaw))
    const dz = Math.round(-Math.cos(yaw))
    return { dx, dz }
  }

  function buildPolicyStateSnapshot() {
    const entity = bot?.entity
    if (!entity?.position) return null

    const base = entity.position.floored?.() || entity.position
    const facing = getFacingStep(entity?.yaw)
    const blockBelow = bot.blockAt?.(base.offset?.(0, -1, 0) || entity.position)?.name || 'unknown'
    const blockFront = bot.blockAt?.(base.offset?.(facing.dx, 0, facing.dz) || entity.position)?.name || 'unknown'

    const nearbyEntities = Object.values(bot.entities || {})
      .filter((target) => target && target.id !== entity.id && target.position)
      .map((target) => {
        const dist = entity.position.distanceTo(target.position)
        return { target, dist }
      })
      .filter(({ dist }) => Number.isFinite(dist) && dist <= 12)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 12)
      .map(({ target, dist }) => ({
        id: target.id,
        type: safeString(target.type, 'unknown'),
        name: safeString(target.name || target.username || target.displayName, 'unknown'),
        distance: round(dist, 3),
      }))

    const inventoryItems = (bot?.inventory?.items?.() || []).map((item) => ({
      name: safeString(item?.name, 'unknown'),
      count: safeNumber(item?.count, 0),
      type: safeNumber(item?.type, -1),
    }))

    return {
      velocity: {
        vx: round(entity.velocity?.x || 0),
        vy: round(entity.velocity?.y || 0),
        vz: round(entity.velocity?.z || 0),
      },
      yaw: round(entity?.yaw || 0),
      pitch: round(entity?.pitch || 0),
      onGround: Boolean(entity?.onGround),
      inAir: !Boolean(entity?.onGround),
      health: safeNumber(bot?.health, 20),
      hunger: safeNumber(bot?.food, 20),
      selectedHotbarSlot: safeNumber(bot?.quickBarSlot, -1),
      heldItem: {
        name: safeString(bot?.heldItem?.name, 'none'),
        type: safeNumber(bot?.heldItem?.type, -1),
      },
      blockBelow,
      blockFront,
      nearbyEntities,
      inventory: inventoryItems,
    }
  }

  async function requestPolicyDecision() {
    if (!config.policyAutonomyEnabled) return null
    const stateSnapshot = buildPolicyStateSnapshot()
    if (!stateSnapshot) return null

    const timeoutMs = Math.max(200, Number(config.policyTimeoutMs || 1200))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(String(config.policyServerUrl || 'http://127.0.0.1:8765/predict'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: stateSnapshot,
          agent_id: String(bot?.username || 'bot'),
        }),
        signal: controller.signal,
      })
      if (!response.ok) return null
      const payload = await response.json()
      if (!payload?.ok) return null
      return payload
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  function markCooldown(action, ms) {
    const key = String(action || '').trim().toUpperCase()
    if (!key) return
    actionCooldownUntil.set(key, Date.now() + Math.max(400, Number(ms) || 2_500))
  }

  function isOnCooldown(action) {
    const key = String(action || '').trim().toUpperCase()
    if (!key) return false
    const until = Number(actionCooldownUntil.get(key) || 0)
    return until > Date.now()
  }

  function parseActionKey(outcome) {
    if (!outcome) return null
    if (outcome?.normalized?.kind === 'action') return String(outcome.normalized.action || '').toUpperCase()
    if (outcome?.normalized?.kind === 'command') return 'COMMAND'
    if (outcome?.normalized?.kind === 'chat') return 'CHAT'
    return null
  }

  function inferActionKeyFromText(text) {
    const line = String(text || '').trim().toLowerCase()
    if (!line) return null
    if (line.startsWith('/')) return 'COMMAND'
    if (/attack player|pvp|duel/.test(line)) return 'ATTACK_PLAYER'
    if (/attack mob|fight mob|kill mob|clear mobs/.test(line)) return 'ATTACK_MOB'
    if (/defend|hostile|danger|evade/.test(line)) return 'DEFEND'
    if (/craft|crafting/.test(line)) return 'CRAFT'
    if (/equip|armor|gear|elytra/.test(line)) return 'EQUIP'
    if (/eat|food|bread|hunger/.test(line)) return 'EAT'
    if (/collect|pickup|dropped item|loot/.test(line)) return 'COLLECT'
    if (/furnace|smelt|cook/.test(line)) return 'USE_FURNACE'
    if (/build|place block|construct/.test(line)) return 'BUILD'
    if (/break|mine|dig/.test(line)) return 'BREAK'
    if (/sleep|bed|night/.test(line)) return 'SLEEP'
    if (/social|chat|talk/.test(line)) return 'SOCIAL'
    if (/help player|assist/.test(line)) return 'HELP_PLAYER'
    if (/offhand|shield|totem/.test(line)) return 'TOGGLE_OFFHAND'
    if (/explore|wander|scout|move around/.test(line)) return 'EXPLORE'
    if (/recover|stabilize|get out of water|regain footing|escape water/.test(line)) return 'RECOVER'
    return null
  }

  function reportOutcome(action, success, source, details = null) {
    onActionOutcome?.({
      action: String(action || ''),
      success: Boolean(success),
      source: String(source || 'decision-engine'),
      details,
    })
  }

  function isInWaterLikeState() {
    try {
      if (bot?.entity?.isInWater || bot?.entity?.isInLava) return true
      const pos = bot?.entity?.position
      if (!pos || !bot?.blockAt) return false
      const feet = bot.blockAt(pos)
      const head = bot.blockAt(pos.offset(0, 1, 0))
      const feetName = String(feet?.name || '').toLowerCase()
      const headName = String(head?.name || '').toLowerCase()
      return feetName.includes('water') || headName.includes('water') || feetName.includes('bubble_column') || headName.includes('bubble_column')
    } catch {
      return false
    }
  }

  async function runDecisionStep() {
    if (!config.autonomousMode) return
    if (bot?.__puppetActive) return
    const now = Date.now()
    const emergencyUntil = Number(bot?.__envEmergencyUntil || 0)
    const recentlyHurt = (now - Number(bot?.__lastHurtAt || 0)) < 1_500
    const waterEmergency = isInWaterLikeState()
    const emergencyActive = waterEmergency || recentlyHurt || now < emergencyUntil

    if (decisionBusy) {
      if (!emergencyActive) return
      const emergencyAction = waterEmergency ? 'RECOVER' : 'DEFEND'
      const emergencyOk = Boolean(await runAction(emergencyAction, { keepMoving: true }))
      if (emergencyOk) {
        onActionChosen?.(emergencyAction)
        internalState?.onActionOutcome?.({ action: emergencyAction, success: true })
        markCooldown(emergencyAction, 350)
      }
      return
    }

    if (now < Number(bot?.__movementPauseUntil || 0) && !emergencyActive) return

    const minDecisionGapMs = Math.max(500, Number(config.decisionMinGapMs || 900))
    if (!emergencyActive && Date.now() - lastDecisionAt < minDecisionGapMs) return

    decisionBusy = true
    try {
      lastDecisionAt = Date.now()

      if (emergencyActive) {
        const emergencyAction = waterEmergency ? 'RECOVER' : 'DEFEND'
        onGoalChosen?.(waterEmergency ? 'recover footing and escape water' : 'react to incoming damage')
        const emergencyOk = Boolean(await runAction(emergencyAction, { keepMoving: true }))
        onActionChosen?.(emergencyAction)
        internalState?.onActionOutcome?.({ action: emergencyAction, success: emergencyOk })
        reportOutcome(emergencyAction, emergencyOk, 'emergency')
        markCooldown(emergencyAction, emergencyOk ? 450 : 250)

        sessionMemory?.addMemory(
          emergencyOk ? `Emergency response success: ${emergencyAction}` : `Emergency response failed: ${emergencyAction}`,
          emergencyOk ? 'action-success' : 'action-fail',
          {
            tags: ['autonomy', 'environment-reactive'],
            emergencyReason: String(bot?.__envEmergencyReason || (waterEmergency ? 'water' : 'hurt')),
            damageContext: bot?.__lastDamageContext || null,
          }
        )

        if (emergencyOk) {
          bot.__envEmergencyUntil = 0
          return
        }
      }

      const forced = bot?.__forcedDynamicAction
      if (forced && Date.now() < Number(forced.until || 0)) {
        if (forced.goal) onGoalChosen?.(String(forced.goal))

        const forcedActionText = String(forced.actionText || '').trim().toUpperCase()
        const useDirectAttack = forcedActionText === 'ATTACK_PLAYER'

        const forcedActed = useDirectAttack
          ? Boolean(await runAction('ATTACK_PLAYER'))
          : Boolean((await runDynamicAction(String(forced.actionText || '')))?.success)

        const forcedAction = useDirectAttack ? 'ATTACK_PLAYER' : String(forced?.actionText || '')
        const forcedKey = useDirectAttack ? 'ATTACK_PLAYER' : parseActionKey({ normalized: { kind: 'action', action: forcedAction } })

        onActionChosen?.(forcedAction)
        internalState?.onActionOutcome?.({ action: forcedAction, success: forcedActed })
        reportOutcome(forcedAction, forcedActed, 'forced-action', {
          source: String(forced.source || 'manual-intent'),
        })
        if (forcedKey) markCooldown(forcedKey, forcedActed ? Number(config.actionRepeatCooldownMs || 4_000) : 1_000)

        sessionMemory?.addMemory(
          forcedActed ? `Forced action success: ${forcedAction}` : `Forced action failed: ${forcedAction}`,
          forcedActed ? 'action-success' : 'action-fail',
          { tags: ['autonomy', 'forced-action'], source: String(forced.source || 'manual-intent') }
        )

        if (forcedActed || Date.now() >= Number(forced.until || 0)) {
          bot.__forcedDynamicAction = null
        }
        return
      }

      if (Date.now() < Number(bot?.__forcePvpUntil || 0)) {
        onGoalChosen?.(`engage controlled pvp with ${String(bot.__forcePvpTarget || 'target player')}`)
        const pvpActed = Boolean(await runAction('ATTACK_PLAYER'))
        onActionChosen?.('ATTACK_PLAYER')
        internalState?.onActionOutcome?.({ action: 'ATTACK_PLAYER', success: pvpActed })
        reportOutcome('ATTACK_PLAYER', pvpActed, 'forced-pvp-loop', {
          target: String(bot.__forcePvpTarget || ''),
        })
        markCooldown('ATTACK_PLAYER', pvpActed ? 700 : 350)

        sessionMemory?.addMemory(
          pvpActed ? 'Forced PvP loop success: ATTACK_PLAYER' : 'Forced PvP loop failed: ATTACK_PLAYER',
          pvpActed ? 'action-success' : 'action-fail',
          { tags: ['autonomy', 'forced-pvp-loop'], target: String(bot.__forcePvpTarget || '') }
        )

        if (pvpActed) return
      }

      const strategicGoal = dynamicAgent.deriveGoalNow?.()?.goal || null
      if (strategicGoal) onGoalChosen?.(strategicGoal)

      if (config.policyAutonomyEnabled) {
        const policyDecision = await requestPolicyDecision()
        const policyAction = String(policyDecision?.action || '').trim().toUpperCase()
        const policyConfidence = Number(policyDecision?.confidence || 0)
        const minConfidence = Number(config.policyMinConfidence || 0.35)

        if (policyAction && POLICY_ACTIONS.has(policyAction) && (policyConfidence >= minConfidence || policyAction === 'IDLE')) {
          onGoalChosen?.(`policy: ${policyAction}`)

          let policyActed = true
          if (policyAction !== 'IDLE') {
            policyActed = Boolean(await runAction(policyAction))
            markCooldown(policyAction, policyActed ? Number(config.actionRepeatCooldownMs || 4_000) : 1_200)
          }

          onActionChosen?.(policyAction)
          internalState?.onActionOutcome?.({ action: policyAction, success: policyActed })
          reportOutcome(policyAction, policyActed, 'policy-model', {
            confidence: policyConfidence,
            modelType: String(policyDecision?.model_type || 'unknown'),
          })

          sessionMemory?.addMemory(
            `Policy action ${policyActed ? 'success' : 'failed'}: ${policyAction} (conf=${policyConfidence.toFixed(3)})`,
            policyActed ? 'action-success' : 'action-fail',
            { tags: ['autonomy', 'policy-model'] }
          )
          return
        }
      }

      const urgentDecision = await dynamicAgent.decideUrgentActions()
      if (urgentDecision?.urgentActions?.length) {
        onGoalChosen?.('resolve urgent situation')
        for (const urgentActionText of urgentDecision.urgentActions.slice(0, 2)) {
          const hintedKey = inferActionKeyFromText(urgentActionText)
          if (hintedKey && isOnCooldown(hintedKey)) continue

          const urgentOutcome = await runDynamicAction(urgentActionText)
          const acted = Boolean(urgentOutcome?.success)
          const executed = String(urgentOutcome?.action || urgentActionText)
          const actionKey = parseActionKey(urgentOutcome)

          if (actionKey && isOnCooldown(actionKey)) continue

          onActionChosen?.(executed)
          internalState?.onActionOutcome?.({ action: executed, success: acted })
          reportOutcome(executed, acted, 'urgent', {
            rawActionText: String(urgentActionText),
            normalizedKind: urgentOutcome?.normalized?.kind || null,
          })
          if (actionKey) markCooldown(actionKey, acted ? Number(config.actionRepeatCooldownMs || 4_000) : 1_200)

          sessionMemory?.addMemory(
            acted ? `Urgent action success: ${executed}` : `Urgent action failed: ${executed}`,
            acted ? 'action-success' : 'action-fail',
            {
              source: String(urgentDecision?.source || 'urgent'),
              rawActionText: String(urgentActionText),
              normalizedKind: urgentOutcome?.normalized?.kind || null,
              tags: ['autonomy', 'dynamic-urgent'],
            }
          )

          if (acted) return
        }
      }

      if (ENABLE_INTENT_LOOP) {
        intentLoop.refreshIntentIfNeeded().catch(() => {})
        const intentGoal = intentLoop.getCurrentIntent()
        const intentSubgoal = intentLoop.getCurrentSubgoal?.() || ''
        const intentStep = intentLoop.getNextAction()

        if (intentGoal) onGoalChosen?.(`intent: ${intentGoal}`)
        if (intentSubgoal) onGoalChosen?.(`subgoal: ${intentSubgoal}`)

        if (intentStep) {
          const hintedIntentKey = inferActionKeyFromText(intentStep)
          if (hintedIntentKey && isOnCooldown(hintedIntentKey)) {
            intentLoop.onActionResult({ success: false, executedAction: `cooldown:${intentStep}` })
            return
          }

          const forcePvpActive = Date.now() < Number(bot?.__forcePvpUntil || 0)
          if (forcePvpActive && String(intentStep).toUpperCase() !== 'ATTACK_PLAYER') {
            intentLoop.onActionResult({ success: false, executedAction: `skipped:${intentStep}` })
          } else {
          const intentOutcome = await runDynamicAction(intentStep)
          const intentActed = Boolean(intentOutcome?.success)
          const intentAction = String(intentOutcome?.action || intentStep)
          const intentKey = parseActionKey(intentOutcome)

          onActionChosen?.(intentAction)
          internalState?.onActionOutcome?.({ action: intentAction, success: intentActed })
          reportOutcome(intentAction, intentActed, 'intent-step', {
            intentStep: String(intentStep),
            normalizedKind: intentOutcome?.normalized?.kind || null,
          })
          if (intentKey) markCooldown(intentKey, intentActed ? Number(config.actionRepeatCooldownMs || 4_000) : 1_300)

          sessionMemory?.addMemory(
            intentActed ? `Intent action success: ${intentAction}` : `Intent action failed: ${intentAction}`,
            intentActed ? 'action-success' : 'action-fail',
            { tags: ['autonomy', 'intent-step'] }
          )

          intentLoop.onActionResult({ success: intentActed, executedAction: intentAction })
          if (intentActed) return
          }
        }
      }

      const decision = await dynamicAgent.decideNextAction({
        currentGoal: strategicGoal || '',
      })
      const actionText = String(decision?.actionText || '').trim()
      if (!actionText) return

      const hintedActionKey = inferActionKeyFromText(actionText)
      if (hintedActionKey && isOnCooldown(hintedActionKey)) return

      onGoalChosen?.(`do: ${actionText.slice(0, 80)}`)

      const outcome = await runDynamicAction(actionText)
      const acted = Boolean(outcome?.success)
      const executed = String(outcome?.action || actionText)
      const actionKey = parseActionKey(outcome)

      if (actionKey && isOnCooldown(actionKey)) {
        return
      }

      onActionChosen?.(executed)
      internalState?.onActionOutcome?.({ action: executed, success: acted })
      reportOutcome(executed, acted, 'dynamic-decision', {
        rawActionText: actionText,
        normalizedKind: outcome?.normalized?.kind || null,
        decisionSource: String(decision?.source || 'unknown'),
      })
      if (actionKey) markCooldown(actionKey, acted ? Number(config.actionRepeatCooldownMs || 4_000) : 1_400)

      sessionMemory?.addMemory(
        acted ? `Action success: ${executed}` : `Action failed: ${executed}`,
        acted ? 'action-success' : 'action-fail',
        {
          source: String(decision?.source || 'unknown'),
          rawActionText: actionText,
          normalizedKind: outcome?.normalized?.kind || null,
          tags: ['autonomy', 'dynamic-decision'],
        }
      )

      if (!acted) {
        const fallbackText = dynamicAgent.pickDiverseFallback(decision?.snapshot, decision?.drives, {
          failedAction: actionText,
        })
        const hintedFallbackKey = inferActionKeyFromText(fallbackText)
        if (hintedFallbackKey && isOnCooldown(hintedFallbackKey)) return

        const fallbackOutcome = await runDynamicAction(fallbackText)
        const fallbackActed = Boolean(fallbackOutcome?.success)
        const fallbackAction = String(fallbackOutcome?.action || fallbackText)
        const fallbackKey = parseActionKey(fallbackOutcome)

        if (fallbackKey) markCooldown(fallbackKey, fallbackActed ? Number(config.actionRepeatCooldownMs || 4_000) : 1_500)

        onActionChosen?.(fallbackAction)
        internalState?.onActionOutcome?.({ action: fallbackAction, success: fallbackActed })
        reportOutcome(fallbackAction, fallbackActed, 'fallback', {
          rawActionText: fallbackText,
        })
        sessionMemory?.addMemory(
          fallbackActed ? `Fallback action success: ${fallbackAction}` : `Fallback action failed: ${fallbackAction}`,
          fallbackActed ? 'action-success' : 'action-fail',
          { tags: ['autonomy', 'fallback'], rawActionText: fallbackText }
        )
      }
    } catch (e) {
      console.log('decision step error', e)
    } finally {
      decisionBusy = false
    }
  }

  return {
    runDecisionStep,
  }
}

module.exports = {
  createDecisionEngine,
}
