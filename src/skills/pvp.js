let lastPlayerAttackAt = 0
const { isCreativePlayer } = require('../utils/gamemode')

const chaseState = {
  target: '',
  startedAt: 0,
}

function hasThreateningItem(entity) {
  const heldName = String(entity?.heldItem?.name || '').toLowerCase()
  return heldName.includes('sword') || heldName.includes('axe') || heldName === 'trident' || heldName.includes('bow')
}

function nearestPlayerTarget({ bot, getNearbyPlayers, maxDistance, preferredUsername = null }) {
  const preferred = String(preferredUsername || '').trim()
  if (preferred) {
    const preferredPlayer = bot?.players?.[preferred]?.entity
    if (preferredPlayer && preferredPlayer.username !== bot.username && !isCreativePlayer(bot, preferredPlayer.username)) return preferredPlayer
  }

  const nearby = getNearbyPlayers(bot, maxDistance)
  if (!nearby.length) return null

  if (preferred) {
    const direct = nearby.find(({ entity }) => entity?.username === preferred)
    if (direct?.entity) return direct.entity
  }

  const candidates = nearby
    .map(({ entity, distance }) => ({ entity, distance }))
    .filter(({ entity }) => entity?.username && entity.username !== bot.username)
    .filter(({ entity }) => !isCreativePlayer(bot, entity.username))
    .map(({ entity, distance }) => {
      const threatening = hasThreateningItem(entity)
      const score = (threatening ? 2.1 : 0.8) - (distance * 0.07)
      return { entity, score }
    })
    .sort((a, b) => b.score - a.score)

  return candidates[0]?.entity || null
}

async function attackNearbyPlayer({
  bot,
  goals,
  state,
  stopExploring,
  safeChat,
  player,
  attackDistance,
  keepMoving = false,
}) {
  if (!player || !bot.entity) return false
  if (isCreativePlayer(bot, player.username)) return false

  try {
    state.setMode('attack-player')
    if (!keepMoving) stopExploring()
    bot.setControlState('sprint', true)

    const distance = bot.entity.position.distanceTo(player.position)
    if (distance > attackDistance + 1.2) {
      const targetName = String(player.username || '')
      if (chaseState.target !== targetName) {
        chaseState.target = targetName
        chaseState.startedAt = Date.now()
      }

      const chasingTooLong = (Date.now() - Number(chaseState.startedAt || 0)) > 5_000
      const targetCreative = isCreativePlayer(bot, targetName)
      if (chasingTooLong || targetCreative) {
        bot.pathfinder.setGoal(null)
        return false
      }

      bot.pathfinder.setGoal(new goals.GoalFollow(player, 1.8), true)
      return true
    }

    chaseState.target = String(player.username || '')
    chaseState.startedAt = Date.now()

    if (distance < Math.max(1.3, attackDistance - 1.0)) {
      const awayX = bot.entity.position.x + (bot.entity.position.x - player.position.x) * 1.25
      const awayZ = bot.entity.position.z + (bot.entity.position.z - player.position.z) * 1.25
      bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(awayX), Math.floor(bot.entity.position.y), Math.floor(awayZ), 1), false)
      return true
    }

    const now = Date.now()
    if (now - lastPlayerAttackAt < 600) return true

    const strafeLeft = Math.random() < 0.5
    bot.setControlState(strafeLeft ? 'left' : 'right', true)
    setTimeout(() => {
      try {
        bot.setControlState('left', false)
        bot.setControlState('right', false)
      } catch {}
    }, 220)

    await bot.lookAt(player.position.offset(0, 1.4, 0), true)
    await bot.attack(player)
    lastPlayerAttackAt = now
    safeChat(`Careful, ${player.username}.`)
    return true
  } catch (e) {
    console.log('attack player error', e)
    return false
  } finally {
    chaseState.target = ''
    chaseState.startedAt = 0
    try {
      if (!keepMoving) bot.setControlState('sprint', false)
      bot.setControlState('left', false)
      bot.setControlState('right', false)
    } catch {}
    if (state.getMode() === 'attack-player') state.setMode('idle')
  }
}

module.exports = {
  nearestPlayerTarget,
  attackNearbyPlayer,
}
