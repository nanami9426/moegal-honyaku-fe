const API_BASE = "http://127.0.0.1:8000"
const DEFAULT_OPTIONS = {
  translate_api_type: ["openai", "dashscope"],
  translate_mode: ["parallel", "structured"],
}

const PROVIDER_LABEL = {
  openai: "OpenAI",
  dashscope: "DashScope",
}

const MODE_LABEL = {
  parallel: "parallel",
  structured: "structured",
}

const MODE_DESC = {
  parallel: "parallel：速度更稳定，逐句并发请求，适合长文本分段翻译。",
  structured: "structured：一次请求完成整组翻译，适合需要统一上下文的场景。",
}

const state = {
  options: { ...DEFAULT_OPTIONS },
  current: {
    translate_api_type: "openai",
    translate_mode: "parallel",
  },
  hydrating: false,
}

const view = {
  providerSelect: null,
  modeSelect: null,
  currentEngine: null,
  currentMode: null,
  modeTip: null,
  errorTip: null,
  syncStatus: null,
  lastSync: null,
  reloadButton: null,
}

function now() {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date())
}

function providerLabel(value) {
  return PROVIDER_LABEL[value] || value
}

function modeLabel(value) {
  return MODE_LABEL[value] || value
}

function modeTip(value) {
  return MODE_DESC[value] || "可选择并行或结构化翻译模式。"
}

function setStatus(text, className) {
  view.syncStatus.textContent = text
  view.syncStatus.className = `status ${className}`
}

function setError(text) {
  const message = typeof text === "string" ? text.trim() : ""
  view.errorTip.textContent = message
  view.errorTip.hidden = !message
}

function setLoading(loading, loadingText) {
  view.providerSelect.disabled = loading
  view.modeSelect.disabled = loading
  view.reloadButton.disabled = loading
  view.reloadButton.textContent = loading ? loadingText : "重新拉取配置"
}

function errorMessage(response, payload) {
  if (payload && typeof payload === "object") {
    const raw = payload.detail || payload.info || payload.message || payload.error
    if (typeof raw === "string" && raw.trim()) return raw.trim()
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim()
  }
  return `请求失败 (${response.status})`
}

async function requestJSON(path, options) {
  const response = await fetch(`${API_BASE}${path}`, options)
  let payload = null
  try {
    payload = await response.json()
  } catch (error) {
    payload = null
  }
  if (!response.ok) {
    throw new Error(errorMessage(response, payload))
  }
  return payload || {}
}

async function initConf() {
  return requestJSON("/conf/init", { method: "POST" })
}

async function fetchOptions() {
  return requestJSON("/conf/options", { method: "GET" })
}

async function queryConf() {
  return requestJSON("/conf/query", { method: "GET" })
}

async function updateConf(attr, value) {
  return requestJSON("/conf/update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      attr: attr,
      v: value,
    }),
  })
}

function cleanValues(values) {
  if (!Array.isArray(values)) return []
  return values.filter((item) => typeof item === "string" && item.trim().length > 0)
}

function normalizeOptions(payload) {
  const providerOptions = cleanValues(payload?.translate_api_type)
  const modeOptions = cleanValues(payload?.translate_mode)
  return {
    translate_api_type: providerOptions.length > 0 ? providerOptions : [...DEFAULT_OPTIONS.translate_api_type],
    translate_mode: modeOptions.length > 0 ? modeOptions : [...DEFAULT_OPTIONS.translate_mode],
  }
}

function renderSelect(select, values, labeler) {
  select.innerHTML = ""
  values.forEach((value) => {
    const option = document.createElement("option")
    option.value = value
    option.textContent = labeler(value)
    select.appendChild(option)
  })
}

function ensureOption(select, value, text) {
  if (typeof value !== "string" || !value) return
  const exists = Array.from(select.options).some((option) => option.value === value)
  if (exists) return
  const option = document.createElement("option")
  option.value = value
  option.textContent = `${text}（后端）`
  select.appendChild(option)
}

