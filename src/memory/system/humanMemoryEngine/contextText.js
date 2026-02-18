function formatDecayedContext(memories = []) {
  if (!memories.length) return ''

  return memories
    .map((m) => `[s${m.sessionIndex + 1} decay=${m.decay.toFixed(2)} imp=${Number(m.importance || 0).toFixed(2)} emo=${m.emotion}] ${m.type}: ${m.text}`)
    .join('\n')
}

function formatRelevantContext(memories = []) {
  if (!memories.length) return ''

  return memories
    .map((m) => `[score=${m.score.toFixed(3)} s${m.sessionIndex + 1} d=${m.decay.toFixed(2)} imp=${Number(m.importance || 0).toFixed(2)} emo=${m.emotion}] ${m.type}: ${m.text}`)
    .join('\n')
}

module.exports = {
  formatDecayedContext,
  formatRelevantContext,
}
