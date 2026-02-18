function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function createAntiRepeatMemory({ enabled = true, windowSize = 8 } = {}) {
  const recent = []

  function hints(max = 5) {
    return recent.slice(-max)
  }

  function seen(text) {
    if (!enabled) return false
    const n = normalize(text)
    if (!n) return false
    return recent.includes(n)
  }

  function register(text) {
    const n = normalize(text)
    if (!n) return
    recent.push(n)
    while (recent.length > windowSize) recent.shift()
  }

  return {
    seen,
    hints,
    register,
  }
}

module.exports = {
  createAntiRepeatMemory,
}
