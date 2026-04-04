const EXCLUDED_IMAGE_KEYWORDS = /(avatar|icon|logo|emoji|emoticon|sprite|thumb|thumbnail|favicon|profile|userpic|badge)/i
const COMIC_IMAGE_HINT_KEYWORDS = /(comic|manga|manhua|manhwa|chapter|panel|page|raw)/i
const CANVAS_INCLUDE_KEYWORDS = /(page|contents|reader|comic|manga|chapter|panel|slide)/i
const CANVAS_EXCLUDE_KEYWORDS = /(chart|graph|avatar|icon|logo|video|editor|signature|captcha)/i
const DEFAULT_API_BASE = "http://127.0.0.1:8000"
const API_BASE_STORAGE_KEY = "api_base_url"
const AUTO_TRANSLATE_KEY = "auto_translate_enabled"
const AUTO_SAVE_IMAGE_KEY = "auto_save_image_enabled"
const BASE64_UPLOAD_KEY = "base64_upload_enabled"

let API_BASE = DEFAULT_API_BASE
let TRANSLATE_API_URL = `${API_BASE.replace(/\/+$/, "")}/api/v1/translate/web`

const MIN_RENDERED_WIDTH = 160
const MIN_RENDERED_HEIGHT = 160
const MIN_RENDERED_AREA = 42000
const MIN_NATURAL_WIDTH = 260
const MIN_NATURAL_HEIGHT = 260
const MIN_ASPECT_RATIO = 0.28
const MAX_ASPECT_RATIO = 3.5

const BUTTON_HIDE_DELAY = 200
const BUTTON_RESET_DELAY = 2000

const surfaceButtons = new WeakMap()
const canvasOverlays = new WeakMap()
const translatedSurfaces = new WeakSet()

let autoTranslateEnabled = false
let autoTranslateQueue = []
let isProcessingQueue = false
let autoSaveImageEnabled = false
let base64UploadEnabled = true  // 默认开启 base64 上传

function decodeSafe(text) {
    try {
        return decodeURIComponent(text)
    } catch (error) {
        return text
    }
}

function getNodeTextForMatch(node) {
    if (!node || !(node instanceof Element)) return ""
    const tagName = node.tagName?.toLowerCase() || ""
    const id = node.id || ""
    const className = typeof node.className === "string" ? node.className : ""
    const ariaLabel = node.getAttribute("aria-label") || ""
    const role = node.getAttribute("role") || ""
    const dataType = node.getAttribute("data-type") || ""
    const datasetValues = node.dataset ? Object.values(node.dataset).join(" ") : ""
    return `${tagName} ${id} ${className} ${ariaLabel} ${role} ${dataType} ${datasetValues}`.toLowerCase()
}

function matchesKeywordAroundNode(node, pattern, maxDepth = 4) {
    let current = node instanceof Element ? node : null
    let depth = 0
    while (current && depth < maxDepth) {
        if (pattern.test(getNodeTextForMatch(current))) {
            return true
        }

        const previous = current.previousElementSibling
        if (previous && pattern.test(getNodeTextForMatch(previous))) {
            return true
        }

        const next = current.nextElementSibling
        if (next && pattern.test(getNodeTextForMatch(next))) {
            return true
        }

        current = current.parentElement
        depth += 1
    }
    return false
}

function hasExcludedKeywordAroundNode(node) {
    return matchesKeywordAroundNode(node, EXCLUDED_IMAGE_KEYWORDS)
}

function isLikelyRoundAvatar(img, rect) {
    const style = window.getComputedStyle(img)
    const borderRadius = style.borderRadius || ""
    if (borderRadius.includes("%")) {
        const percent = Number.parseFloat(borderRadius)
        if (Number.isFinite(percent) && percent >= 40) return true
    }

    const topLeftRadius = Number.parseFloat(style.borderTopLeftRadius)
    const minSide = Math.min(rect.width, rect.height)
    if (Number.isFinite(topLeftRadius) && minSide > 0 && topLeftRadius >= minSide * 0.35) {
        return true
    }

    return false
}

