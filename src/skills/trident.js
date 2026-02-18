function findTrident(bot) {
  const items = bot.inventory?.items?.() || []
  return items.find((item) => String(item.name || '').toLowerCase() === 'trident') || null
}

async function useTridentIfPossible({ bot, state, stopExploring }) {
  const trident = findTrident(bot)
  if (!trident) return false

  try {
    state.setMode('trident')
    stopExploring()

    await bot.equip(trident, 'hand')

    const hostile = Object.values(bot.entities || {}).find((entity) =>
      entity && entity.type === 'mob' && bot.entity && bot.entity.position.distanceTo(entity.position) < 20
    )

    if (!hostile) return false

    await bot.lookAt(hostile.position.offset(0, 1.2, 0), true)
    await bot.activateItem()
    return true
  } catch (e) {
    console.log('trident error', e)
    return false
  } finally {
    try {
      bot.deactivateItem()
    } catch {}
    if (state.getMode() === 'trident') state.setMode('idle')
  }
}

module.exports = {
  useTridentIfPossible,
}
