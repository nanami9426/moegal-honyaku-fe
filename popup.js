const API_BASE = "http://127.0.0.1:8000"
const DEFAULT_OPTIONS = {
  translate_api_type: ["openai", "dashscope"],
  translate_mode: ["parallel", "structured"],
}
const BG_STORAGE_KEY = "popup_custom_background"
const CONF_STORAGE_KEY = "popup_last_translate_conf"
const CROP_ZOOM_STEPS = 1000
const BG_EXPORT_MAX_EDGE = 1600
const BG_EXPORT_MAX_PIXELS = 1_600_000

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
  cropper: {
    isOpen: false,
    image: null,
    objectUrl: "",
    ratio: 1,
    viewportWidth: 0,
    viewportHeight: 0,
    minScale: 1,
    maxScale: 1,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    dragging: false,
    dragPointerId: null,
    startX: 0,
    startY: 0,
    baseOffsetX: 0,
    baseOffsetY: 0,
    resolve: null,
    reject: null,
  },
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
  bgFileInput: null,
  clearBgButton: null,
  bgTip: null,
  cropperOverlay: null,
  cropperDesc: null,
  cropperViewport: null,
  cropperCanvas: null,
  cropperZoom: null,
  cropperCancel: null,
  cropperConfirm: null,
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function fitBackgroundExportSize(width, height) {
  let nextWidth = Math.max(1, Number.isFinite(width) ? width : 1)
  let nextHeight = Math.max(1, Number.isFinite(height) ? height : 1)

  const maxEdge = Math.max(nextWidth, nextHeight)
  if (maxEdge > BG_EXPORT_MAX_EDGE) {
    const edgeScale = BG_EXPORT_MAX_EDGE / maxEdge
    nextWidth *= edgeScale
    nextHeight *= edgeScale
  }

  const pixels = nextWidth * nextHeight
  if (pixels > BG_EXPORT_MAX_PIXELS) {
    const pixelScale = Math.sqrt(BG_EXPORT_MAX_PIXELS / pixels)
    nextWidth *= pixelScale
    nextHeight *= pixelScale
  }

  return {
    width: Math.max(1, Math.round(nextWidth)),
    height: Math.max(1, Math.round(nextHeight)),
  }
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

function setBackgroundTip(text, isError) {
  const message = typeof text === "string" ? text.trim() : ""
  view.bgTip.textContent = message || "未设置背景"
  view.bgTip.className = isError ? "bg-tip is-error" : "bg-tip"
}

function applyBackground(dataUrl) {
  const normalized = typeof dataUrl === "string" ? dataUrl.trim() : ""
  if (!normalized) {
    document.body.classList.remove("has-custom-bg")
    document.body.style.removeProperty("--popup-bg-image")
    view.clearBgButton.disabled = true
    return false
  }

  const safeUrl = normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  document.body.style.setProperty("--popup-bg-image", `url("${safeUrl}")`)
  document.body.classList.add("has-custom-bg")
  view.clearBgButton.disabled = false
  return true
}

function persistBackground(dataUrl) {
  try {
    if (dataUrl) {
      localStorage.setItem(BG_STORAGE_KEY, dataUrl)
    } else {
      localStorage.removeItem(BG_STORAGE_KEY)
    }
    return true
  } catch (error) {
    console.error("背景保存失败:", error)
    return false
  }
}

function persistCurrentConfig() {
  try {
    localStorage.setItem(CONF_STORAGE_KEY, JSON.stringify(state.current))
  } catch (error) {
    console.error("配置缓存失败:", error)
  }
}

function hydrateCachedConfig() {
  try {
    const raw = localStorage.getItem(CONF_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (typeof parsed?.translate_api_type === "string" && parsed.translate_api_type.trim()) {
      state.current.translate_api_type = parsed.translate_api_type.trim()
    }
    if (typeof parsed?.translate_mode === "string" && parsed.translate_mode.trim()) {
      state.current.translate_mode = parsed.translate_mode.trim()
    }
  } catch (error) {
    console.error("配置缓存读取失败:", error)
  }
}

function loadBackground() {
  try {
    const cached = localStorage.getItem(BG_STORAGE_KEY) || ""
    const loaded = applyBackground(cached)
    setBackgroundTip(loaded ? "已启用自定义背景。" : "未设置背景", false)
  } catch (error) {
    console.error("背景读取失败:", error)
    setBackgroundTip("读取本地背景失败。", true)
    applyBackground("")
  }
}

function popupRatio() {
  const width = Math.max(1, Math.round(window.innerWidth))
  const height = Math.max(1, Math.round(window.innerHeight))
  return width / height
}

function computeCropViewportSize(ratio) {
  const maxWidth = Math.max(160, Math.min(window.innerWidth - 44, 360))
  const maxHeight = Math.max(160, Math.min(window.innerHeight - 210, 420))

  let width = maxWidth
  let height = width / ratio
  if (height > maxHeight) {
    height = maxHeight
    width = height * ratio
  }

  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  }
}

function syncCropZoomInput() {
  const crop = state.cropper
  const range = crop.maxScale - crop.minScale
  if (range <= 0) {
    view.cropperZoom.value = "0"
    return
  }
  const progress = clamp((crop.scale - crop.minScale) / range, 0, 1)
  view.cropperZoom.value = String(Math.round(progress * CROP_ZOOM_STEPS))
}

function clampCropOffset() {
  const crop = state.cropper
  if (!crop.image) return

  const scaledWidth = crop.image.naturalWidth * crop.scale
  const scaledHeight = crop.image.naturalHeight * crop.scale

  const minX = Math.min(0, crop.viewportWidth - scaledWidth)
  const minY = Math.min(0, crop.viewportHeight - scaledHeight)
  crop.offsetX = clamp(crop.offsetX, minX, 0)
  crop.offsetY = clamp(crop.offsetY, minY, 0)
}

function renderCropCanvas() {
  const crop = state.cropper
  if (!crop.isOpen || !crop.image) return

  const canvas = view.cropperCanvas
  const context = canvas.getContext("2d")
  if (!context) return

  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(crop.viewportWidth * dpr))
  canvas.height = Math.max(1, Math.round(crop.viewportHeight * dpr))
  canvas.style.width = `${crop.viewportWidth}px`
  canvas.style.height = `${crop.viewportHeight}px`

  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, crop.viewportWidth, crop.viewportHeight)
  context.drawImage(
    crop.image,
    crop.offsetX,
    crop.offsetY,
    crop.image.naturalWidth * crop.scale,
    crop.image.naturalHeight * crop.scale,
  )
}

