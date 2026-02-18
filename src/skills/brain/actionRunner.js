const { eatIfNeeded } = require('../eating')
const { nearestHostile, attackOrEvade, attackHostileMob } = require('../combat')
const { nearestDroppedItem, collectNearbyItem } = require('../collection')
const { sleepIfNeeded } = require('../sleep')
const { craftIfNeeded } = require('../craft')
const { useFurnaceIfNeeded } = require('../furnace')
const { nearestPlayerTarget, attackNearbyPlayer } = require('../pvp')
const { equipIfNeeded } = require('../equipment')
const { creativeFly, creativeGetItems, creativeUseItem } = require('../creative')
const { enchantIfPossible } = require('../enchant')
const { buildIfWanted } = require('../build')
const { breakIfWanted } = require('../break')
const { useAnvilIfPossible } = require('../anvil')
const { useTridentIfPossible } = require('../trident')
const { helpNearbyPlayer } = require('../help')
const { toggleOffhandIfPossible } = require('../offhand')

function createActionRunner({
  bot,
  goals,
  config,
  state,
  utils,
  movement,
  social,
  executeCommand,
  gemini,
  getProfileContext,
  sessionMemory,
  safeChat,
}) {
  const supportedActions = new Set([
    'DEFEND', 'ATTACK_MOB', 'EAT', 'EQUIP', 'FLY', 'GET_ITEMS', 'USE_ITEM', 'USE_TRIDENT',
    'ENCHANT', 'USE_ANVIL', 'BUILD', 'BREAK', 'SLEEP', 'USE_FURNACE', 'CRAFT', 'COLLECT',
    'ATTACK_PLAYER', 'HELP_PLAYER', 'SOCIAL', 'TOGGLE_OFFHAND', 'EXPLORE', 'RECOVER',
  ])

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

  function isSafeCommandText(value) {
    const text = String(value || '').trim()
    if (!text.startsWith('/')) return false
    if (text.length > 120) return false
    if (/[\r\n;]/.test(text)) return false
    return /^\/[a-z0-9_:\-]+(?:\s+[a-z0-9_:\-@.,]+)*$/i.test(text)
  }

  function normalizeDynamicAction(actionText) {
    const raw = String(actionText || '').trim()
    if (!raw) return null

    if (raw.startsWith('/')) {
      if (!isSafeCommandText(raw)) return { kind: 'invalid', reason: 'unsafe-command', raw }
      return { kind: 'command', command: raw }
    }

    const line = raw.toLowerCase()
    const upperRaw = raw.toUpperCase()

    const aliases = [
      { match: /defend|hostile|danger|evade/, action: 'DEFEND' },
      { match: /eat|food|bread|hunger/, action: 'EAT' },
      { match: /equip|armor|gear|elytra/, action: 'EQUIP' },
      { match: /collect|pickup|dropped item|loot/, action: 'COLLECT' },
      { match: /attack mob|fight mob|kill mob|clear mobs/, action: 'ATTACK_MOB' },
      { match: /attack player|pvp|duel/, action: 'ATTACK_PLAYER' },
      { match: /sleep|bed|night/, action: 'SLEEP' },
      { match: /craft|crafting/, action: 'CRAFT' },
      { match: /furnace|smelt|cook/, action: 'USE_FURNACE' },
      { match: /enchant/, action: 'ENCHANT' },
      { match: /anvil|repair|combine/, action: 'USE_ANVIL' },
      { match: /build|place block|construct/, action: 'BUILD' },
      { match: /break|mine|dig/, action: 'BREAK' },
      { match: /recover|stabilize|get out of water|regain footing|escape water/, action: 'RECOVER' },
      { match: /trident/, action: 'USE_TRIDENT' },
      { match: /social|chat|talk/, action: 'SOCIAL' },
      { match: /help player|assist/, action: 'HELP_PLAYER' },
      { match: /offhand|shield|totem/, action: 'TOGGLE_OFFHAND' },
      { match: /fly|aerial/, action: 'FLY' },
      { match: /get items|give item|creative item/, action: 'GET_ITEMS' },
      { match: /use item|throw|consume item/, action: 'USE_ITEM' },
      { match: /explore|wander|scout|move around/, action: 'EXPLORE' },
      { match: /^([A-Z_]{3,})$/, action: upperRaw },
    ]

    for (const alias of aliases) {
      if (alias.match.test(line)) {
        if (!supportedActions.has(alias.action)) return { kind: 'invalid', reason: 'unsupported-action', raw }
        return { kind: 'action', action: alias.action }
      }
    }

    if (/^say\s+/i.test(raw)) {
      const sayText = raw.replace(/^say\s+/i, '').trim()
      if (sayText) return { kind: 'chat', text: sayText }
    }

    return { kind: 'invalid', reason: 'unrecognized-action', raw }
  }

  async function runAction(action, options = {}) {
    const keepMoving = Boolean(options.keepMoving)
    if (!action) return false

    if (action === 'DEFEND') {
      const hostile = nearestHostile({
        bot,
        nearestEntity: utils.nearestEntity,
        distanceToEntity: utils.distanceToEntity,
        maxDistance: config.dangerRadius,
      })
      if (hostile) {
        return attackOrEvade({
          bot,
          goals,
          hostile,
          state,
          stopExploring: movement.stopExploring,
          safeChat,
          randInt: utils.randInt,
          attackEnabled: config.attackEnabled,
          attackDistance: config.attackDistance,
          keepMoving,
        })
      }

      const recentDamage = bot.__lastDamageContext || null
      const damageAge = Date.now() - Number(recentDamage?.at || 0)
      const recentPlayerAttacker = damageAge <= 2_500 && String(recentDamage?.threatType || '') === 'player'
      if (recentPlayerAttacker) {
        const playerTarget = nearestPlayerTarget({
          bot,
          getNearbyPlayers: utils.getNearbyPlayers,
          maxDistance: Math.max(14, Number(config.attackPlayerRange || 8)),
          preferredUsername: String(recentDamage?.threatName || ''),
        })
        if (playerTarget) {
          return attackNearbyPlayer({
            bot,
            goals,
            state,
            stopExploring: movement.stopExploring,
            safeChat,
            player: playerTarget,
            attackDistance: config.attackDistance,
            keepMoving,
          })
        }
      }

      return false
    }

    if (action === 'ATTACK_MOB') {
      const hostile = nearestHostile({
        bot,
        nearestEntity: utils.nearestEntity,
        distanceToEntity: utils.distanceToEntity,
        maxDistance: config.dangerRadius + 10,
      })
      if (!hostile) return false
      return attackHostileMob({
        bot,
        goals,
        hostile,
        state,
        stopExploring: movement.stopExploring,
        safeChat,
        attackDistance: config.attackDistance,
        keepMoving,
      })
    }

    if (action === 'RECOVER') {
      const immediateThreat = nearestHostile({
        bot,
        nearestEntity: utils.nearestEntity,
        distanceToEntity: utils.distanceToEntity,
        maxDistance: Math.max(6, Number(config.dangerRadius || 10)),
      })

      if (immediateThreat) {
        return attackOrEvade({
          bot,
          goals,
          hostile: immediateThreat,
          state,
          stopExploring: movement.stopExploring,
          safeChat,
          randInt: utils.randInt,
          attackEnabled: config.attackEnabled,
          attackDistance: config.attackDistance,
          keepMoving,
        })
      }

      if (isInWaterLikeState()) {
        state.setMode('evade')
        try {
          bot.pathfinder?.setGoal?.(null)
          bot.setControlState('forward', true)
          bot.setControlState('jump', true)
          bot.setControlState('sprint', false)
        } catch {}

        setTimeout(() => {
          try {
            if (!isInWaterLikeState()) {
              bot.setControlState('forward', false)
              bot.setControlState('jump', false)
            }
            if (state.getMode() === 'evade') state.setMode('idle')
          } catch {}
        }, 450)

        return true
      }

      return false
    }

    if (action === 'EAT') {
      if (keepMoving) return false
      return eatIfNeeded({
        bot,
        lowFoodThreshold: config.lowFoodThreshold,
        state,
        stopExploring: movement.stopExploring,
        safeChat,
        chance: utils.chance,
      })
    }

    if (action === 'EQUIP') {
      if (!config.equipEnabled) return false
      return equipIfNeeded({
        bot,
        state,
        stopExploring: keepMoving ? () => {} : movement.stopExploring,
        safeChat,
        preferElytra: config.preferElytra,
      })
    }

    if (action === 'FLY') {
      return creativeFly({ bot, state, stopExploring: keepMoving ? () => {} : movement.stopExploring, safeChat })
    }

    if (action === 'GET_ITEMS') {
      return creativeGetItems({
        bot,
        state,
        safeChat,
        allowCheats: config.allowCheats,
        executeCommand,
        gemini,
        getProfileContext,
        sessionMemory,
      })
    }

    if (action === 'USE_ITEM') {
      return creativeUseItem({ bot, state, stopExploring: keepMoving ? () => {} : movement.stopExploring, safeChat })
    }

    if (action === 'USE_TRIDENT') {
      return useTridentIfPossible({
        bot,
        state,
        stopExploring: keepMoving ? () => {} : movement.stopExploring,
      })
    }

    if (action === 'ENCHANT') {
      if (keepMoving) return false
      return enchantIfPossible({
        bot,
        goals,
        state,
        stopExploring: movement.stopExploring,
        safeChat,
        searchRadius: config.enchantSearchRadius,
      })
    }

    if (action === 'USE_ANVIL') {
      if (keepMoving) return false
      return useAnvilIfPossible({
        bot,
        goals,
        state,
        stopExploring: movement.stopExploring,
        searchRadius: config.enchantSearchRadius,
      })
    }

    if (action === 'BUILD') {
      return buildIfWanted({
        bot,
        state,
        stopExploring: movement.stopExploring,
        keepMoving,
      })
    }

    if (action === 'BREAK') {
      return breakIfWanted({
        bot,
        state,
        stopExploring: movement.stopExploring,
        keepMoving,
      })
    }

    if (action === 'SLEEP') {
      if (keepMoving) return false
      return sleepIfNeeded({
        bot,
        goals,
        state,
        stopExploring: movement.stopExploring,
        searchRadius: config.sleepSearchRadius,
        safeChat,
      })
    }

    if (action === 'USE_FURNACE') {
      if (keepMoving) return false
      return useFurnaceIfNeeded({
        bot,
        goals,
        state,
        stopExploring: movement.stopExploring,
        safeChat,
        searchRadius: config.furnaceSearchRadius,
      })
    }

    if (action === 'CRAFT') {
      if (!config.craftEnabled) return false
      if (keepMoving) return false

      const immediateThreat = nearestHostile({
        bot,
        nearestEntity: utils.nearestEntity,
        distanceToEntity: utils.distanceToEntity,
        maxDistance: Math.max(5, Number(config.dangerRadius || 10)),
      })

      if (immediateThreat) {
        return attackOrEvade({
          bot,
          goals,
          hostile: immediateThreat,
          state,
          stopExploring: movement.stopExploring,
          safeChat,
          randInt: utils.randInt,
          attackEnabled: config.attackEnabled,
          attackDistance: config.attackDistance,
          keepMoving,
        })
      }

      return craftIfNeeded({
        bot,
        goals,
        state,
        stopExploring: movement.stopExploring,
        safeChat,
        searchRadius: config.craftingSearchRadius,
        shouldAbort: () => Boolean(nearestHostile({
          bot,
          nearestEntity: utils.nearestEntity,
          distanceToEntity: utils.distanceToEntity,
          maxDistance: Math.max(5, Number(config.dangerRadius || 10)),
        })),
      })
    }

    if (action === 'COLLECT') {
      const nearbyItem = nearestDroppedItem({
        bot,
        nearestEntity: utils.nearestEntity,
        distanceToEntity: utils.distanceToEntity,
        maxDistance: config.collectItemRadius,
      })
      if (!nearbyItem) return false
      return collectNearbyItem({
        bot,
        goals,
        itemEntity: nearbyItem,
        state,
        stopExploring: keepMoving ? () => {} : movement.stopExploring,
      })
    }

    if (action === 'ATTACK_PLAYER') {
      const forcedPvp = Date.now() < Number(bot.__forcePvpUntil || 0)
      if (!config.attackPlayers && !forcedPvp) return false
      if (!forcedPvp && !utils.chance(config.attackPlayerChance)) return false
      const targetPlayer = nearestPlayerTarget({
        bot,
        getNearbyPlayers: utils.getNearbyPlayers,
        maxDistance: forcedPvp ? Math.max(24, Number(config.attackPlayerRange || 8)) : config.attackPlayerRange,
        preferredUsername: bot.__forcePvpTarget || null,
      })
      if (!targetPlayer) return false
      return attackNearbyPlayer({
        bot,
        goals,
        state,
        stopExploring: movement.stopExploring,
        safeChat,
        player: targetPlayer,
        attackDistance: config.attackDistance,
        keepMoving,
      })
    }

    if (action === 'HELP_PLAYER') {
      return helpNearbyPlayer({
        bot,
        goals,
        state,
        stopExploring: keepMoving ? () => {} : movement.stopExploring,
        getNearbyPlayers: utils.getNearbyPlayers,
        keepMoving,
      })
    }

    if (action === 'SOCIAL') return social.runSocialDecision()

    if (action === 'TOGGLE_OFFHAND') {
      return toggleOffhandIfPossible({ bot, state })
    }

    if (action === 'EXPLORE') {
      if (state.getMode() === 'idle' && config.autoExploreOnSpawn) {
        movement.startExploring(false)
        return true
      }
    }

    return false
  }

  async function runDynamicAction(actionText, options = {}) {
    const normalized = normalizeDynamicAction(actionText)
    if (!normalized) return { success: false, normalized: null }

    if (normalized.kind === 'command') {
      const ok = await executeCommand(normalized.command)
      return {
        success: Boolean(ok),
        normalized,
        action: normalized.command,
      }
    }

    if (normalized.kind === 'chat') {
      safeChat(normalized.text)
      return {
        success: true,
        normalized,
        action: 'CHAT',
      }
    }

    if (normalized.kind === 'action') {
      const ok = await runAction(normalized.action, options)
      return {
        success: Boolean(ok),
        normalized,
        action: normalized.action,
      }
    }

    if (normalized.kind === 'invalid') {
      return {
        success: false,
        normalized,
        action: null,
      }
    }

    return {
      success: false,
      normalized,
      action: null,
    }
  }

  async function runActionBundle(actions = []) {
    const unique = Array.from(new Set((actions || []).filter(Boolean))).slice(0, config.maxConcurrentActions || 3)
    if (!unique.length) return []

    const jobs = unique.map((action, index) =>
      runAction(action, { keepMoving: index > 0 })
        .then((ok) => ({ action, success: Boolean(ok) }))
        .catch((e) => {
          console.log('bundle action error', action, e)
          return { action, success: false }
        })
    )

    return Promise.all(jobs)
  }

  return {
    runAction,
    runActionBundle,
    runDynamicAction,
  }
}

module.exports = {
  createActionRunner,
}
