const { config } = require('../config')

function normalizeGameMode(raw) {
  if (raw == null) return null

  if (typeof raw === 'object') {
    const candidateKeys = ['gameMode', 'gamemode', 'mode', 'name', 'value']
    for (const key of candidateKeys) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) {
        const nested = normalizeGameMode(raw[key])
        if (nested) return nested
      }
    }

    return null
  }

  if (typeof raw === 'number') {
    const base = raw & 0x03
    if (base === 0) return 'survival'
    if (base === 1) return 'creative'
    if (base === 2) return 'adventure'
    if (base === 3) return 'spectator'
  }

  const text = String(raw).trim().toLowerCase()
  if (!text) return null

  if (text === '0' || text === 'survival') return 'survival'
  if (text === '1' || text === 'creative') return 'creative'
  if (text === '2' || text === 'adventure') return 'adventure'
  if (text === '3' || text === 'spectator') return 'spectator'

  return null
}

function getCurrentGameMode(bot) {
  const candidates = [
    bot?.game?.gameMode,
    bot?.game?.mode,
    bot?.game?.gamemode,
    bot?.player?.gamemode,
  ]

  for (const candidate of candidates) {
    const normalized = normalizeGameMode(candidate)
    if (normalized) return normalized
  }

  return 'survival'
}

function isCreativeMode(bot) {
  return getCurrentGameMode(bot) === 'creative'
}

function getPlayerGameMode(bot, username) {
  const name = String(username || '').trim()
  if (!name) return null
  const player = bot?.players?.[name]
  if (!player) return null

  const candidates = [
    player?.gamemode,
    player?.gameMode,
    player?.mode,
    player?.entity?.gamemode,
    player?.entity?.gameMode,
    player?.entity?.mode,
  ]

  for (const candidate of candidates) {
    const normalized = normalizeGameMode(candidate)
    if (normalized) return normalized
  }

  return null
}

function isCreativePlayer(bot, username) {
  return getPlayerGameMode(bot, username) === 'creative'
}

function isFlightAllowedMode(bot) {
  const mode = getCurrentGameMode(bot)
  if (mode === 'spectator') return true
  if (mode === 'creative') return Boolean(config.allowCreativeFlight)
  return false
}

function enforceNoCreativeFlight(bot) {
  if (!bot || isFlightAllowedMode(bot)) return false

  try {
    bot.setControlState?.('jump', false)
    bot.setControlState?.('sprint', false)
  } catch {}

  return true
}

module.exports = {
  normalizeGameMode,
  getCurrentGameMode,
  getPlayerGameMode,
  isCreativePlayer,
  isCreativeMode,
  isFlightAllowedMode,
  enforceNoCreativeFlight,
}
