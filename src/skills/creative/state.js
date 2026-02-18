const creativeSetState = {
  inFlight: false,
  lastAttemptAt: 0,
  backoffUntil: 0,
  nextSlot: 36,
  slotCooldownUntil: new Map(),
  lastErrorLogAt: 0,
  consecutiveFailures: 0,
  disableSetSlotUntil: 0,
  lastDisableLogAt: 0,
}

function shouldLogCreativeError() {
  const now = Date.now()
  if (now - creativeSetState.lastErrorLogAt < 15_000) return false
  creativeSetState.lastErrorLogAt = now
  return true
}

function shouldLogSetSlotDisabled() {
  const now = Date.now()
  if (now - creativeSetState.lastDisableLogAt < 60_000) return false
  creativeSetState.lastDisableLogAt = now
  return true
}

module.exports = {
  creativeSetState,
  shouldLogCreativeError,
  shouldLogSetSlotDisabled,
}
