function findEnchantableItem(bot) {
  const items = bot.inventory?.items?.() || []
  const priorities = ['sword', 'pickaxe', 'axe', 'shovel', 'bow', 'helmet', 'chestplate', 'leggings', 'boots', 'elytra']

  for (const key of priorities) {
    const item = items.find((entry) => String(entry.name || '').toLowerCase().includes(key))
    if (item) return item
  }

  return null
}

function findLapis(bot) {
  const items = bot.inventory?.items?.() || []
  return items.find((entry) => String(entry.name || '').toLowerCase() === 'lapis_lazuli') || null
}

function findEnchantingTable(bot, searchRadius) {
  return bot.findBlock({
    matching: (block) => String(block?.name || '') === 'enchanting_table',
    maxDistance: searchRadius,
  })
}

async function enchantIfPossible({ bot, goals, state, stopExploring, safeChat, searchRadius }) {
  const targetItem = findEnchantableItem(bot)
  const lapis = findLapis(bot)
  const tableBlock = findEnchantingTable(bot, searchRadius)

  if (!targetItem || !lapis || !tableBlock) return false

  let table = null

  try {
    state.setMode('enchant')
    stopExploring()

    bot.pathfinder.setGoal(new goals.GoalNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 1), false)

    table = bot.openEnchantmentTable(tableBlock)
    await bot.equip(targetItem, 'hand')

    const options = table?.enchantments || []
    if (!options.length) return false

    const bestIndex = options.reduce((best, option, index, arr) => {
      const bestPower = Number(arr[best]?.level || 0)
      const thisPower = Number(option?.level || 0)
      return thisPower > bestPower ? index : best
    }, 0)

    await table.enchant(bestIndex)
    safeChat(`Enchanted ${targetItem.name}.`)
    return true
  } catch (e) {
    console.log('enchant error', e)
    return false
  } finally {
    try {
      table?.close?.()
    } catch {}
    if (state.getMode() === 'enchant') state.setMode('idle')
  }
}

module.exports = {
  enchantIfPossible,
}
