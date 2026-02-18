async function fetchJsonWithTimeout(url, timeoutMs = 1200) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function detectLocalLlm() {
  const ollamaTags = await fetchJsonWithTimeout('http://127.0.0.1:11434/api/tags')
  if (ollamaTags?.models?.length) {
    return {
      detected: true,
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      models: ollamaTags.models.map((m) => m.name).slice(0, 8),
    }
  }

  const lmStudioModels = await fetchJsonWithTimeout('http://127.0.0.1:1234/v1/models')
  if (lmStudioModels?.data?.length) {
    return {
      detected: true,
      provider: 'lmstudio',
      endpoint: 'http://127.0.0.1:1234',
      models: lmStudioModels.data.map((m) => m.id).slice(0, 8),
    }
  }

  return {
    detected: false,
    provider: null,
    endpoint: null,
    models: [],
  }
}

module.exports = {
  detectLocalLlm,
}
