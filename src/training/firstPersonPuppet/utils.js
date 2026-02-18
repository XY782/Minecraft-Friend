const { spawn } = require('child_process')

let createViewer = null

function tryLoadViewerModule() {
  if (createViewer) return createViewer
  try {
    const viewerPkg = require('prismarine-viewer')
    createViewer = viewerPkg?.mineflayer || null
    return createViewer
  } catch (error) {
    return null
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function openControlWindow(url, autoOpen) {
  if (!autoOpen) return
  try {
    spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
    }).unref()
  } catch {}
}

module.exports = {
  tryLoadViewerModule,
  clamp,
  openControlWindow,
}