function setCropScale(nextScale, anchorX, anchorY) {
  const crop = state.cropper
  if (!crop.isOpen || !crop.image) return

  const targetScale = clamp(nextScale, crop.minScale, crop.maxScale)
  const oldScale = crop.scale
  if (!Number.isFinite(targetScale) || targetScale <= 0 || !Number.isFinite(oldScale) || oldScale <= 0) {
    return
  }

  const focusX = typeof anchorX === "number" ? anchorX : crop.viewportWidth / 2
  const focusY = typeof anchorY === "number" ? anchorY : crop.viewportHeight / 2

  const imageX = (focusX - crop.offsetX) / oldScale
  const imageY = (focusY - crop.offsetY) / oldScale

  crop.scale = targetScale
  crop.offsetX = focusX - imageX * crop.scale
  crop.offsetY = focusY - imageY * crop.scale
  clampCropOffset()
  renderCropCanvas()
  syncCropZoomInput()
}

function resetCropperState() {
  const crop = state.cropper
  crop.isOpen = false
  crop.image = null
  crop.objectUrl = ""
  crop.ratio = 1
  crop.viewportWidth = 0
  crop.viewportHeight = 0
  crop.minScale = 1
  crop.maxScale = 1
  crop.scale = 1
  crop.offsetX = 0
  crop.offsetY = 0
  crop.dragging = false
  crop.dragPointerId = null
  crop.startX = 0
  crop.startY = 0
  crop.baseOffsetX = 0
  crop.baseOffsetY = 0
  crop.resolve = null
  crop.reject = null
}

function closeCropperUI() {
  view.cropperOverlay.hidden = true
  view.cropperViewport.classList.remove("is-dragging")
  document.body.classList.remove("is-cropping-bg")
  const context = view.cropperCanvas.getContext("2d")
  if (context) {
    context.clearRect(0, 0, view.cropperCanvas.width, view.cropperCanvas.height)
  }
}

function finalizeCropper(result, error) {
  const crop = state.cropper
  const resolve = crop.resolve
  const reject = crop.reject
  const objectUrl = crop.objectUrl

  closeCropperUI()
  resetCropperState()

  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
  }

  if (error) {
    if (typeof reject === "function") {
      reject(error)
    }
    return
  }

  if (typeof resolve === "function") {
    resolve(result)
  }
}

function loadImageFromObjectUrl(objectUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("图片读取失败，请重试。"))
    image.src = objectUrl
  })
}