function isManagedOverlayNode(node) {
    return Boolean(node instanceof Element && node.closest(".moegal-translate-overlay"))
}

function getSurfaceRect(surface) {
    return surface.getBoundingClientRect()
}

function getSurfaceIntrinsicSize(surface, rect) {
    if (surface instanceof HTMLImageElement) {
        return {
            width: surface.naturalWidth || rect.width,
            height: surface.naturalHeight || rect.height,
        }
    }

    if (surface instanceof HTMLCanvasElement) {
        return {
            width: surface.width || rect.width,
            height: surface.height || rect.height,
        }
    }

    return {
        width: rect.width,
        height: rect.height,
    }
}

function isSurfaceSizeEligible(surface) {
    if (!(surface instanceof Element) || !surface.isConnected) return false

    const rect = getSurfaceRect(surface)
    if (rect.width < MIN_RENDERED_WIDTH || rect.height < MIN_RENDERED_HEIGHT) return false
    if (rect.width * rect.height < MIN_RENDERED_AREA) return false
    if (rect.bottom <= 0 || rect.right <= 0) return false

    const intrinsicSize = getSurfaceIntrinsicSize(surface, rect)
    if (intrinsicSize.width < MIN_NATURAL_WIDTH || intrinsicSize.height < MIN_NATURAL_HEIGHT) return false

    const ratio = intrinsicSize.width / intrinsicSize.height
    if (ratio < MIN_ASPECT_RATIO || ratio > MAX_ASPECT_RATIO) return false

    return true
}

