const fs = require('fs')
const path = require('path')

const projectRoot = path.join(__dirname, '..', '..')
const datasetDir = path.join(projectRoot, 'Training', 'datasets')

function listDatasetFiles() {
  try {
    return fs.readdirSync(datasetDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
  } catch {
    return []
  }
}

function getLatestDatasetFile() {
  const files = listDatasetFiles()
  const latest = files[files.length - 1]
  return latest ? path.join(datasetDir, latest) : null
}

function readNewLines(filePath, cursor) {
  if (!filePath || !fs.existsSync(filePath)) return { nextCursor: 0, lines: [] }
  const stats = fs.statSync(filePath)
  if (stats.size <= cursor) return { nextCursor: stats.size, lines: [] }

  const fd = fs.openSync(filePath, 'r')
  try {
    const size = stats.size - cursor
    const buffer = Buffer.alloc(size)
    fs.readSync(fd, buffer, 0, size, cursor)
    const text = buffer.toString('utf8')
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    return { nextCursor: stats.size, lines }
  } finally {
    fs.closeSync(fd)
  }
}

console.log('[TRAINING MONITOR] waiting for dataset at Training/datasets/*.jsonl')

let currentFile = null
let cursor = 0

setInterval(() => {
  const latest = getLatestDatasetFile()
  if (!latest) return

  if (latest !== currentFile) {
    currentFile = latest
    cursor = 0
    console.log(`[TRAINING MONITOR] following: ${path.basename(currentFile)}`)
  }

  const { nextCursor, lines } = readNewLines(currentFile, cursor)
  cursor = nextCursor
  for (const line of lines.slice(-8)) {
    try {
      const entry = JSON.parse(line)
      const pos = entry?.state?.position || {}
      const action = entry?.action || {}
      const intent = entry?.state?.activeIntent || 'none'
      const success = action.success == null ? 'n/a' : (action.success ? 'ok' : 'fail')
      console.log(`[TRAIN] ${entry.timestamp} | ${action.label} (${success}) | ${pos.x},${pos.y},${pos.z} | intent=${intent}`)
    } catch {
      console.log(`[TRAIN RAW] ${line}`)
    }
  }
}, 1000)