async function openCropperWithFile(file) {
  if (state.cropper.isOpen) {
    throw new Error("已有进行中的裁剪，请先完成。")
  }

  const objectUrl = URL.createObjectURL(file)
  let image = null
  try {
    image = await loadImageFromObjectUrl(objectUrl)
  } catch (error) {
    URL.revokeObjectURL(objectUrl)
    throw error
  }

  const popupWidth = Math.max(1, Math.round(window.innerWidth))
  const popupHeight = Math.max(1, Math.round(window.innerHeight))

  const crop = state.cropper
  crop.isOpen = true
  crop.image = image
  crop.objectUrl = objectUrl
  crop.ratio = popupRatio()

  const viewport = computeCropViewportSize(crop.ratio)
  crop.viewportWidth = viewport.width
  crop.viewportHeight = viewport.height

  crop.minScale = Math.max(
    crop.viewportWidth / image.naturalWidth,
    crop.viewportHeight / image.naturalHeight,
  )
  crop.maxScale = Math.max(crop.minScale * 4, crop.minScale + 0.25)
  crop.scale = crop.minScale
  crop.offsetX = (crop.viewportWidth - image.naturalWidth * crop.scale) / 2
  crop.offsetY = (crop.viewportHeight - image.naturalHeight * crop.scale) / 2
  clampCropOffset()

  view.cropperViewport.style.width = `${crop.viewportWidth}px`
  view.cropperViewport.style.height = `${crop.viewportHeight}px`
  view.cropperDesc.textContent =
    `拖动选择区域，比例固定为 ${popupWidth}:${popupHeight}（与当前 popup 大小一致）`
  view.cropperOverlay.hidden = false
  document.body.classList.add("is-cropping-bg")
  renderCropCanvas()
  syncCropZoomInput()

  return new Promise((resolve, reject) => {
    crop.resolve = resolve
    crop.reject = reject
  })
}

function exportCroppedBackground() {
  const crop = state.cropper
  if (!crop.image) {
    throw new Error("裁剪数据无效，请重新上传。")
  }

  clampCropOffset()

  const sw = crop.viewportWidth / crop.scale
  const sh = crop.viewportHeight / crop.scale
  const sxRaw = -crop.offsetX / crop.scale
  const syRaw = -crop.offsetY / crop.scale

  const sx = clamp(sxRaw, 0, Math.max(0, crop.image.naturalWidth - sw))
  const sy = clamp(syRaw, 0, Math.max(0, crop.image.naturalHeight - sh))

  const outputSize = fitBackgroundExportSize(sw, sh)
  const outputWidth = outputSize.width
  const outputHeight = outputSize.height
  const canvas = document.createElement("canvas")
  canvas.width = outputWidth
  canvas.height = outputHeight

  const context = canvas.getContext("2d")
  if (!context) {
    throw new Error("裁剪失败，请重试。")
  }

  context.drawImage(crop.image, sx, sy, sw, sh, 0, 0, outputWidth, outputHeight)
  return canvas.toDataURL("image/png")
}

function cancelCropper() {
  if (!state.cropper.isOpen) return
  finalizeCropper(null, null)
}

function confirmCropper() {
  if (!state.cropper.isOpen) return
  try {
    const dataUrl = exportCroppedBackground()
    finalizeCropper(dataUrl, null)
  } catch (error) {
    finalizeCropper(null, error instanceof Error ? error : new Error("裁剪失败，请重试。"))
  }
}

function onCropPointerDown(event) {
  const crop = state.cropper
  if (!crop.isOpen) return

  event.preventDefault()
  crop.dragging = true
  crop.dragPointerId = event.pointerId
  crop.startX = event.clientX
  crop.startY = event.clientY
  crop.baseOffsetX = crop.offsetX
  crop.baseOffsetY = crop.offsetY
  view.cropperViewport.classList.add("is-dragging")
  view.cropperViewport.setPointerCapture(event.pointerId)
}

function onCropPointerMove(event) {
  const crop = state.cropper
  if (!crop.isOpen || !crop.dragging || crop.dragPointerId !== event.pointerId) return

  event.preventDefault()
  crop.offsetX = crop.baseOffsetX + (event.clientX - crop.startX)
  crop.offsetY = crop.baseOffsetY + (event.clientY - crop.startY)
  clampCropOffset()
  renderCropCanvas()
}

function onCropPointerEnd(event) {
  const crop = state.cropper
  if (!crop.dragging) return
  if (crop.dragPointerId !== event.pointerId) return

  crop.dragging = false
  crop.dragPointerId = null
  view.cropperViewport.classList.remove("is-dragging")
  if (view.cropperViewport.hasPointerCapture(event.pointerId)) {
    view.cropperViewport.releasePointerCapture(event.pointerId)
  }
}

