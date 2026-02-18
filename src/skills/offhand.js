function pickOffhandCandidate(bot) {
  const items = bot.inventory?.items?.() || []
  const preferred = ['shield', 'totem_of_undying', 'torch', 'golden_apple', 'firework_rocket']

  for (const name of preferred) {
    const found = items.find((item) => String(item?.name || '').toLowerCase() === name)
    if (found) return found
  }

  return items.find((item) => Number(item?.count || 0) > 0) || null
}

async function toggleOffhandIfPossible({ bot, state }) {
  const candidate = pickOffhandCandidate(bot)
  if (!candidate) return false

  try {
    state.setMode('offhand-toggle')
    await bot.equip(candidate, 'off-hand')
    return true
  } catch (e) {
    console.log('offhand toggle error', e)
    return false
  } finally {
    if (state.getMode() === 'offhand-toggle') state.setMode('idle')
  }
}

module.exports = {
  toggleOffhandIfPossible,
}