function isTranslatableImage(img) {
    if (!(img instanceof HTMLImageElement)) return false
    if (isManagedOverlayNode(img)) return false
    if (!isSurfaceSizeEligible(img)) return false

    const rect = getSurfaceRect(img)
    const src = decodeSafe((img.currentSrc || img.src || "").toLowerCase())
    if (!src) return false
    if (src.startsWith("data:image/svg") || /\.svg(\?|#|$)/i.test(src)) return false
    if (EXCLUDED_IMAGE_KEYWORDS.test(src)) return false

    const alt = (img.alt || "").toLowerCase()
    if (EXCLUDED_IMAGE_KEYWORDS.test(alt)) return false
    if (EXCLUDED_IMAGE_KEYWORDS.test(getNodeTextForMatch(img))) return false
    if (hasExcludedKeywordAroundNode(img)) return false

    if (isLikelyRoundAvatar(img, rect) && !COMIC_IMAGE_HINT_KEYWORDS.test(src)) return false

    return true
}

function isTranslatableCanvas(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) return false
    if (isManagedOverlayNode(canvas)) return false
    if (!isSurfaceSizeEligible(canvas)) return false
    if (matchesKeywordAroundNode(canvas, CANVAS_EXCLUDE_KEYWORDS)) return false
    if (!matchesKeywordAroundNode(canvas, CANVAS_INCLUDE_KEYWORDS)) return false
    return true
}

function isTranslatableSurface(surface) {
    if (surface instanceof HTMLImageElement) return isTranslatableImage(surface)
    if (surface instanceof HTMLCanvasElement) return isTranslatableCanvas(surface)
    return false
}

function getSurfaceHoverTarget(surface) {
    if (surface instanceof HTMLCanvasElement) {
        return surface.parentElement || surface
    }
    return surface
}

function clearHideTimer(state) {
    if (!state.hideTimeout) return
    clearTimeout(state.hideTimeout)
    state.hideTimeout = 0
}

function scheduleButtonReset(state, delay = BUTTON_RESET_DELAY) {
    if (state.resetTimeout) {
        clearTimeout(state.resetTimeout)
    }
    state.resetTimeout = setTimeout(() => {
        state.button.textContent = "翻译图片"
        state.resetTimeout = 0
    }, delay)
}

function setButtonMessage(state, text, delay = BUTTON_RESET_DELAY) {
    clearHideTimer(state)
    if (state.resetTimeout) {
        clearTimeout(state.resetTimeout)
        state.resetTimeout = 0
    }
    state.button.textContent = text
    scheduleButtonReset(state, delay)
}

function buildRefererBaseUrl() {
    return `${window.location.protocol}//${window.location.hostname}`
}

function parseResponseError(result, response) {
    return (
        result?.detail ||
        result?.info ||
        result?.message ||
        `请求失败 (${response.status})`
    )
}

function logTranslateResult(result) {
    if (!result) return
    console.log("-------------------------------------")
    console.log(`耗时：${result.duration}，花费${result.price}`)
    console.log(`原句：${result.raw_text}`)
    console.log(`翻译：${result.cn_text}`)
    console.log("-------------------------------------")
}

function isCanvasReadBlockedError(error) {
    const message = error instanceof Error ? error.message : String(error || "")
    return /taint|cross-origin|security|insecure|permission|origin-clean|read the canvas/i.test(message)
}

function getCanvasImageBase64(canvas) {
    try {
        return canvas.toDataURL("image/png")
    } catch (error) {
        throw error instanceof Error ? error : new Error(String(error))
    }
}

async function getImageBase64(img) {
    const src = img.currentSrc || img.src
    if (!src) {
        throw new Error("图片地址为空")
    }
    
    // 如果已经是 base64，直接返回
    if (src.startsWith("data:image")) {
        return src
    }
    
    // 尝试使用 background script 获取图片（绑过 CORS）
    try {
        const response = await chrome.runtime.sendMessage({
            type: "FETCH_IMAGE",
            url: src,
            referer: window.location.href
        })
        if (response.error) {
            throw new Error(response.error)
        }
        if (response.base64) {
            return response.base64
        }
    } catch (bgError) {
        console.warn("Background fetch failed:", bgError)
    }
    
    // 如果 background script 失败，尝试直接 fetch
    try {
        const response = await fetch(src, {
            mode: "cors",
            credentials: "omit",
        })
        if (!response.ok) {
            throw new Error(`图片获取失败: ${response.status}`)
        }
        const blob = await response.blob()
        // 转换为 PNG 格式
        return new Promise((resolve, reject) => {
            const tempImg = new Image()
            tempImg.onload = () => {
                const canvas = document.createElement("canvas")
                canvas.width = tempImg.width
                canvas.height = tempImg.height
                const ctx = canvas.getContext("2d")
                ctx.drawImage(tempImg, 0, 0)
                resolve(canvas.toDataURL("image/png"))
            }
            tempImg.onerror = () => reject(new Error("图片加载失败"))
            tempImg.src = URL.createObjectURL(blob)
        })
    } catch (fetchError) {
        // 如果 fetch 失败（可能是 CORS），尝试使用 canvas 方式
        try {
            const canvas = document.createElement("canvas")
            canvas.width = img.naturalWidth
            canvas.height = img.naturalHeight
            const ctx = canvas.getContext("2d")
            ctx.drawImage(img, 0, 0)
            return canvas.toDataURL("image/png")
        } catch (canvasError) {
            throw new Error("无法获取图片数据，可能是跨域限制")
        }
    }
}

async function getTranslatePayload(surface) {
    const referer = buildRefererBaseUrl()
    if (surface instanceof HTMLImageElement) {
        // 根据开关决定使用 URL 还是 base64
        if (base64UploadEnabled) {
            const imageBase64 = await getImageBase64(surface)
            return {
                image_base64: imageBase64,
                referer,
                source_type: "img",
            }
        } else {
            return {
                image_url: surface.currentSrc || surface.src,
                referer,
                source_type: "img",
            }
        }
    }

    if (surface instanceof HTMLCanvasElement) {
        return {
            image_base64: getCanvasImageBase64(surface),
            referer,
            source_type: "canvas",
        }
    }

    throw new Error("暂不支持该类型")
}

function getCanvasOverlayContainer(canvas) {
    if (canvas.parentElement) return canvas.parentElement
    throw new Error("无法定位画布容器")
}

function ensureRelativePosition(container) {
    const style = window.getComputedStyle(container)
    if (style.position === "static") {
        container.style.position = "relative"
    }
}

function syncCanvasOverlayBounds(state) {
    if (!state.overlay.isConnected || !state.canvas.isConnected || !state.container.isConnected) return

    const canvasRect = state.canvas.getBoundingClientRect()
    const containerRect = state.container.getBoundingClientRect()
    state.overlay.style.left = `${Math.max(0, canvasRect.left - containerRect.left + state.container.scrollLeft)}px`
    state.overlay.style.top = `${Math.max(0, canvasRect.top - containerRect.top + state.container.scrollTop)}px`
    state.overlay.style.width = `${canvasRect.width}px`
    state.overlay.style.height = `${canvasRect.height}px`
}

function ensureCanvasOverlay(canvas) {
    const container = getCanvasOverlayContainer(canvas)
    const existing = canvasOverlays.get(canvas)
    if (existing && existing.overlay.isConnected && existing.container === container) {
        syncCanvasOverlayBounds(existing)
        return existing
    }

    if (existing?.resizeObserver) {
        existing.resizeObserver.disconnect()
    }
    if (existing?.overlay?.isConnected) {
        existing.overlay.remove()
    }

    ensureRelativePosition(container)

    const overlay = document.createElement("div")
    overlay.className = "moegal-translate-overlay"
    overlay.setAttribute("aria-hidden", "true")

    const image = document.createElement("img")
    image.className = "moegal-translate-overlay-image"
    image.alt = ""
    overlay.appendChild(image)
    container.appendChild(overlay)

    const state = {
        canvas,
        container,
        overlay,
        image,
        resizeObserver: null,
    }

    if (typeof ResizeObserver === "function") {
        state.resizeObserver = new ResizeObserver(() => {
            syncCanvasOverlayBounds(state)
        })
        state.resizeObserver.observe(container)
        state.resizeObserver.observe(canvas)
    }

    canvasOverlays.set(canvas, state)
    syncCanvasOverlayBounds(state)
    return state
}

function applyTranslatedResult(surface, translatedDataUrl) {
    if (surface instanceof HTMLImageElement) {
        surface.src = translatedDataUrl
        return
    }

    if (surface instanceof HTMLCanvasElement) {
        const overlayState = ensureCanvasOverlay(surface)
        overlayState.image.src = translatedDataUrl
        overlayState.overlay.hidden = false
        syncCanvasOverlayBounds(overlayState)
    }
}

function downloadTranslatedImage(translatedDataUrl, sourceUrl) {
    try {
        const link = document.createElement("a")
        link.href = translatedDataUrl
        // 从原图片URL提取文件名，或使用默认名
        let filename = "translated_image.png"
        if (sourceUrl) {
            try {
                const urlPath = new URL(sourceUrl).pathname
                const originalName = urlPath.split("/").pop()
                if (originalName && originalName.includes(".")) {
                    const nameWithoutExt = originalName.replace(/\.[^.]+$/, "")
                    filename = `${nameWithoutExt}_translated.png`
                }
            } catch (e) {
                // URL解析失败，使用默认文件名
            }
        }
        link.download = filename
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
    } catch (error) {
        console.error("保存图片失败:", error)
    }
}

async function requestTranslation(surface) {
    const payload = await getTranslatePayload(surface)
    const response = await fetch(TRANSLATE_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "true",
        },
        body: JSON.stringify(payload),
    })

    let result = null
    try {
        result = await response.json()
    } catch (error) {
        result = null
    }

    if (!response.ok) {
        throw new Error(parseResponseError(result, response))
    }

    logTranslateResult(result)

    if (result?.status !== "success") {
        throw new Error(result?.info || "error")
    }

    return result
}

