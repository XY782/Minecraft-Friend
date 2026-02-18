function round(value, digits = 3) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  const factor = Math.pow(10, digits)
  return Math.round(n * factor) / factor
}

function safeString(value) {
  return String(value == null ? '' : value).trim()
}

function safeNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : Number(fallback)
}

function angularDistance(a, b) {
  const tau = Math.PI * 2
  let delta = Math.abs(Number(a || 0) - Number(b || 0))
  if (delta > tau) {
    delta = delta % tau
  }
  return Math.min(delta, tau - delta)
}

function sanitizeGroundFlags(onGround, inAir, vy) {
  const verticalSpeed = Number(vy || 0)
  let correctedOnGround = Boolean(onGround)
  let correctedInAir = Boolean(inAir)

  if (correctedOnGround && verticalSpeed > 0.35) {
    correctedOnGround = false
    correctedInAir = true
  }

  if (correctedOnGround) {
    correctedInAir = false
  }

  if (!correctedOnGround && !correctedInAir) {
    correctedInAir = true
  }

  return {
    onGround: correctedOnGround,
    inAir: correctedInAir,
  }
}

module.exports = {
  round,
  safeString,
  safeNumber,
  angularDistance,
  sanitizeGroundFlags,
}
