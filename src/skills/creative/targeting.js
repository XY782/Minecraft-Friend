const { desiredCreativeItems, chooseMissingDesiredItem } = require('./inventory')

function tokenCandidates(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_:\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^minecraft:/, '').trim())
    .filter(Boolean)
}

function resolveItemName(bot, text) {
  const itemsByName = bot.registry?.itemsByName || {}
  const blocksByName = bot.registry?.blocksByName || {}

  for (const token of tokenCandidates(text)) {
    if (itemsByName[token]) return token
    if (blocksByName[token] && itemsByName[token]) return token
  }

  return null
}

async function chooseCreativeTarget({ bot, gemini, getProfileContext, sessionMemory }) {
  const buildKit = ['stone_bricks', 'oak_planks', 'glass', 'scaffolding', 'torch', 'ladder']
  const inventoryNames = new Set((bot.inventory?.items?.() || []).map((item) => String(item.name || '').toLowerCase()))
  const buildBlocksOwned = [...inventoryNames].filter((name) =>
    name.endsWith('_planks') || name.includes('stone') || name.includes('brick') || name === 'scaffolding'
  ).length

  const missingDesired = chooseMissingDesiredItem(bot)
  if (missingDesired) return missingDesired

  if (buildBlocksOwned < 3) {
    const preferred = buildKit.find((name) => bot.registry?.itemsByName?.[name] && !inventoryNames.has(name))
    if (preferred) return preferred
  }

  if (!gemini?.generateCreativeTarget) return null

  try {
    const profileContext = getProfileContext?.() || ''
    const sessionContext = sessionMemory?.getRelevantContextText?.({
      query: 'creative inventory target selection',
      contextText: profileContext,
      tags: ['creative', 'inventory'],
      perSession: 8,
      limit: 10,
    }) || sessionMemory?.getDecayedContextText?.({ perSession: 5 }) || ''

    const text = await gemini.generateCreativeTarget({
      botName: bot.username,
      profileContext,
      sessionContext,
    })

    return resolveItemName(bot, text)
  } catch (e) {
    console.log('creative target selection error', e)
  }

  const desired = new Set(desiredCreativeItems(bot))
  const candidates = Object.keys(bot.registry?.itemsByName || {})
    .filter((name) => !inventoryNames.has(name))
    .filter((name) => desired.has(name) || (name && !name.startsWith('debug_') && !name.includes('spawn_egg')))

  if (!candidates.length) return null
  return candidates[Math.floor(Math.random() * candidates.length)]
}

module.exports = {
  chooseCreativeTarget,
}
