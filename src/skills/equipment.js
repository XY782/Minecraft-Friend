const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather']

function getItemName(item) {
  return String(item?.name || '').toLowerCase()
}

function findBestArmorItem(items, slot) {
  const candidates = items.filter((item) => {
    const name = getItemName(item)
    if (!name) return false

    if (slot === 'head') return name.endsWith('_helmet')
    if (slot === 'torso') return name.endsWith('_chestplate')
    if (slot === 'legs') return name.endsWith('_leggings')
    if (slot === 'feet') return name.endsWith('_boots')
    return false
  })

  if (!candidates.length) return null

  candidates.sort((a, b) => {
    const aName = getItemName(a)
    const bName = getItemName(b)
    const aTier = ARMOR_TIERS.findIndex((tier) => aName.startsWith(tier + '_'))
    const bTier = ARMOR_TIERS.findIndex((tier) => bName.startsWith(tier + '_'))
    const aRank = aTier === -1 ? 999 : aTier
    const bRank = bTier === -1 ? 999 : bTier
    return aRank - bRank
  })

  return candidates[0]
}

function isWearing(bot, slot, matcher) {
  try {
    const slotId = bot.getEquipmentDestSlot(slot)
    const equipped = bot.inventory?.slots?.[slotId]
    return Boolean(equipped && matcher(getItemName(equipped)))
  } catch {
    return false
  }
}

async function equipIfNeeded({ bot, state, stopExploring, safeChat, preferElytra = true }) {
  const items = bot.inventory?.items?.() || []
  if (!items.length) return false

  try {
    state.setMode('equip')
    stopExploring()

    let changed = false

    const hasElytra = items.find((item) => getItemName(item) === 'elytra')
    if (preferElytra && hasElytra && !isWearing(bot, 'torso', (name) => name === 'elytra')) {
      await bot.equip(hasElytra, 'torso')
      changed = true
    }

    const head = findBestArmorItem(items, 'head')
    if (head && !isWearing(bot, 'head', (name) => name === getItemName(head))) {
      await bot.equip(head, 'head')
      changed = true
    }

    if (!preferElytra || !hasElytra) {
      const torso = findBestArmorItem(items, 'torso')
      if (torso && !isWearing(bot, 'torso', (name) => name === getItemName(torso))) {
        await bot.equip(torso, 'torso')
        changed = true
      }
    }

    const legs = findBestArmorItem(items, 'legs')
    if (legs && !isWearing(bot, 'legs', (name) => name === getItemName(legs))) {
      await bot.equip(legs, 'legs')
      changed = true
    }

    const feet = findBestArmorItem(items, 'feet')
    if (feet && !isWearing(bot, 'feet', (name) => name === getItemName(feet))) {
      await bot.equip(feet, 'feet')
      changed = true
    }

    if (changed) {
      safeChat('Switching gear real quick.')
      return true
    }

    return false
  } catch (e) {
    console.log('equip error', e)
    return false
  } finally {
    if (state.getMode() === 'equip') state.setMode('idle')
  }
}

module.exports = {
  equipIfNeeded,
}
