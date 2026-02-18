const { nearestAttackTarget } = require('./targets')

function createMessageHandler({
  bot,
  controls,
  applyControlStates,
  applyControlsFromKeySet,
  clearControlStates,
  setPuppetActive,
  reportAction,
  addLookDelta,
}) {
  return async function handleMessage(message) {
    let payload = null
    try {
      payload = JSON.parse(String(message || '{}'))
    } catch {
      return
    }

    if (!payload || typeof payload !== 'object') return

    if (payload.type === 'release') {
      setPuppetActive(false)
      return
    }

    if (payload.type === 'release_controls') {
      clearControlStates()
      return
    }

    setPuppetActive(true)
    bot.__movementPauseUntil = Date.now() + 2_000

    if (payload.type === 'heartbeat') {
      return
    }

    if (payload.type === 'key') {
      const isDown = Boolean(payload.isDown)
      switch (String(payload.code || '')) {
        case 'KeyW': controls.forward = isDown; break
        case 'KeyS': controls.back = isDown; break
        case 'KeyA': controls.left = isDown; break
        case 'KeyD': controls.right = isDown; break
        case 'KeyR': controls.sprint = isDown; break
        case 'Space': controls.jump = isDown; break
        case 'ShiftLeft':
        case 'ShiftRight': controls.sneak = isDown; break
        default: break
      }
      applyControlStates()
      reportAction('EXPLORE', true, { type: 'key', code: String(payload.code || ''), isDown })
      return
    }

    if (payload.type === 'sync_keys') {
      const keys = Array.isArray(payload.keys) ? payload.keys : []
      const keySet = new Set(keys.map((key) => String(key || '')))
      applyControlsFromKeySet(keySet)
      return
    }

    if (payload.type === 'look') {
      addLookDelta(Number(payload.dx || 0), Number(payload.dy || 0))
      return
    }

    if (payload.type === 'attack') {
      const target = nearestAttackTarget(bot, 4.5)
      if (target) {
        try {
          await bot.attack(target)
          reportAction(target.type === 'player' ? 'ATTACK_PLAYER' : 'ATTACK_MOB', true, {
            targetType: target.type,
            targetName: target.name || target.username || 'unknown',
          })
        } catch {
          reportAction(target.type === 'player' ? 'ATTACK_PLAYER' : 'ATTACK_MOB', false, { reason: 'attack-failed' })
        }
        return
      }

      try {
        const block = bot.blockAtCursor?.(6)
        if (!block || block.name === 'air') {
          reportAction('BREAK', false, { reason: 'no-target-block' })
          return
        }
        const canDig = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true
        if (!canDig) {
          reportAction('BREAK', false, { reason: 'cannot-dig', block: block.name })
          return
        }

        await bot.dig(block)
        reportAction('BREAK', true, { block: block.name })
      } catch {
        reportAction('BREAK', false, { reason: 'dig-failed' })
      }
      return
    }

    if (payload.type === 'use_item') {
      try {
        bot.activateItem()
        setTimeout(() => {
          try { bot.deactivateItem() } catch {}
        }, 120)
        reportAction('USE_ITEM', true, null)
      } catch {
        reportAction('USE_ITEM', false, { reason: 'use-item-failed' })
      }
    }
  }
}

module.exports = {
  createMessageHandler,
}
