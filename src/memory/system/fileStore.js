const fs = require('fs')
const path = require('path')

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf8')
    if (!raw.trim()) return null
    return JSON.parse(raw)
  } catch (e) {
    console.log('session memory read error', e)
    return null
  }
}

function safeWriteJson(filePath, data) {
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
  } catch (e) {
    console.log('session memory write error', e)
  }
}

function createJsonMemoryStore(filePath) {
  const resolvedPath = path.resolve(filePath)

  function load() {
    return safeReadJson(resolvedPath)
  }

  function save(data) {
    safeWriteJson(resolvedPath, data)
  }

  return {
    resolvedPath,
    load,
    save,
  }
}

module.exports = {
  createJsonMemoryStore,
}
