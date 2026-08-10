const API_BASE = "http://127.0.0.1:8000"
const DEFAULT_PROVIDER = "custom"
const DEFAULT_OPTIONS = {
  translate_api_type: [DEFAULT_PROVIDER, "dashscope"],
  translate_mode: ["parallel", "structured"],
}
const BG_STORAGE_KEY = "popup_custom_background"
const CONF_STORAGE_KEY = "popup_last_translate_conf"
const TEXT_DIRECTION_STORAGE_KEY = "translate_text_direction"
const DEFAULT_TEXT_DIRECTION = "horizontal"
const TEXT_DIRECTION_OPTIONS = ["horizontal", "vertical"]
const DEVICE_OPTIONS = ["cpu", "gpu"]
const CROP_ZOOM_STEPS = 1000
const BG_EXPORT_MAX_EDGE = 1600
const BG_EXPORT_MAX_PIXELS = 1_600_000
const BG_EXPORT_MAX_STORAGE_BYTES = 3 * 1024 * 1024
const BG_EXPORT_SCALE_STEP = 0.82
const BG_EXPORT_MAX_RESIZE_ATTEMPTS = 6
const BG_EXPORT_QUALITIES = [0.88, 0.76, 0.64, 0.52]

const PROVIDER_LABEL = {
  custom: "Custom",
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

const TEXT_DIRECTION_LABEL = {
  horizontal: "横排",
  vertical: "竖排",
}

const TEXT_DIRECTION_DESC = {
  horizontal: "横排：使用当前默认布局，适合大多数气泡回填。",
  vertical: "竖排：按自上而下、列从右到左的方式回填文字。",
}

const DEVICE_LABEL = {
  cpu: "CPU",
  gpu: "GPU",
}

const DEVICE_DESC = {
  cpu: "CPU：兼容性更好，无需独立显卡。",
  gpu: "GPU：加速 OCR；CUDA 不可用时后端会自动回退到 CPU。",
}

const state = {
  options: { ...DEFAULT_OPTIONS },
  current: {
    translate_api_type: DEFAULT_PROVIDER,
    translate_mode: "parallel",
    use_gpu: false,
  },
  providerStatus: {},
  gpuStatus: {
    requested: false,
    device: "cpu",
    message: "",
  },
  local: {
    text_direction: DEFAULT_TEXT_DIRECTION,
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
  directionSelect: null,
  deviceSelect: null,
  currentEngine: null,
  currentMode: null,
  currentDirection: null,
  currentDevice: null,
  modeTip: null,
  directionTip: null,
  deviceTip: null,
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

function backgroundStorageBytes(dataUrl) {
  const normalized = typeof dataUrl === "string" ? dataUrl : ""
  return JSON.stringify({ [BG_STORAGE_KEY]: normalized }).length
}

function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
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

function normalizeProviderValue(value, fallback = DEFAULT_PROVIDER) {
  if (typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (normalized === "openai") return DEFAULT_PROVIDER
  return normalized
}

function normalizeProviderStatus(payload) {
  if (!payload || typeof payload !== "object") return {}
  const normalized = {}
  Object.entries(payload).forEach(([provider, value]) => {
    const key = normalizeProviderValue(provider, "")
    if (!key) return
    const item = value && typeof value === "object" ? value : {}
    normalized[key] = {
      configured: Boolean(item.configured),
      message: typeof item.message === "string" ? item.message.trim() : "",
    }
  })
  return normalized
}

function currentProviderStatusMessage() {
  const info = state.providerStatus[normalizeProviderValue(state.current.translate_api_type, "")]
  if (!info || info.configured) return ""
  return info.message
}

function currentGpuStatusMessage() {
  if (!state.current.use_gpu) return ""
  return state.gpuStatus.message
}

function modeLabel(value) {
  return MODE_LABEL[value] || value
}

function modeTip(value) {
  return MODE_DESC[value] || "可选择并行或结构化翻译模式。"
}

function textDirectionLabel(value) {
  return TEXT_DIRECTION_LABEL[value] || TEXT_DIRECTION_LABEL[DEFAULT_TEXT_DIRECTION]
}

function textDirectionTip(value) {
  return TEXT_DIRECTION_DESC[value] || TEXT_DIRECTION_DESC[DEFAULT_TEXT_DIRECTION]
}

function normalizeTextDirection(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : ""
  return TEXT_DIRECTION_OPTIONS.includes(normalized) ? normalized : DEFAULT_TEXT_DIRECTION
}

function normalizeUseGpu(value) {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    return ["1", "true", "yes", "on", "gpu"].includes(value.trim().toLowerCase())
  }
  return false
}

function deviceValue(useGpu) {
  return useGpu ? "gpu" : "cpu"
}

function deviceLabel(value) {
  return DEVICE_LABEL[value] || DEVICE_LABEL.cpu
}

function deviceTip(value) {
  return state.gpuStatus.message || DEVICE_DESC[value] || DEVICE_DESC.cpu
}

function normalizeGpuStatus(payload, requested) {
  const item = payload && typeof payload === "object" ? payload : {}
  return {
    requested,
    device: item.device === "gpu" ? "gpu" : "cpu",
    message: typeof item.message === "string" ? item.message.trim() : "",
  }
}

function getExtensionStorageArea() {
  return globalThis.chrome?.storage?.local || null
}

async function readStoredTextDirection() {
  const storage = getExtensionStorageArea()
  if (!storage) return DEFAULT_TEXT_DIRECTION

  return new Promise((resolve) => {
    storage.get({ [TEXT_DIRECTION_STORAGE_KEY]: DEFAULT_TEXT_DIRECTION }, (result) => {
      if (globalThis.chrome?.runtime?.lastError) {
        console.error("文字方向读取失败:", globalThis.chrome.runtime.lastError)
        resolve(DEFAULT_TEXT_DIRECTION)
        return
      }
      resolve(normalizeTextDirection(result?.[TEXT_DIRECTION_STORAGE_KEY]))
    })
  })
}

async function writeStoredTextDirection(value) {
  const storage = getExtensionStorageArea()
  if (!storage) return false

  return new Promise((resolve) => {
    storage.set({ [TEXT_DIRECTION_STORAGE_KEY]: normalizeTextDirection(value) }, () => {
      if (globalThis.chrome?.runtime?.lastError) {
        console.error("文字方向保存失败:", globalThis.chrome.runtime.lastError)
        resolve(false)
        return
      }
      resolve(true)
    })
  })
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

function renderCurrent() {
  view.currentEngine.textContent = providerLabel(state.current.translate_api_type)
  view.currentMode.textContent = modeLabel(state.current.translate_mode)
  view.currentDirection.textContent = textDirectionLabel(state.local.text_direction)
  view.currentDevice.textContent = deviceLabel(state.gpuStatus.device)
  view.modeTip.textContent = modeTip(state.current.translate_mode)
  view.directionTip.textContent = textDirectionTip(state.local.text_direction)
  view.deviceTip.textContent = deviceTip(deviceValue(state.current.use_gpu))
  setError([currentProviderStatusMessage(), currentGpuStatusMessage()].filter(Boolean).join("；"))
}

function applyTextDirection(value) {
  const nextDirection = normalizeTextDirection(value)
  state.local.text_direction = nextDirection
  view.directionSelect.value = nextDirection
  renderCurrent()
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

function clearLegacyBackground() {
  try {
    globalThis.localStorage?.removeItem(BG_STORAGE_KEY)
  } catch (error) {
    console.error("旧背景缓存清理失败:", error)
  }
}

function readLegacyBackground() {
  try {
    return globalThis.localStorage?.getItem(BG_STORAGE_KEY) || ""
  } catch (error) {
    console.error("旧背景缓存读取失败:", error)
    return ""
  }
}

async function persistBackground(dataUrl) {
  const normalized = typeof dataUrl === "string" ? dataUrl.trim() : ""
  const storage = getExtensionStorageArea()

  if (storage) {
    const saved = await new Promise((resolve) => {
      const onComplete = () => {
        const lastError = globalThis.chrome?.runtime?.lastError
        if (lastError) {
          console.error("背景保存失败:", lastError)
          resolve(false)
          return
        }
        resolve(true)
      }

      if (normalized) {
        storage.set({ [BG_STORAGE_KEY]: normalized }, onComplete)
      } else {
        storage.remove(BG_STORAGE_KEY, onComplete)
      }
    })
    if (saved) clearLegacyBackground()
    return saved
  }

  try {
    if (normalized) {
      globalThis.localStorage?.setItem(BG_STORAGE_KEY, normalized)
    } else {
      globalThis.localStorage?.removeItem(BG_STORAGE_KEY)
    }
    return Boolean(globalThis.localStorage)
  } catch (error) {
    console.error("背景保存失败:", error)
    return false
  }
}

async function readStoredBackground() {
  const storage = getExtensionStorageArea()
  if (storage) {
    const stored = await new Promise((resolve, reject) => {
      storage.get({ [BG_STORAGE_KEY]: "" }, (result) => {
        const lastError = globalThis.chrome?.runtime?.lastError
        if (lastError) {
          console.error("背景读取失败:", lastError)
          reject(new Error(lastError.message || "浏览器扩展存储读取失败"))
          return
        }
        const value = result?.[BG_STORAGE_KEY]
        resolve(typeof value === "string" ? value : "")
      })
    })
    if (stored) return stored
  }

  const legacy = readLegacyBackground()
  if (legacy && storage) {
    await persistBackground(legacy)
  }
  return legacy
}

function ensureBackgroundDecodable(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve()
    image.onerror = () => reject(new Error("背景图片数据已损坏或图片过大，请重新设置"))
    image.src = dataUrl
  })
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
      state.current.translate_api_type = normalizeProviderValue(parsed.translate_api_type)
    }
    if (typeof parsed?.translate_mode === "string" && parsed.translate_mode.trim()) {
      state.current.translate_mode = parsed.translate_mode.trim()
    }
    if (typeof parsed?.use_gpu === "boolean") {
      state.current.use_gpu = parsed.use_gpu
      state.gpuStatus = normalizeGpuStatus(null, parsed.use_gpu)
    }
  } catch (error) {
    console.error("配置缓存读取失败:", error)
  }
}

async function loadBackground() {
  try {
    const cached = await readStoredBackground()
    if (cached) await ensureBackgroundDecodable(cached)
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
  let outputWidth = outputSize.width
  let outputHeight = outputSize.height
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d")
  if (!context) {
    throw new Error("裁剪失败，请重试。")
  }

  let smallestDataUrl = ""
  for (let attempt = 0; attempt < BG_EXPORT_MAX_RESIZE_ATTEMPTS; attempt += 1) {
    canvas.width = outputWidth
    canvas.height = outputHeight
    context.clearRect(0, 0, outputWidth, outputHeight)
    context.drawImage(crop.image, sx, sy, sw, sh, 0, 0, outputWidth, outputHeight)

    for (const quality of BG_EXPORT_QUALITIES) {
      const dataUrl = canvas.toDataURL("image/webp", quality)
      if (!dataUrl.startsWith("data:image/webp")) {
        throw new Error("当前浏览器不支持 WebP 背景压缩")
      }
      smallestDataUrl = dataUrl
      if (backgroundStorageBytes(dataUrl) <= BG_EXPORT_MAX_STORAGE_BYTES) {
        return dataUrl
      }
    }

    outputWidth = Math.max(1, Math.round(outputWidth * BG_EXPORT_SCALE_STEP))
    outputHeight = Math.max(1, Math.round(outputHeight * BG_EXPORT_SCALE_STEP))
  }

  const actualSize = formatBytes(backgroundStorageBytes(smallestDataUrl))
  const limit = formatBytes(BG_EXPORT_MAX_STORAGE_BYTES)
  throw new Error(`背景压缩后仍过大（${actualSize}，上限 ${limit}），请换一张图片`)
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
    if (!await persistBackground(croppedDataUrl)) {
      throw new Error("背景保存失败，请检查浏览器扩展存储空间")
    }
    if (!applyBackground(croppedDataUrl)) {
      throw new Error("背景应用失败，请重试。")
    }
    const storedSize = formatBytes(backgroundStorageBytes(croppedDataUrl))
    setBackgroundTip(`背景已更新：${file.name}（${storedSize}）`, false)
  } catch (error) {
    console.error("背景设置失败:", error)
    setBackgroundTip(error.message || "背景设置失败。", true)
  } finally {
    event.target.value = ""
  }
}

async function onBackgroundClear() {
  if (!await persistBackground("")) {
    setBackgroundTip("清除背景失败，请重试。", true)
    return
  }
  applyBackground("")
  setBackgroundTip("背景已清除。", false)
}

function setLoading(loading, loadingText) {
  view.providerSelect.disabled = loading
  view.modeSelect.disabled = loading
  view.directionSelect.disabled = loading
  view.deviceSelect.disabled = loading
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
  const providerOptions = Array.from(
    new Set(
      cleanValues(payload?.translate_api_type)
        .map((value) => normalizeProviderValue(value, ""))
        .filter((value) => value.length > 0),
    ),
  )
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

function applyConfig(conf) {
  const nextProvider = normalizeProviderValue(conf?.translate_api_type)
  const nextMode = typeof conf?.translate_mode === "string" ? conf.translate_mode : "parallel"
  const nextUseGpu = normalizeUseGpu(conf?.use_gpu)

  state.current.translate_api_type = nextProvider
  state.current.translate_mode = nextMode
  state.current.use_gpu = nextUseGpu
  state.providerStatus = normalizeProviderStatus(conf?.provider_status)
  state.gpuStatus = normalizeGpuStatus(conf?.gpu_status, nextUseGpu)

  ensureOption(view.providerSelect, nextProvider, providerLabel(nextProvider))
  ensureOption(view.modeSelect, nextMode, modeLabel(nextMode))

  view.providerSelect.value = nextProvider
  view.modeSelect.value = nextMode
  view.deviceSelect.value = deviceValue(nextUseGpu)
  renderCurrent()
  persistCurrentConfig()
}

async function hydrateTextDirection() {
  applyTextDirection(await readStoredTextDirection())
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
    applyConfig(await updateConf(attr, value))
    view.lastSync.textContent = now()
    setStatus("保存成功", "is-ok")
  } catch (error) {
    console.error("配置更新失败:", error)
    if (attr === "translate_api_type") {
      view.providerSelect.value = oldValue
    } else if (attr === "translate_mode") {
      view.modeSelect.value = oldValue
    } else if (attr === "use_gpu") {
      view.deviceSelect.value = deviceValue(oldValue)
    }
    renderCurrent()
    setStatus("保存失败", "is-error")
    setError(attr === "translate_mode" ? withStructuredSuggestion(error.message) : error.message)
  } finally {
    setLoading(false, "")
  }
}

async function onTextDirectionChange(value) {
  if (state.hydrating) return

  const oldValue = state.local.text_direction
  const nextValue = normalizeTextDirection(value)
  if (oldValue === nextValue) return

  setError("")
  applyTextDirection(nextValue)

  const saved = await writeStoredTextDirection(nextValue)
  if (saved) return

  applyTextDirection(oldValue)
  setError("文字方向保存失败，请重试。")
}

function bindEvents() {
  view.providerSelect.addEventListener("change", async (event) => {
    await onConfigChange("translate_api_type", event.target.value)
  })
  view.modeSelect.addEventListener("change", async (event) => {
    await onConfigChange("translate_mode", event.target.value)
  })
  view.directionSelect.addEventListener("change", async (event) => {
    await onTextDirectionChange(event.target.value)
  })
  view.deviceSelect.addEventListener("change", async (event) => {
    await onConfigChange("use_gpu", event.target.value === "gpu")
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

async function init() {
  view.providerSelect = document.getElementById("provider-select")
  view.modeSelect = document.getElementById("mode-select")
  view.directionSelect = document.getElementById("direction-select")
  view.deviceSelect = document.getElementById("device-select")
  view.currentEngine = document.getElementById("current-engine")
  view.currentMode = document.getElementById("current-mode")
  view.currentDirection = document.getElementById("current-direction")
  view.currentDevice = document.getElementById("current-device")
  view.modeTip = document.getElementById("mode-tip")
  view.directionTip = document.getElementById("direction-tip")
  view.deviceTip = document.getElementById("device-tip")
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
  renderSelect(view.directionSelect, TEXT_DIRECTION_OPTIONS, textDirectionLabel)
  renderSelect(view.deviceSelect, DEVICE_OPTIONS, deviceLabel)
  applyConfig(state.current)
  await hydrateTextDirection()
  state.hydrating = false
  await loadBackground()

  bindEvents()
  syncConfig()
}

void init()