function createTranslateButton(surface) {
    if (!(surface instanceof HTMLImageElement || surface instanceof HTMLCanvasElement)) return
    if (isManagedOverlayNode(surface)) return
    if (surfaceButtons.has(surface)) return

    const hoverTarget = getSurfaceHoverTarget(surface)
    if (!(hoverTarget instanceof Element)) return

    const button = document.createElement("button")
    button.type = "button"
    button.textContent = "翻译图片"
    button.className = "translate-btn"
    button.style.position = "absolute"
    button.style.zIndex = 9999
    button.style.display = "none"
    document.body.appendChild(button)

    const state = {
        surface,
        hoverTarget,
        button,
        hideTimeout: 0,
        resetTimeout: 0,
    }

    surfaceButtons.set(surface, state)

    const updateButtonPosition = () => {
        const rect = getSurfaceRect(surface)
        button.style.top = `${rect.top + window.scrollY + 3}px`
        button.style.left = `${rect.left + window.scrollX + 3}px`
    }

    const showButton = () => {
        clearHideTimer(state)
        if (!surface.isConnected || !isTranslatableSurface(surface)) {
            button.style.display = "none"
            return
        }
        updateButtonPosition()
        button.style.display = "block"
    }

    const hideButtonWithDelay = () => {
        clearHideTimer(state)
        state.hideTimeout = setTimeout(() => {
            button.style.display = "none"
            state.hideTimeout = 0
        }, BUTTON_HIDE_DELAY)
    }

    hoverTarget.addEventListener("mouseenter", showButton)
    hoverTarget.addEventListener("mouseleave", hideButtonWithDelay)
    button.addEventListener("mouseenter", showButton)
    button.addEventListener("mouseleave", hideButtonWithDelay)
    button.addEventListener("click", async (event) => {
        event.preventDefault()
        event.stopPropagation()

        if (!isTranslatableSurface(surface)) {
            setButtonMessage(state, "仅支持漫画图", 1200)
            return
        }

        if (state.resetTimeout) {
            clearTimeout(state.resetTimeout)
            state.resetTimeout = 0
        }
        button.textContent = "处理中..."

        try {
            const result = await requestTranslation(surface)
            const translatedDataUrl = "data:image/png;base64," + result.res_img
            applyTranslatedResult(surface, translatedDataUrl)
            // 自动保存图片
            if (autoSaveImageEnabled) {
                const sourceUrl = surface instanceof HTMLImageElement ? (surface.currentSrc || surface.src) : null
                downloadTranslatedImage(translatedDataUrl, sourceUrl)
            }
            button.textContent = "翻译完成"
        } catch (error) {
            console.error("翻译失败:", error)
            if (surface instanceof HTMLCanvasElement && isCanvasReadBlockedError(error)) {
                button.textContent = "当前页面禁止读取画布"
            } else {
                const errorMessage = error instanceof Error ? error.message : String(error || "")
                if (/structured|格式|数量|不匹配|列表|list/i.test(errorMessage)) {
                    button.textContent = "请重试/切并行"
                } else {
                    button.textContent = "翻译失败"
                }
            }
        }

        scheduleButtonReset(state)
    })
}

