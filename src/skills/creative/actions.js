const { isCreativeMode } = require('../../utils/gamemode')
const { config } = require('../../config')
const { creativeSetState, shouldLogCreativeError, shouldLogSetSlotDisabled } = require('./state')
const { desiredCreativeItems, pickHotbarSlot, pickLeastUsefulHotbarSlot } = require('./inventory')
const { chooseCreativeTarget } = require('./targeting')

function isCreative(bot) {
  return isCreativeMode(bot)
}

function createItemFactory(bot) {
  return require('prismarine-item')(bot.registry)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function creativeFly({ bot, state, stopExploring }) {
  if (!bot.entity) return false
  if (!config.allowCreativeFlight) return false
  const flightStage = Math.max(0, Number(config.creativeFlightStage || 0))
  if (flightStage < 1) return false
  if (!isCreative(bot)) {
    return false
  }

  try {
    state.setMode('creative-fly')
    stopExploring()

    if (bot.creative?.startFlying) {
      await bot.creative.startFlying()
    } else {
      bot.setControlState('jump', true)
      setTimeout(() => bot.setControlState('jump', false), 350)
    }

    if (flightStage === 1) {
      await wait(450)
      try {
        bot.creative?.stopFlying?.()
      } catch {}
      return true
    }

    const origin = bot.entity.position
    const target = origin.offset((Math.random() * 20) - 10, 8 + Math.random() * 10, (Math.random() * 20) - 10)
    await bot.lookAt(target, true)

    if (bot.creative?.flyTo) {
      await bot.creative.flyTo(target)
    }

    return true
  } catch (e) {
    console.log('creative fly error', e)
    return false
  } finally {
    if (state.getMode() === 'creative-fly') state.setMode('idle')
  }
}

async function creativeGetItems({ bot, state, allowCheats, executeCommand, gemini, getProfileContext, sessionMemory }) {
  if (!isCreative(bot)) return false

  const now = Date.now()
  if (creativeSetState.inFlight) return false
  if (now < creativeSetState.backoffUntil) return false
  if (now - creativeSetState.lastAttemptAt < 6_500) return false

  const itemName = await chooseCreativeTarget({ bot, gemini, getProfileContext, sessionMemory })
  if (!itemName) return false

  const desiredSet = new Set(desiredCreativeItems(bot))
  let attemptedSlot = null

  try {
    creativeSetState.inFlight = true
    creativeSetState.lastAttemptAt = Date.now()
    state.setMode('creative-get-item')

    const itemId = bot.registry?.itemsByName?.[itemName]?.id
    const setSlotAllowed = Date.now() >= creativeSetState.disableSetSlotUntil

    if (typeof itemId === 'number' && bot.creative?.setInventorySlot && setSlotAllowed) {
      const emptyOrNextSlot = pickHotbarSlot(bot)
      const slot = emptyOrNextSlot ?? pickLeastUsefulHotbarSlot(bot, desiredSet) ?? 36
      attemptedSlot = slot

      const Item = createItemFactory(bot)
      const stack = new Item(itemId, 16)

      await bot.creative.setInventorySlot(slot, stack)
      creativeSetState.consecutiveFailures = 0
      creativeSetState.backoffUntil = 0
      creativeSetState.slotCooldownUntil.delete(slot)
      return true
    }

    if (!setSlotAllowed && shouldLogSetSlotDisabled()) {
      console.log('creative setInventorySlot temporarily disabled due to repeated server timeout/cancel errors')
    }

    if (allowCheats && typeof executeCommand === 'function') {
      const ok = await executeCommand(`give ${bot.username} ${itemName} 1`)
      if (ok) {
        creativeSetState.consecutiveFailures = 0
        return true
      }
    }

    return false
  } catch (e) {
    const msg = String(e?.message || '')
    const isTimeout = msg.includes('did not fire within timeout')
    const isCanceled = msg.includes('cancelled due to calling bot.creative.setInventorySlot')

    if (isTimeout || isCanceled) {
      creativeSetState.consecutiveFailures += 1

      const adaptiveBackoffMs = Math.min(120_000, 8_000 * Math.max(1, creativeSetState.consecutiveFailures))
      creativeSetState.backoffUntil = Date.now() + adaptiveBackoffMs

      if (creativeSetState.consecutiveFailures >= 3) {
        creativeSetState.disableSetSlotUntil = Date.now() + 10 * 60_000
      }

      if (attemptedSlot != null) {
        creativeSetState.slotCooldownUntil.set(attemptedSlot, Date.now() + 120_000)
      }
    }

    if (shouldLogCreativeError()) {
      console.log('creative get items error', e)
    }
    return false
  } finally {
    creativeSetState.inFlight = false
    if (state.getMode() === 'creative-get-item') state.setMode('idle')
  }
}

async function creativeUseItem({ bot, state, stopExploring, safeChat }) {
  if (!isCreative(bot)) return false

  try {
    const item = (bot.inventory?.items?.() || []).find((entry) => ['firework_rocket', 'golden_apple', 'water_bucket'].includes(String(entry.name || '').toLowerCase()))
    if (!item) return false

    state.setMode('creative-use-item')
    stopExploring()
    await bot.equip(item, 'hand')
    await bot.activateItem()
    return true
  } catch (e) {
    console.log('creative use item error', e)
    return false
  } finally {
    try {
      bot.deactivateItem()
    } catch {}
    if (state.getMode() === 'creative-use-item') state.setMode('idle')
  }
}

module.exports = {
  creativeFly,
  creativeGetItems,
  creativeUseItem,
}