function onCropZoomInput(event) {
  const crop = state.cropper
  if (!crop.isOpen) return

  const value = Number(event.target.value)
  const ratio = clamp(Number.isFinite(value) ? value / CROP_ZOOM_STEPS : 0, 0, 1)
  const nextScale = crop.minScale + (crop.maxScale - crop.minScale) * ratio
  setCropScale(nextScale)
}

function onCropWheel(event) {
  const crop = state.cropper
  if (!crop.isOpen) return

  event.preventDefault()
  const delta = event.deltaY < 0 ? 1 : -1
  const step = Math.max((crop.maxScale - crop.minScale) / 24, crop.minScale * 0.04)
  const rect = view.cropperViewport.getBoundingClientRect()
  const anchorX = clamp(event.clientX - rect.left, 0, crop.viewportWidth)
  const anchorY = clamp(event.clientY - rect.top, 0, crop.viewportHeight)
  setCropScale(crop.scale + delta * step, anchorX, anchorY)
}

function onCropKeyDown(event) {
  if (!state.cropper.isOpen) return
  if (event.key !== "Escape") return
  event.preventDefault()
  cancelCropper()
}

async function onBackgroundFileChange(event) {
  const file = event.target?.files?.[0]
  if (!file) return

  if (!file.type.startsWith("image/")) {
    setBackgroundTip("请选择图片文件。", true)
    event.target.value = ""
    return
  }

  try {
    const croppedDataUrl = await openCropperWithFile(file)
    if (!croppedDataUrl) {
      setBackgroundTip("已取消背景更新。", false)
      return
    }
    const applied = applyBackground(croppedDataUrl)
    if (!applied) {
      throw new Error("背景应用失败，请重试。")
    }
    if (!persistBackground(croppedDataUrl)) {
      setBackgroundTip(`背景已应用：${file.name}（未保存，图片可能过大）`, true)
      return
    }
    setBackgroundTip(`背景已更新：${file.name}`, false)
  } catch (error) {
    console.error("背景设置失败:", error)
    setBackgroundTip(error.message || "背景设置失败。", true)
  } finally {
    event.target.value = ""
  }
}

function onBackgroundClear() {
  if (!persistBackground("")) {
    setBackgroundTip("清除背景失败，请重试。", true)
    return
  }
  applyBackground("")
  setBackgroundTip("背景已清除。", false)
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
  persistCurrentConfig()
}

async function syncConfig() {
  setLoading(true, "同步中...")
  setStatus("同步中", "is-loading")
  setError("")
  try {
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
    persistCurrentConfig()
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
    await syncConfig()
  })
  view.bgFileInput.addEventListener("change", onBackgroundFileChange)
  view.clearBgButton.addEventListener("click", onBackgroundClear)
  view.cropperCancel.addEventListener("click", cancelCropper)
  view.cropperConfirm.addEventListener("click", confirmCropper)
  view.cropperZoom.addEventListener("input", onCropZoomInput)
  view.cropperViewport.addEventListener("pointerdown", onCropPointerDown)
  view.cropperViewport.addEventListener("pointermove", onCropPointerMove)
  view.cropperViewport.addEventListener("pointerup", onCropPointerEnd)
  view.cropperViewport.addEventListener("pointercancel", onCropPointerEnd)
  view.cropperViewport.addEventListener("wheel", onCropWheel, { passive: false })
  window.addEventListener("keydown", onCropKeyDown)
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
  view.bgFileInput = document.getElementById("bg-file-input")
  view.clearBgButton = document.getElementById("clear-bg-button")
  view.bgTip = document.getElementById("bg-tip")
  view.cropperOverlay = document.getElementById("bg-cropper-overlay")
  view.cropperDesc = document.getElementById("bg-cropper-desc")
  view.cropperViewport = document.getElementById("bg-cropper-viewport")
  view.cropperCanvas = document.getElementById("bg-cropper-canvas")
  view.cropperZoom = document.getElementById("bg-cropper-zoom")
  view.cropperCancel = document.getElementById("bg-cropper-cancel")
  view.cropperConfirm = document.getElementById("bg-cropper-confirm")

  resetCropperState()
  hydrateCachedConfig()

  state.hydrating = true
  renderSelect(view.providerSelect, state.options.translate_api_type, providerLabel)
  renderSelect(view.modeSelect, state.options.translate_mode, modeLabel)
  applyConfig(state.current)
  state.hydrating = false
  loadBackground()

  bindEvents()
  syncConfig()
}

init()