async function init() {
  await loadApiBase()
  const surfaces = document.querySelectorAll("img, canvas")
  surfaces.forEach((surface) => createTranslateButton(surface))
}
function handleAddedNode(node) {
    if (!(node instanceof Element)) return

    if (node instanceof HTMLImageElement || node instanceof HTMLCanvasElement) {
        createTranslateButton(node)
        addToAutoTranslateQueue(node)
    }

    const surfaces = node.querySelectorAll?.("img, canvas")
    surfaces?.forEach((surface) => {
        createTranslateButton(surface)
        addToAutoTranslateQueue(surface)
    })
}

// 自动翻译相关函数
async function loadApiBase() {
  try {
    const result = await chrome.storage.local.get(API_BASE_STORAGE_KEY)
    const savedBase = result[API_BASE_STORAGE_KEY]
    if (savedBase && typeof savedBase === "string" && savedBase.trim()) {
      API_BASE = savedBase.trim()
    } else {
      API_BASE = DEFAULT_API_BASE
    }
    TRANSLATE_API_URL = `${API_BASE.replace(/\/+$/, "")}/api/v1/translate/web`
  } catch (error) {
    console.error("读取API地址失败:", error)
    API_BASE = DEFAULT_API_BASE
    TRANSLATE_API_URL = `${API_BASE.replace(/\/+$/, "")}/api/v1/translate/web`
  }
}

