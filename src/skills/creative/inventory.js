const { creativeSetState } = require('./state')

function desiredCreativeItems(bot) {
  const itemsByName = bot.registry?.itemsByName || {}
  const preferred = [
    'stone_bricks',
    'oak_planks',
    'glass',
    'scaffolding',
    'torch',
    'ladder',
    'water_bucket',
    'bread',
    'cooked_beef',
    'iron_sword',
    'shield',
    'bow',
    'arrow',
    'iron_pickaxe',
    'iron_axe',
    'cobblestone',
  ]

  return preferred.filter((name) => Boolean(itemsByName[name]))
}

function inventoryNamesSet(bot) {
  return new Set((bot.inventory?.items?.() || []).map((item) => String(item.name || '').toLowerCase()))
}

function hotbarItems(bot) {
  const slots = bot.inventory?.slots || []
  const items = []
  for (let slot = 36; slot <= 44; slot++) {
    const item = slots[slot]
    if (item) items.push({ slot, item })
  }
  return items
}

function slotItemScore(name, desiredSet) {
  const n = String(name || '').toLowerCase()
  if (desiredSet.has(n)) return 100
  if (n.includes('sword') || n.includes('pickaxe') || n.includes('axe') || n === 'shield') return 60
  if (n.endsWith('_planks') || n.includes('stone') || n === 'scaffolding') return 45
  if (n === 'torch' || n === 'ladder' || n === 'water_bucket') return 40
  if (n.includes('spawn_egg') || n.startsWith('debug_')) return -10
  return 5
}

function pickLeastUsefulHotbarSlot(bot, desiredSet) {
  const entries = hotbarItems(bot)
  if (!entries.length) return null

  let worst = null
  for (const entry of entries) {
    const score = slotItemScore(entry.item?.name, desiredSet)
    if (!worst || score < worst.score) {
      worst = { slot: entry.slot, score }
    }
  }
  return worst?.slot ?? null
}

function pickHotbarSlot(bot) {
  const hotbarStart = 36
  const hotbarEnd = 44
  const slots = bot.inventory?.slots || []
  const now = Date.now()
  let cursor = Math.max(hotbarStart, Math.min(hotbarEnd, creativeSetState.nextSlot || hotbarStart))

  for (let i = 0; i <= (hotbarEnd - hotbarStart); i++) {
    const slot = cursor
    cursor = cursor >= hotbarEnd ? hotbarStart : cursor + 1
    const cooldownUntil = creativeSetState.slotCooldownUntil.get(slot) || 0
    if (now < cooldownUntil) continue
    if (!slots[slot]) {
      creativeSetState.nextSlot = cursor
      return slot
    }
  }

  for (let i = 0; i <= (hotbarEnd - hotbarStart); i++) {
    const slot = cursor
    cursor = cursor >= hotbarEnd ? hotbarStart : cursor + 1
    const cooldownUntil = creativeSetState.slotCooldownUntil.get(slot) || 0
    if (now < cooldownUntil) continue

    creativeSetState.nextSlot = cursor
    return slot
  }

  const fallback = Math.max(hotbarStart, Math.min(hotbarEnd, creativeSetState.nextSlot || hotbarStart))
  creativeSetState.nextSlot = fallback >= hotbarEnd ? hotbarStart : fallback + 1
  return fallback
}

function chooseMissingDesiredItem(bot) {
  const desired = desiredCreativeItems(bot)
  const have = inventoryNamesSet(bot)
  return desired.find((name) => !have.has(name)) || null
}

module.exports = {
  desiredCreativeItems,
  pickHotbarSlot,
  pickLeastUsefulHotbarSlot,
  chooseMissingDesiredItem,
}
