const fs = require('fs')
const path = require('path')

function parseLatestJsonPayload(content) {
  const text = String(content || '').trim()
  if (!text) return null

  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {}

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    try {
      const parsed = JSON.parse(lines[idx])
      if (parsed && typeof parsed === 'object') return parsed
    } catch {}
  }

  return null
}

function createUserTelemetryReader({ filePath = '', maxAgeMs = 2000, liveConsole = false } = {}) {
  const telemetryPath = String(filePath || '').trim()
  if (!telemetryPath) {
    return {
      getLatestSnapshot: () => null,
      isEnabled: () => false,
    }
  }

  try {
    const dir = path.dirname(telemetryPath)
    if (dir && dir !== '.') {
      fs.mkdirSync(dir, { recursive: true })
    }
    if (!fs.existsSync(telemetryPath)) {
      fs.writeFileSync(telemetryPath, '{}\n', 'utf8')
    }
  } catch {}

  let lastMtimeMs = -1
  let cached = null
  let lastWarnAt = 0

  function maybeWarn(message) {
    if (!liveConsole) return
    const now = Date.now()
    if (now - lastWarnAt < 10_000) return
    lastWarnAt = now
    console.log(`[TRAINING] user telemetry warning: ${message}`)
  }

  function readSnapshot() {
    let stat = null
    try {
      stat = fs.statSync(telemetryPath)
    } catch {
      maybeWarn(`file not found at ${telemetryPath}`)
      return null
    }

    if (!stat?.mtimeMs) return cached

    if (stat.mtimeMs !== lastMtimeMs) {
      try {
        const content = fs.readFileSync(telemetryPath, 'utf8')
        const parsed = parseLatestJsonPayload(content)
        if (parsed) {
          cached = parsed
          lastMtimeMs = stat.mtimeMs
        }
      } catch {
        maybeWarn(`failed to read ${telemetryPath}`)
      }
    }

    if (!cached) return null

    const state = cached?.state && typeof cached.state === 'object' ? cached.state : null
    const hasPosition = Boolean(state?.position && typeof state.position === 'object')
    if (!state || !hasPosition) {
      maybeWarn(`invalid payload in ${telemetryPath}; expected state.position`)
      return null
    }

    const ts = Number(cached?.timestampMs || cached?.timestamp || 0)
    if (Number.isFinite(ts) && ts > 0) {
      const age = Date.now() - ts
      if (age > Math.max(250, Number(maxAgeMs || 2000))) {
        maybeWarn(`stale telemetry at ${telemetryPath} (age=${Math.round(age)}ms)`)
        return null
      }
    }

    return cached
  }

  return {
    getLatestSnapshot: readSnapshot,
    isEnabled: () => true,
  }
}

module.exports = {
  createUserTelemetryReader,
}