async function loadAutoTranslateState() {
    try {
        const result = await chrome.storage.local.get([AUTO_TRANSLATE_KEY, AUTO_SAVE_IMAGE_KEY, BASE64_UPLOAD_KEY])
        autoTranslateEnabled = result[AUTO_TRANSLATE_KEY] === true
        autoSaveImageEnabled = result[AUTO_SAVE_IMAGE_KEY] === true
        base64UploadEnabled = result[BASE64_UPLOAD_KEY] !== false  // 默认开启，只有明确设为 false 才关闭
        if (autoTranslateEnabled) {
            startAutoTranslate()
        }
    } catch (error) {
        console.error("读取自动翻译状态失败:", error)
    }
}

function startAutoTranslate() {
    autoTranslateQueue = []
    const surfaces = document.querySelectorAll("img, canvas")
    surfaces.forEach((surface) => {
        if (isTranslatableSurface(surface) && !translatedSurfaces.has(surface)) {
            autoTranslateQueue.push(surface)
        }
    })
    processAutoTranslateQueue()
}

function stopAutoTranslate() {
    autoTranslateQueue = []
}

async function processAutoTranslateQueue() {
    if (isProcessingQueue || !autoTranslateEnabled) return
    if (autoTranslateQueue.length === 0) return

    isProcessingQueue = true

    while (autoTranslateQueue.length > 0 && autoTranslateEnabled) {
        const surface = autoTranslateQueue.shift()
        
        if (!surface.isConnected || translatedSurfaces.has(surface)) {
            continue
        }

        if (!isTranslatableSurface(surface)) {
            continue
        }

        try {
            const result = await requestTranslation(surface)
            const translatedDataUrl = "data:image/png;base64," + result.res_img
            applyTranslatedResult(surface, translatedDataUrl)
            translatedSurfaces.add(surface)
            // 自动保存图片
            if (autoSaveImageEnabled) {
                const sourceUrl = surface instanceof HTMLImageElement ? (surface.currentSrc || surface.src) : null
                downloadTranslatedImage(translatedDataUrl, sourceUrl)
            }
        } catch (error) {
            console.error("自动翻译失败:", error)
        }
    }

    isProcessingQueue = false
}

function addToAutoTranslateQueue(surface) {
    if (!autoTranslateEnabled) return
    if (!isTranslatableSurface(surface)) return
    if (translatedSurfaces.has(surface)) return
    if (autoTranslateQueue.includes(surface)) return
    
    autoTranslateQueue.push(surface)
    processAutoTranslateQueue()
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "AUTO_TRANSLATE_TOGGLE") {
        autoTranslateEnabled = message.enabled
        if (autoTranslateEnabled) {
            startAutoTranslate()
        } else {
            stopAutoTranslate()
        }
    }
    if (message.type === "AUTO_SAVE_IMAGE_TOGGLE") {
        autoSaveImageEnabled = message.enabled
    }
    if (message.type === "BASE64_UPLOAD_TOGGLE") {
        base64UploadEnabled = message.enabled
        console.log("Base64上传模式已", message.enabled ? "开启" : "关闭")
    }
    if (message.type === "API_BASE_UPDATED") {
        API_BASE = message.apiBase || DEFAULT_API_BASE
        TRANSLATE_API_URL = `${API_BASE.replace(/\/+$/, "")}/api/v1/translate/web`
        console.log("API地址已更新:", API_BASE)
        // 如果自动翻译已开启，重新启动以确保使用新API地址
        if (autoTranslateEnabled) {
            stopAutoTranslate()
            startAutoTranslate()
        }
    }
})

const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => handleAddedNode(node))
    })
})

observer.observe(document.body, { childList: true, subtree: true })

init()
loadAutoTranslateState()
