function findAnvil(bot, radius = 20) {
  return bot.findBlock({
    matching: (block) => {
      const n = String(block?.name || '')
      return n === 'anvil' || n === 'chipped_anvil' || n === 'damaged_anvil'
    },
    maxDistance: radius,
  })
}

async function useAnvilIfPossible({ bot, goals, state, stopExploring, searchRadius }) {
  const anvilBlock = findAnvil(bot, searchRadius)
  if (!anvilBlock) return false

  let anvil = null

  try {
    state.setMode('anvil')
    stopExploring()

    bot.pathfinder.setGoal(new goals.GoalNear(anvilBlock.position.x, anvilBlock.position.y, anvilBlock.position.z, 1), false)

    if (typeof bot.openAnvil !== 'function') return false
    anvil = bot.openAnvil(anvilBlock)

    const inv = bot.inventory?.items?.() || []
    if (inv.length >= 1 && typeof anvil.rename === 'function') {
      await anvil.rename(inv[0], `${inv[0].name}_mk2`)
    }

    return true
  } catch (e) {
    console.log('anvil error', e)
    return false
  } finally {
    try {
      anvil?.close?.()
    } catch {}
    if (state.getMode() === 'anvil') state.setMode('idle')
  }
}

module.exports = {
  useAnvilIfPossible,
}
