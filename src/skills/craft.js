function countByName(bot, name) {
  const item = bot.registry?.itemsByName?.[name]
  if (!item) return 0

  return (bot.inventory?.items?.() || [])
    .filter((entry) => entry.type === item.id)
    .reduce((sum, entry) => sum + entry.count, 0)
}

function countByPredicate(bot, predicate) {
  return (bot.inventory?.items?.() || [])
    .filter((entry) => predicate(String(entry.name || '').toLowerCase()))
    .reduce((sum, entry) => sum + entry.count, 0)
}

async function craftItem(bot, itemName, amount, tableBlock) {
  const target = bot.registry?.itemsByName?.[itemName]
  if (!target) return false

  const recipes = bot.recipesFor(target.id, null, amount, tableBlock || null)
  if (!recipes || !recipes.length) return false

  try {
    await bot.craft(recipes[0], amount, tableBlock || null)
    return true
  } catch (e) {
    const message = String(e?.message || e || '').toLowerCase()
    if (message.includes('missing ingredient') || message.includes('missing ingredients')) {
      return false
    }
    throw e
  }
}

async function craftAnyPlanksFromLogs(bot, desiredPlankCount = 4) {
  const items = bot.inventory?.items?.() || []
  const logEntry = items.find((entry) => {
    const name = String(entry?.name || '').toLowerCase()
    return name.endsWith('_log') || name.endsWith('_stem')
  })
  if (!logEntry) return false

  const root = String(logEntry.name || '').replace(/_(log|stem)$/i, '')
  const plankCandidates = [
    `${root}_planks`,
    'oak_planks',
    'spruce_planks',
    'birch_planks',
    'jungle_planks',
    'acacia_planks',
    'dark_oak_planks',
    'mangrove_planks',
    'cherry_planks',
    'bamboo_planks',
    'crimson_planks',
    'warped_planks',
  ]

  for (const plankName of plankCandidates) {
    const crafted = await craftItem(bot, plankName, desiredPlankCount, null)
    if (crafted) return true
  }

  return false
}

async function craftIfNeeded({ bot, goals, state, stopExploring, safeChat, searchRadius, shouldAbort }) {
  const planks = countByPredicate(bot, (name) => name.endsWith('_planks'))
  const sticks = countByName(bot, 'stick')
  const coal = countByName(bot, 'coal') + countByName(bot, 'charcoal')
  const torches = countByName(bot, 'torch')
  const logs = countByPredicate(bot, (name) => name.endsWith('_log') || name.endsWith('_stem'))

  try {
    const abortForDanger = typeof shouldAbort === 'function' ? shouldAbort : () => false

    if (logs > 0 && planks < 16) {
      if (abortForDanger()) return false
      state.setMode('craft')
      stopExploring()
      const crafted = await craftAnyPlanksFromLogs(bot, 1)
      if (crafted) {
        safeChat('Crafting planks.')
        return true
      }
    }

    if (planks >= 2 && sticks < 8) {
      if (abortForDanger()) return false
      state.setMode('craft')
      stopExploring()
      const crafted = await craftItem(bot, 'stick', 1, null)
      if (crafted) {
        safeChat('Making sticks.')
        return true
      }
    }

    if (coal > 0 && sticks > 0 && torches < 16) {
      if (abortForDanger()) return false
      state.setMode('craft')
      stopExploring()
      const crafted = await craftItem(bot, 'torch', 1, null)
      if (crafted) {
        safeChat('Crafting torches.')
        return true
      }
    }

    const craftingTable = bot.findBlock({
      matching: (block) => block?.name === 'crafting_table',
      maxDistance: searchRadius,
    })

    if (!craftingTable) return false

    const cobblestone = countByName(bot, 'cobblestone')
    const furnaceCount = countByName(bot, 'furnace')

    if (cobblestone >= 8 && furnaceCount < 1) {
      if (abortForDanger()) return false
      state.setMode('craft')
      stopExploring()
      bot.pathfinder.setGoal(new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 1), false)
      if (abortForDanger()) return false
      const crafted = await craftItem(bot, 'furnace', 1, craftingTable)
      if (crafted) {
        safeChat('Crafted a furnace.')
        return true
      }
    }

    return false
  } catch (e) {
    console.log('craft error', e)
    return false
  } finally {
    if (state.getMode() === 'craft') state.setMode('idle')
  }
}

module.exports = {
  craftIfNeeded,
}
