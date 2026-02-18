function isEdible(bot, item) {
  const name = String(item?.name || '').toLowerCase()
  if (!name) return false
  if (bot?.registry?.foodsByName?.[name]) return true

  return name.includes('bread') || name.includes('cooked') || name.includes('beef') || name.includes('pork') ||
    name.includes('mutton') || name.includes('chicken') || name.includes('carrot') || name.includes('potato') ||
    name.includes('apple') || name.includes('melon') || name.includes('berries') || name.includes('cookie') ||
    name.includes('pumpkin_pie') || name.includes('golden_carrot')
}

function findFoodItem(bot) {
  const items = bot.inventory?.items?.() || []
  return items.find((item) => isEdible(bot, item))
}

function findNamedFoodItem(bot, foodName) {
  const wanted = String(foodName || '').toLowerCase().trim()
  if (!wanted) return null
  const items = bot.inventory?.items?.() || []
  return items.find((item) => {
    const name = String(item?.name || '').toLowerCase()
    if (!name) return false
    if (!isEdible(bot, item)) return false
    return name === wanted || name.includes(wanted)
  }) || null
}

async function consumeFoodItem(bot, foodItem) {
  if (!foodItem || !isEdible(bot, foodItem)) return false

  await bot.equip(foodItem, 'hand')

  const held = bot.heldItem
  if (!isEdible(bot, held)) return false

  await bot.consume()
  return true
}

async function eatIfNeeded({ bot, lowFoodThreshold, state, stopExploring, safeChat, chance }) {
  if (typeof bot.food !== 'number') return false
  if (bot.food > lowFoodThreshold) return false

  const foodItem = findFoodItem(bot)
  if (!foodItem) return false

  try {
    state.setMode('eat')
    stopExploring()
    const ate = await consumeFoodItem(bot, foodItem)
    if (!ate) return false
    if (chance(0.35)) safeChat('Need to keep my hunger up.')
    return true
  } catch (e) {
    console.log('eat error', e)
    return false
  } finally {
    if (state.getMode() === 'eat') state.setMode('idle')
  }
}

async function eatNamedFood({ bot, foodName }) {
  const item = findNamedFoodItem(bot, foodName)
  if (!item) return false

  try {
    return await consumeFoodItem(bot, item)
  } catch {
    return false
  }
}

module.exports = {
  eatIfNeeded,
  eatNamedFood,
}
