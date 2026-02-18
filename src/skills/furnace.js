const RAW_FOOD_NAMES = new Set([
  'beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'kelp'
])

const FUEL_NAMES = new Set([
  'coal', 'charcoal', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
  'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
  'crimson_planks', 'warped_planks', 'stick'
])

function pickInventoryItem(bot, predicate) {
  return (bot.inventory?.items?.() || []).find((item) => predicate(String(item.name || '').toLowerCase()))
}

function findFurnaceBlock(bot, searchRadius) {
  return bot.findBlock({
    matching: (block) => {
      const name = String(block?.name || '')
      return name === 'furnace' || name === 'smoker' || name === 'blast_furnace'
    },
    maxDistance: searchRadius,
  })
}

async function useFurnaceIfNeeded({ bot, goals, state, stopExploring, safeChat, searchRadius }) {
  const rawFood = pickInventoryItem(bot, (name) => RAW_FOOD_NAMES.has(name))
  if (!rawFood) return false

  const fuel = pickInventoryItem(bot, (name) => FUEL_NAMES.has(name) || name.endsWith('_planks') || name.endsWith('_log'))
  if (!fuel) return false

  const furnaceBlock = findFurnaceBlock(bot, searchRadius)
  if (!furnaceBlock) return false

  let furnace = null

  try {
    state.setMode('furnace')
    stopExploring()
    bot.pathfinder.setGoal(new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 1), false)

    furnace = await bot.openFurnace(furnaceBlock)

    if (furnace.outputItem()) {
      await furnace.takeOutput()
      safeChat('Collected cooked food.')
      return true
    }

    if (!furnace.inputItem()) {
      await furnace.putInput(rawFood.type, null, 1)
    }

    if (!furnace.fuelItem()) {
      await furnace.putFuel(fuel.type, null, 1)
    }

    safeChat('Started smelting food.')
    return true
  } catch (e) {
    console.log('furnace error', e)
    return false
  } finally {
    if (furnace) {
      try {
        furnace.close()
      } catch {}
    }
    if (state.getMode() === 'furnace') state.setMode('idle')
  }
}

module.exports = {
  useFurnaceIfNeeded,
}