function renderCurrent() {
  view.currentEngine.textContent = providerLabel(state.current.translate_api_type)
  view.currentMode.textContent = modeLabel(state.current.translate_mode)
  view.modeTip.textContent = modeTip(state.current.translate_mode)
}

function applyConfig(conf) {
  const nextProvider = typeof conf?.translate_api_type === "string" ? conf.translate_api_type : "openai"
  const nextMode = typeof conf?.translate_mode === "string" ? conf.translate_mode : "parallel"

  state.current.translate_api_type = nextProvider
  state.current.translate_mode = nextMode

  ensureOption(view.providerSelect, nextProvider, providerLabel(nextProvider))
  ensureOption(view.modeSelect, nextMode, modeLabel(nextMode))

  view.providerSelect.value = nextProvider
  view.modeSelect.value = nextMode
  renderCurrent()
}

async function syncConfig(needInit) {
  setLoading(true, "同步中...")
  setStatus("同步中", "is-loading")
  setError("")
  try {
    if (needInit) {
      await initConf()
    }
    state.options = normalizeOptions(await fetchOptions())

    state.hydrating = true
    renderSelect(view.providerSelect, state.options.translate_api_type, providerLabel)
    renderSelect(view.modeSelect, state.options.translate_mode, modeLabel)
    applyConfig(await queryConf())
    state.hydrating = false

    view.lastSync.textContent = now()
    setStatus("已同步", "is-ok")
  } catch (error) {
    state.hydrating = false
    console.error("配置同步失败:", error)
    setStatus("同步失败", "is-error")
    setError(error.message)
  } finally {
    setLoading(false, "")
  }
}

function withStructuredSuggestion(message) {
  const text = typeof message === "string" ? message : "更新失败"
  if (/structured|格式|数量|列表|list/i.test(text)) {
    return `${text}。请重试或切换并行模式。`
  }
  return text
}

async function onConfigChange(attr, value) {
  if (state.hydrating) return

  const oldValue = state.current[attr]
  if (oldValue === value) return

  setLoading(true, "保存中...")
  setStatus("保存中", "is-loading")
  setError("")

  try {
    await updateConf(attr, value)
    state.current[attr] = value
    renderCurrent()
    view.lastSync.textContent = now()
    setStatus("保存成功", "is-ok")
  } catch (error) {
    console.error("配置更新失败:", error)
    if (attr === "translate_api_type") {
      view.providerSelect.value = oldValue
    } else if (attr === "translate_mode") {
      view.modeSelect.value = oldValue
    }
    renderCurrent()
    setStatus("保存失败", "is-error")
    setError(attr === "translate_mode" ? withStructuredSuggestion(error.message) : error.message)
  } finally {
    setLoading(false, "")
  }
}

function bindEvents() {
  view.providerSelect.addEventListener("change", async (event) => {
    await onConfigChange("translate_api_type", event.target.value)
  })
  view.modeSelect.addEventListener("change", async (event) => {
    await onConfigChange("translate_mode", event.target.value)
  })
  view.reloadButton.addEventListener("click", async () => {
    await syncConfig(false)
  })
}

function init() {
  view.providerSelect = document.getElementById("provider-select")
  view.modeSelect = document.getElementById("mode-select")
  view.currentEngine = document.getElementById("current-engine")
  view.currentMode = document.getElementById("current-mode")
  view.modeTip = document.getElementById("mode-tip")
  view.errorTip = document.getElementById("error-tip")
  view.syncStatus = document.getElementById("sync-status")
  view.lastSync = document.getElementById("last-sync")
  view.reloadButton = document.getElementById("reload-conf-button")

  state.hydrating = true
  renderSelect(view.providerSelect, state.options.translate_api_type, providerLabel)
  renderSelect(view.modeSelect, state.options.translate_mode, modeLabel)
  applyConfig(state.current)
  state.hydrating = false

  bindEvents()
  syncConfig(true)
}

init()
