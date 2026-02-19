function isResourceLike(name) {
  const n = String(name || '').toLowerCase()
  if (!n || n === 'air' || n === 'bedrock') return false
  if (n.includes('ore')) return true
  if (n.includes('log') || n.includes('leaves')) return true
  if (n.includes('stone') || n.includes('deepslate')) return true
  if (n === 'dirt' || n === 'grass_block' || n === 'gravel' || n === 'sand' || n === 'clay') return true
  if (n.includes('netherrack') || n.includes('basalt') || n.includes('blackstone')) return true
  return false
}

function isInFrontOfBot(bot, block) {
  if (!bot?.entity?.position || !block?.position) return false
  const eyeY = Number(bot.entity.height || 1.62)
  const eye = bot.entity.position.offset(0, eyeY, 0)
  const center = block.position.offset(0.5, 0.5, 0.5)
  const toBlock = center.minus(eye)
  const len = Math.sqrt((toBlock.x ** 2) + (toBlock.y ** 2) + (toBlock.z ** 2))
  if (!Number.isFinite(len) || len <= 0.0001) return false

  const forwardX = -Math.sin(Number(bot.entity.yaw || 0))
  const forwardZ = -Math.cos(Number(bot.entity.yaw || 0))
  const dirX = toBlock.x / len
  const dirZ = toBlock.z / len
  const dot = (forwardX * dirX) + (forwardZ * dirZ)
  return dot >= 0.2
}

function isVisibleToBot(bot, block) {
  try {
    if (typeof bot?.canSeeBlock === 'function') {
      return Boolean(bot.canSeeBlock(block))
    }
  } catch {}
  return true
}

function findBreakableBlock(bot, maxDistance = 5) {
  if (!bot.entity) return null
  const origin = bot.entity.position.floored()
  let best = null
  let bestScore = Number.POSITIVE_INFINITY

  for (let y = -1; y <= 2; y++) {
    for (let x = -maxDistance; x <= maxDistance; x++) {
      for (let z = -maxDistance; z <= maxDistance; z++) {
        const block = bot.blockAt(origin.offset(x, y, z))
        if (!block || !isResourceLike(block.name)) continue
        if (typeof block.diggable === 'boolean' && !block.diggable) continue

        const distance = bot.entity.position.distanceTo(block.position)
        if (distance > maxDistance || distance < 1.1) continue

        if (block.position.y <= origin.y - 1) continue
        const inFront = isInFrontOfBot(bot, block)
        const visible = isVisibleToBot(bot, block)
        const score = distance + (inFront ? 0 : 0.9) + (visible ? 0 : 0.6)

        if (score < bestScore) {
          bestScore = score
          best = block
        }
      }
    }
  }

  return best
}

async function breakIfWanted({ bot, state, stopExploring, keepMoving = false }) {
  const block = findBreakableBlock(bot, 4)
  if (!block) return false

  try {
    state.setMode('break')
    if (!keepMoving) stopExploring()
    await bot.dig(block)
    return true
  } catch (e) {
    console.log('break error', e)
    return false
  } finally {
    if (state.getMode() === 'break') state.setMode('idle')
  }
}

module.exports = {
  breakIfWanted,
}
