const EXCLUDED_IMAGE_KEYWORDS = /(avatar|icon|logo|emoji|emoticon|sprite|thumb|thumbnail|favicon|profile|userpic|badge)/i
const COMIC_IMAGE_HINT_KEYWORDS = /(comic|manga|manhua|manhwa|chapter|panel|page|raw)/i
const CANVAS_INCLUDE_KEYWORDS = /(page|contents|reader|comic|manga|chapter|panel|slide)/i
const CANVAS_EXCLUDE_KEYWORDS = /(chart|graph|avatar|icon|logo|video|editor|signature|captcha)/i
const TRANSLATE_API_URL = "http://127.0.0.1:8000/api/v1/translate/web"
const TEXT_DIRECTION_STORAGE_KEY = "translate_text_direction"
const DEFAULT_TEXT_DIRECTION = "horizontal"
const TEXT_DIRECTION_OPTIONS = ["horizontal", "vertical"]

const MIN_RENDERED_WIDTH = 160
const MIN_RENDERED_HEIGHT = 160
const MIN_RENDERED_AREA = 42000
const MIN_NATURAL_WIDTH = 260
const MIN_NATURAL_HEIGHT = 260
const MIN_ASPECT_RATIO = 0.28
const MAX_ASPECT_RATIO = 3.5

const BUTTON_HIDE_DELAY = 800
const BUTTON_RESET_DELAY = 2000
const TRANSLATION_SUCCESS_DELAY = 900
const TOP_LAYER_Z_INDEX = 2147483647
const ORIGINAL_VIEW = "original"
const TRANSLATED_VIEW = "translated"

const surfaceButtons = new WeakMap()
const translationOverlays = new WeakMap()
const positionedContainers = new WeakMap()
let buttonLayerRoot = null
const translationRequests = new Map()
const translationResults = new Map()
let translationResultBytes = 0
let providerCheck = null
let providerCheckedAt = 0
let translationConfigVersion = 0

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
        if (getSurfaceSourceUrl(surface) !== (surface.currentSrc || surface.src || "")) {
            return { width: rect.width, height: rect.height }
        }
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
    const src = decodeSafe(getSurfaceSourceUrl(img).toLowerCase())
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

function ensureButtonLayerRoot() {
    if (!buttonLayerRoot || !buttonLayerRoot.isConnected) {
        const root = document.createElement("div")
        root.className = "moegal-translate-button-layer"
        root.style.setProperty("display", "block", "important")
        root.style.setProperty("position", "fixed", "important")
        root.style.setProperty("top", "0", "important")
        root.style.setProperty("left", "0", "important")
        root.style.setProperty("width", "100vw", "important")
        root.style.setProperty("height", "100vh", "important")
        root.style.setProperty("overflow", "visible", "important")
        root.style.setProperty("pointer-events", "none", "important")
        root.style.setProperty("isolation", "isolate", "important")
        root.style.setProperty("z-index", String(TOP_LAYER_Z_INDEX), "important")
        const mountTarget = document.body || document.documentElement
        mountTarget.appendChild(root)
        buttonLayerRoot = root
    }

    const parent = buttonLayerRoot.parentElement
    if (parent && parent.lastElementChild !== buttonLayerRoot) {
        parent.appendChild(buttonLayerRoot)
    }

    return buttonLayerRoot
}

function getIdleButtonText(state) {
    if (state?.autoQueued) return "等待翻译"
    if (state?.autoStatus === "skipped") return "无气泡，点击重试"
    if (!state?.translatedDataUrl) return "翻译图片"
    return state.view === TRANSLATED_VIEW ? "查看原图" : "查看译图"
}

function syncButtonAccessibility(state) {
    if (!state?.button) return
    const text = getIdleButtonText(state)
    state.button.title = text
    state.button.setAttribute("aria-label", text)
    state.button.setAttribute("aria-pressed", String(state.view === TRANSLATED_VIEW))
}

function setIdleButtonState(state) {
    if (!state?.button || state.destroyed) return
    state.button.textContent = getIdleButtonText(state)
    syncButtonAccessibility(state)
}

function scheduleButtonReset(state, delay = BUTTON_RESET_DELAY) {
    if (state?.destroyed) return
    if (state.resetTimeout) {
        clearTimeout(state.resetTimeout)
    }
    state.resetTimeout = setTimeout(() => {
        setIdleButtonState(state)
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
    state.button.title = text
    state.button.setAttribute("aria-label", text)
    scheduleButtonReset(state, delay)
}

function buildRefererBaseUrl() {
    return window.location.origin || `${window.location.protocol}//${window.location.hostname}`
}

function parseResponseError(result, response) {
    return (
        result?.detail ||
        result?.info ||
        result?.message ||
        `请求失败 (${response.status})`
    )
}

function isMissingProviderConfigMessage(message) {
    const text = typeof message === "string" ? message : String(message || "")
    return /未配置|CUSTOM_API_KEY|DASHSCOPE_API_KEY|后端\s*\.env/i.test(text)
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

function normalizeTextDirection(value) {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : ""
    return TEXT_DIRECTION_OPTIONS.includes(normalized) ? normalized : DEFAULT_TEXT_DIRECTION
}

async function readStoredTextDirection() {
    const storage = globalThis.chrome?.storage?.local
    if (!storage) return DEFAULT_TEXT_DIRECTION

    return new Promise((resolve) => {
        storage.get({ [TEXT_DIRECTION_STORAGE_KEY]: DEFAULT_TEXT_DIRECTION }, (result) => {
            if (globalThis.chrome?.runtime?.lastError) {
                console.error("读取文字方向失败:", globalThis.chrome.runtime.lastError)
                resolve(DEFAULT_TEXT_DIRECTION)
                return
            }
            resolve(normalizeTextDirection(result?.[TEXT_DIRECTION_STORAGE_KEY]))
        })
    })
}

async function getTranslatePayload(surface) {
    const referer = buildRefererBaseUrl()
    const textDirection = await readStoredTextDirection()
    if (surface instanceof HTMLImageElement) {
        return {
            image_url: getSurfaceSourceUrl(surface),
            referer,
            source_type: "img",
            text_direction: textDirection,
        }
    }

    if (surface instanceof HTMLCanvasElement) {
        return {
            image_base64: getCanvasImageBase64(surface),
            referer,
            source_type: "canvas",
            text_direction: textDirection,
        }
    }

    throw new Error("暂不支持该类型")
}

function getTranslationOverlayContainer(surface) {
    if (surface.parentElement) return surface.parentElement
    throw new Error("无法定位图片容器")
}

function retainPositionedContainer(container) {
    const existing = positionedContainers.get(container)
    if (existing) {
        existing.count += 1
        return
    }

    const computedStyle = window.getComputedStyle(container)
    const originalInlinePosition = container.style.position
    const changed = computedStyle.position === "static"
    if (changed) {
        container.style.position = "relative"
    }
    positionedContainers.set(container, {
        count: 1,
        changed,
        originalInlinePosition,
    })
}

function releasePositionedContainer(container) {
    const record = positionedContainers.get(container)
    if (!record) return
    record.count -= 1
    if (record.count > 0) return

    if (record.changed && container.style.position === "relative") {
        container.style.position = record.originalInlinePosition
    }
    positionedContainers.delete(container)
}

function getSurfaceSourceUrl(surface) {
    let source = surface.currentSrc || surface.src || ""
    // 常见懒加载把真实地址放在 data-* 中；提前请求它，不改动网页原来的 src。
    if (!source || !surface.naturalWidth || surface.naturalWidth < MIN_NATURAL_WIDTH) {
        const lazy = surface.getAttribute("data-src") || surface.getAttribute("data-original")
            || surface.getAttribute("data-lazy-src")
        if (lazy) {
            try { source = new URL(lazy, document.baseURI || window.location.href).href } catch (_) { /* 等页面填入合法地址。 */ }
        }
    }
    return source
}

function getSurfaceSourceSignature(surface) {
    if (surface instanceof HTMLImageElement) {
        // 加载完成后 naturalWidth 的变化不代表换图，实际图片地址才决定结果是否过期。
        return `img:${getSurfaceSourceUrl(surface)}`
    }
    if (surface instanceof HTMLCanvasElement) {
        return `canvas:${surface.width || 0}x${surface.height || 0}`
    }
    return ""
}

function hasSurfaceSourceChanged(state) {
    return Boolean(
        state?.translatedDataUrl &&
        state.sourceSignature &&
        getSurfaceSourceSignature(state.surface) !== state.sourceSignature
    )
}

function syncTranslationOverlayBounds(overlayState) {
    const { surface, container, overlay } = overlayState
    if (!overlay.isConnected || !surface.isConnected || !container.isConnected) return

    const surfaceRect = surface.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    overlay.style.left = `${surfaceRect.left - containerRect.left + container.scrollLeft - (container.clientLeft || 0)}px`
    overlay.style.top = `${surfaceRect.top - containerRect.top + container.scrollTop - (container.clientTop || 0)}px`
    overlay.style.width = `${surfaceRect.width}px`
    overlay.style.height = `${surfaceRect.height}px`

    const surfaceStyle = window.getComputedStyle(surface)
    overlay.style.borderRadius = surfaceStyle.borderRadius || "0px"
    overlayState.image.style.objectFit = surface instanceof HTMLImageElement
        ? (surfaceStyle.objectFit || "fill")
        : "fill"
    overlayState.image.style.objectPosition = surface instanceof HTMLImageElement
        ? (surfaceStyle.objectPosition || "50% 50%")
        : "50% 50%"
}

function removeTranslationOverlay(surface) {
    const overlayState = translationOverlays.get(surface)
    if (!overlayState) return
    overlayState.cancelImageLoad?.()
    overlayState.resizeObserver?.disconnect()
    overlayState.image.onload = null
    overlayState.image.onerror = null
    overlayState.overlay.remove()
    releasePositionedContainer(overlayState.container)
    translationOverlays.delete(surface)
}

function clearTranslatedResult(state) {
    if (!state) return
    state.translatedDataUrl = null
    state.sourceSignature = ""
    state.view = ORIGINAL_VIEW

    const overlayState = translationOverlays.get(state.surface)
    if (overlayState) {
        overlayState.overlay.classList.remove("is-visible")
        overlayState.cancelImageLoad?.()
        overlayState.image.onload = null
        overlayState.image.onerror = null
        overlayState.image.removeAttribute("src")
    }
    setIdleButtonState(state)
}

function invalidateTranslatedResult(state) {
    if (!state?.translatedDataUrl) return false
    clearTranslatedResult(state)
    return true
}

function ensureTranslationOverlay(surface, buttonState) {
    const container = getTranslationOverlayContainer(surface)
    const existing = translationOverlays.get(surface)
    if (existing && existing.overlay.isConnected && existing.container === container) {
        existing.buttonState = buttonState
        syncTranslationOverlayBounds(existing)
        return existing
    }

    if (existing) {
        removeTranslationOverlay(surface)
    }

    retainPositionedContainer(container)

    const overlay = document.createElement("div")
    overlay.className = "moegal-translate-overlay"
    overlay.setAttribute("aria-hidden", "true")

    const image = document.createElement("img")
    image.className = "moegal-translate-overlay-image"
    image.alt = ""
    image.draggable = false
    overlay.appendChild(image)
    container.appendChild(overlay)

    const overlayState = {
        surface,
        container,
        overlay,
        image,
        buttonState,
        resizeObserver: null,
        cancelImageLoad: null,
    }

    if (typeof ResizeObserver === "function") {
        overlayState.resizeObserver = new ResizeObserver(() => {
            if (hasSurfaceSourceChanged(overlayState.buttonState)) {
                invalidateTranslatedResult(overlayState.buttonState)
            }
            syncTranslationOverlayBounds(overlayState)
        })
        overlayState.resizeObserver.observe(container)
        overlayState.resizeObserver.observe(surface)
    }

    translationOverlays.set(surface, overlayState)
    syncTranslationOverlayBounds(overlayState)
    return overlayState
}

function loadTranslatedOverlayImage(overlayState, translatedDataUrl) {
    overlayState.cancelImageLoad?.()
    return new Promise((resolve, reject) => {
        const { image } = overlayState
        let settled = false
        const finish = (callback, value) => {
            if (settled) return
            settled = true
            image.onload = null
            image.onerror = null
            overlayState.cancelImageLoad = null
            callback(value)
        }
        overlayState.cancelImageLoad = () => {
            finish(reject, new Error("翻译已取消"))
        }
        image.onload = () => {
            finish(resolve)
        }
        image.onerror = () => {
            image.removeAttribute("src")
            finish(reject, new Error("译图加载失败，请重试"))
        }
        image.src = translatedDataUrl
    })
}

function setTranslatedView(state, view) {
    if (!state?.translatedDataUrl) return false
    const overlayState = translationOverlays.get(state.surface)
    if (!overlayState) return false

    const nextView = view === TRANSLATED_VIEW ? TRANSLATED_VIEW : ORIGINAL_VIEW
    state.view = nextView
    if (nextView === TRANSLATED_VIEW) {
        void overlayState.overlay.offsetWidth
    }
    overlayState.overlay.classList.toggle("is-visible", nextView === TRANSLATED_VIEW)
    syncTranslationOverlayBounds(overlayState)
    setIdleButtonState(state)
    return true
}

function toggleTranslatedView(state) {
    const nextView = state.view === TRANSLATED_VIEW ? ORIGINAL_VIEW : TRANSLATED_VIEW
    return setTranslatedView(state, nextView)
}

async function applyTranslatedResult(state, translatedDataUrl, sourceSignature, canApply = () => true) {
    const overlayState = ensureTranslationOverlay(state.surface, state)
    overlayState.overlay.classList.remove("is-visible")
    await loadTranslatedOverlayImage(overlayState, translatedDataUrl)

    if (state.destroyed || getSurfaceSourceSignature(state.surface) !== sourceSignature || !canApply()) {
        overlayState.image.removeAttribute("src")
        throw new Error("原图已更新，请重新翻译")
    }

    state.translatedDataUrl = translatedDataUrl
    state.sourceSignature = sourceSignature
    return setTranslatedView(state, TRANSLATED_VIEW)
}

function clearTranslationRequestCache() {
    translationConfigVersion += 1
    translationResults.clear()
    translationResultBytes = 0
    providerCheck = null
    providerCheckedAt = 0
}

function rememberTranslation(key, result) {
    const size = (result.res_img?.length || 0) * 2
    if (size > 48 * 1024 * 1024) return
    if (translationResults.has(key)) {
        translationResultBytes -= (translationResults.get(key).res_img?.length || 0) * 2
        translationResults.delete(key)
    }
    while (translationResults.size && (translationResults.size >= 24 || translationResultBytes + size > 48 * 1024 * 1024)) {
        const oldest = translationResults.keys().next().value
        translationResultBytes -= (translationResults.get(oldest).res_img?.length || 0) * 2
        translationResults.delete(oldest)
    }
    translationResults.set(key, result)
    translationResultBytes += size
}

async function checkTranslationProvider() {
    if (!providerCheck || Date.now() - providerCheckedAt > 30000) {
        providerCheckedAt = Date.now()
        const pending = ensureTranslationProvider().catch((error) => {
            if (providerCheck === pending) providerCheck = null
            error.pauseAutomatic = true
            throw error
        })
        providerCheck = pending
    }
    return providerCheck
}

async function requestTranslation(surface, { retry = false } = {}) {
    const payload = await getTranslatePayload(surface)
    const configVersion = translationConfigVersion
    // Canvas 快照可能很大，不把 base64 正文长期保留在缓存键中。
    const cacheable = surface instanceof HTMLImageElement
    const key = cacheable ? JSON.stringify([configVersion, payload]) : surface
    if (retry) payload.force_refresh = true
    if (!retry && translationResults.has(key)) {
        const cached = translationResults.get(key)
        translationResults.delete(key)
        translationResults.set(key, cached)
        return { ...cached, cache_hit: true }
    }
    if (translationRequests.has(key)) return translationRequests.get(key)
    const pending = (async () => {
        await checkTranslationProvider()
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 180000)
        let response
        let result = null
        try {
            response = await fetch(TRANSLATE_API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: controller.signal,
            })
            try { result = await response.json() } catch (_) { /* 下方统一报告无效响应。 */ }
        } catch (error) {
            error.pauseAutomatic = true
            throw error
        } finally {
            clearTimeout(timeout)
        }
        if (!response.ok) {
            const error = new Error(parseResponseError(result, response))
            error.pauseAutomatic = [401, 403, 429, 503].includes(response.status)
                || result?.code === "MISSING_TRANSLATE_CONFIG"
            throw error
        }
        logTranslateResult(result)
        // 兼容旧后端的“未检测出文字”，正常跳过不进入失败重试。
        if (result?.code === "NO_TEXT_BUBBLES" || /未检测出文字/.test(result?.info || "")) {
            result = { ...result, status: "skipped", code: "NO_TEXT_BUBBLES" }
        } else if (result?.status !== "success") {
            throw new Error(result?.info || "error")
        }
        if (cacheable && configVersion === translationConfigVersion && (result.status === "skipped" || result.res_img)) {
            rememberTranslation(key, result)
        }
        return result
    })()
    translationRequests.set(key, pending)
    try { return await pending } finally { translationRequests.delete(key) }
}

function syncSurfaceSource(state) {
    const source = getSurfaceSourceSignature(state.surface)
    if (source === state.knownSource) return false
    state.knownSource = source
    state.requestVersion += 1
    state.autoStatus = "idle"
    state.manualOriginal = false
    invalidateTranslatedResult(state)
    return true
}

async function translateSurface(state, { automatic = false, epoch = autoTranslation.epoch } = {}) {
    const { surface, button } = state
    if (state.isTranslating || state.destroyed) return
    syncSurfaceSource(state)
    if (!automatic && state.translatedDataUrl) {
        toggleTranslatedView(state)
        state.manualOriginal = state.view === ORIGINAL_VIEW
        return
    }
    if (!isTranslatableSurface(surface)) {
        if (!automatic) setButtonMessage(state, "仅支持漫画图", 1200)
        return
    }
    const retry = !automatic && ["skipped", "failed"].includes(state.autoStatus)
    state.isTranslating = true
    state.autoQueued = false
    state.autoStatus = "running"
    state.wasAutomatic = automatic
    state.requestVersion += 1
    const requestVersion = state.requestVersion
    const sourceSignature = getSurfaceSourceSignature(surface)
    const isCurrent = () => !state.destroyed && requestVersion === state.requestVersion
        && getSurfaceSourceSignature(surface) === sourceSignature
    const mayApply = () => isCurrent() && (!automatic || (autoTranslation.enabled && epoch === autoTranslation.epoch))
    if (!automatic) autoTranslation.manualActive += 1
    if (state.resetTimeout) clearTimeout(state.resetTimeout)
    state.resetTimeout = 0
    button.textContent = "处理中..."
    button.title = button.textContent
    button.setAttribute("aria-label", button.textContent)
    button.setAttribute("aria-busy", "true")
    try {
        const result = await requestTranslation(surface, { retry })
        if (!isCurrent()) return
        if (result.code === "NO_TEXT_BUBBLES") {
            state.autoStatus = "skipped"
            setIdleButtonState(state)
            return
        }
        // 关闭开关或改设置后，已发出的计算允许结束并缓存，但不再自动覆盖画面。
        if (!mayApply()) return
        if (typeof result.res_img !== "string" || !result.res_img.trim()) throw new Error("后端未返回译图，请重试")
        await applyTranslatedResult(state, "data:image/png;base64," + result.res_img, sourceSignature, mayApply)
        state.autoStatus = "complete"
        state.lastResultCached = result.cache_hit || result.coalesced
        button.textContent = "翻译完成"
        button.title = button.textContent
        button.setAttribute("aria-label", button.textContent)
    } catch (error) {
        if (!mayApply()) return
        clearTranslatedResult(state)
        state.autoStatus = "failed"
        console.error("翻译失败:", error)
        const message = error?.message || String(error || "")
        if (isMissingProviderConfigMessage(message)) {
            button.textContent = "请先配置翻译接口"
        } else if (surface instanceof HTMLCanvasElement && isCanvasReadBlockedError(error)) {
            button.textContent = "该页面canvas无法转base64"
        } else if (/structured|格式|数量|不匹配|列表|list/i.test(message)) {
            button.textContent = "请重试/切并行"
        } else {
            button.textContent = "翻译失败，点击重试"
        }
        button.title = message || button.textContent
        button.setAttribute("aria-label", button.textContent)
        if (automatic && (error.pauseAutomatic || isMissingProviderConfigMessage(message))) {
            autoTranslation.paused = isMissingProviderConfigMessage(message) ? "请先配置翻译接口" : "服务不可用或繁忙"
        }
    } finally {
        if (state.autoStatus === "running") state.autoStatus = "idle"
        state.isTranslating = false
        if (!automatic) autoTranslation.manualActive -= 1
        if (!state.destroyed) {
            button.removeAttribute("aria-busy")
            scheduleButtonReset(state, state.translatedDataUrl ? TRANSLATION_SUCCESS_DELAY : BUTTON_RESET_DELAY)
        }
        scheduleAutomaticTranslation()
    }
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
    button.title = "翻译图片"
    button.setAttribute("aria-label", "翻译图片")
    button.setAttribute("aria-pressed", "false")
    button.className = "translate-btn"
    button.style.setProperty("position", "fixed", "important")
    button.style.setProperty("z-index", "1", "important")
    button.style.setProperty("pointer-events", "auto", "important")
    button.style.setProperty("display", "none", "important")
    button.style.setProperty("writing-mode", "horizontal-tb", "important")
    button.style.setProperty("text-orientation", "mixed", "important")
    button.style.setProperty("white-space", "nowrap", "important")
    ensureButtonLayerRoot().appendChild(button)

    const state = {
        surface,
        hoverTarget,
        button,
        hideTimeout: 0,
        resetTimeout: 0,
        isTranslating: false,
        translatedDataUrl: null,
        sourceSignature: "",
        view: ORIGINAL_VIEW,
        requestVersion: 0,
        destroyed: false,
        surfaceLoadHandler: null,
        knownSource: getSurfaceSourceSignature(surface),
        autoStatus: "idle",
        autoQueued: false,
        manualOriginal: false,
        wasAutomatic: false,
    }

    surfaceButtons.set(surface, state)
    registerAutomaticSurface(state)

    const updateButtonPosition = () => {
        const rect = getSurfaceRect(surface)
        button.style.setProperty("top", `${Math.max(0, rect.top + 3)}px`, "important")
        button.style.setProperty("left", `${Math.max(0, rect.left + 3)}px`, "important")
    }

    const showButton = () => {
        clearHideTimer(state)
        syncSurfaceSource(state)
        if (!surface.isConnected || !isTranslatableSurface(surface)) {
            button.style.setProperty("display", "none", "important")
            return
        }
        ensureButtonLayerRoot().appendChild(button)
        updateButtonPosition()
        button.style.setProperty("display", "block", "important")
    }

    const hideButtonWithDelay = () => {
        clearHideTimer(state)
        state.hideTimeout = setTimeout(() => {
            button.style.setProperty("display", "none", "important")
            state.hideTimeout = 0
        }, BUTTON_HIDE_DELAY)
    }

    hoverTarget.addEventListener("mouseenter", showButton)
    hoverTarget.addEventListener("mouseleave", hideButtonWithDelay)
    button.addEventListener("mouseenter", showButton)
    button.addEventListener("mouseleave", hideButtonWithDelay)
    const activateButton = async (event) => {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        await translateSurface(state)
    }

    button.addEventListener("pointerdown", activateButton, true)
    button.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
    }, true)

    if (surface instanceof HTMLImageElement) {
        state.surfaceLoadHandler = () => {
            syncSurfaceSource(state)
            scheduleAutomaticTranslation()
        }
        surface.addEventListener("load", state.surfaceLoadHandler)
    }
}

function init() {
    const surfaces = document.querySelectorAll("img, canvas")
    surfaces.forEach((surface) => createTranslateButton(surface))
}

function handleAddedNode(node) {
    if (!(node instanceof Element)) return

    if (node instanceof HTMLImageElement || node instanceof HTMLCanvasElement) {
        createTranslateButton(node)
    }

    const surfaces = node.querySelectorAll?.("img, canvas")
    surfaces?.forEach((surface) => createTranslateButton(surface))
}

function cleanupSurface(surface) {
    const state = surfaceButtons.get(surface)
    if (!state) {
        removeTranslationOverlay(surface)
        return
    }

    state.destroyed = true
    state.requestVersion += 1
    autoTranslation.surfaces.delete(state)
    autoTranslation.observer?.unobserve(surface)
    clearHideTimer(state)
    if (state.resetTimeout) {
        clearTimeout(state.resetTimeout)
        state.resetTimeout = 0
    }
    if (state.surfaceLoadHandler && surface instanceof HTMLImageElement) {
        surface.removeEventListener("load", state.surfaceLoadHandler)
    }
    state.button.remove()
    removeTranslationOverlay(surface)
    surfaceButtons.delete(surface)
}

function handleRemovedNode(node) {
    if (!(node instanceof Element)) return

    if (node instanceof HTMLImageElement || node instanceof HTMLCanvasElement) {
        cleanupSurface(node)
    }

    const surfaces = node.querySelectorAll?.("img, canvas")
    surfaces?.forEach((surface) => cleanupSurface(surface))
}

function handleSurfaceAttributeChange(node) {
    if (!(node instanceof HTMLImageElement)) return
    const state = surfaceButtons.get(node)
    if (!state) return
    syncSurfaceSource(state)
    scheduleAutomaticTranslation()
}

// 与悬停按钮使用同一入口，避免浏览器沿用旧清单时漏载自动翻译依赖。
// 自动翻译只负责挑选和调度图片；请求、回填及原图切换复用上方逻辑。
const AUTO_TRANSLATE_SITE_PREFIX = "auto_translate_site:"
const AUTO_TRANSLATE_CONCURRENCY = 2
const autoTranslation = {
    enabled: false,
    epoch: 0,
    paused: "",
    surfaces: new Set(),
    active: 0,
    manualActive: 0,
    timer: 0,
    observer: null,
    averageMs: 15000,
    speed: 0,
    direction: 1,
    lastScrollY: 0,
    lastScrollAt: 0,
    lastScrollTarget: null,
}

function autoSiteStorageKey() {
    return AUTO_TRANSLATE_SITE_PREFIX + new URL(window.location.href || buildRefererBaseUrl()).origin
}

function registerAutomaticSurface(state) {
    // Canvas 的同尺寸重绘不能由 DOM 观察器可靠识别，仍保留手动翻译。
    if (!(state.surface instanceof HTMLImageElement)) return
    autoTranslation.surfaces.add(state)
    autoTranslation.observer?.observe(state.surface)
    scheduleAutomaticTranslation()
}

function scheduleAutomaticTranslation() {
    if (!autoTranslation.enabled || autoTranslation.timer) return
    autoTranslation.timer = setTimeout(() => {
        autoTranslation.timer = 0
        pumpAutomaticTranslation()
    }, 120)
}

function automaticWindow() {
    const height = window.innerHeight || 900
    const width = window.innerWidth || 1200
    const items = []
    for (const state of autoTranslation.surfaces) {
        if (state.destroyed || !isTranslatableImage(state.surface)) continue
        const url = getSurfaceSourceUrl(state.surface)
        if (!/^https?:\/\//i.test(url)) continue
        const rect = getSurfaceRect(state.surface)
        if (rect.right <= 0 || rect.left >= width) continue
        items.push({ state, rect })
    }
    const visible = items.filter(({ rect }) => rect.bottom > 0 && rect.top < height)
    const ahead = items.filter(({ rect }) => autoTranslation.direction > 0 ? rect.top >= height : rect.bottom <= 0)
    visible.sort((a, b) => a.rect.top - b.rect.top)
    ahead.sort((a, b) => autoTranslation.direction > 0 ? a.rect.top - b.rect.top : b.rect.bottom - a.rect.bottom)
    const typicalHeight = items.length ? items.reduce((sum, item) => sum + item.rect.height, 0) / items.length : height
    // 预译窗口按阅读速度和实测耗时调整；已完成图片也占窗口位置，避免空闲时跑完整章。
    const count = autoTranslation.speed > 0
        ? Math.max(3, Math.min(8, Math.ceil(autoTranslation.speed * autoTranslation.averageMs / 1000 / typicalHeight) + 2))
        : 4
    return [...visible, ...ahead.slice(0, count)].map(({ state }) => state)
}

function trimAutomaticOverlays(keep) {
    const completed = [...autoTranslation.surfaces].filter((state) => state.wasAutomatic && state.translatedDataUrl)
    let bytes = completed.reduce((sum, state) => sum + state.translatedDataUrl.length * 2, 0)
    let count = completed.length
    for (const state of completed) {
        if (count <= 12 && bytes <= 48 * 1024 * 1024) break
        if (keep.has(state) || state.isTranslating) continue
        bytes -= state.translatedDataUrl.length * 2
        count -= 1
        clearTranslatedResult(state)
        removeTranslationOverlay(state.surface)
        state.autoStatus = "idle"
    }
}

function pumpAutomaticTranslation() {
    for (const state of autoTranslation.surfaces) {
        if (state.autoQueued) {
            state.autoQueued = false
            if (!state.isTranslating) setIdleButtonState(state)
        }
    }
    if (!autoTranslation.enabled || autoTranslation.paused || document.visibilityState === "hidden") {
        return
    }
    const windowStates = automaticWindow()
    for (const state of windowStates) {
        syncSurfaceSource(state)
        if (state.isTranslating || state.translatedDataUrl || state.manualOriginal
            || ["skipped", "failed", "complete"].includes(state.autoStatus)) continue
        state.autoQueued = true
        setIdleButtonState(state)
        if (autoTranslation.active >= AUTO_TRANSLATE_CONCURRENCY || autoTranslation.manualActive) continue
        const epoch = autoTranslation.epoch
        state.autoQueued = false
        autoTranslation.active += 1
        const started = Date.now()
        void translateSurface(state, { automatic: true, epoch }).finally(() => {
            autoTranslation.active -= 1
            if (state.autoStatus === "complete" && !state.lastResultCached) {
                autoTranslation.averageMs = autoTranslation.averageMs * 0.7 + (Date.now() - started) * 0.3
            }
            trimAutomaticOverlays(new Set(automaticWindow()))
            scheduleAutomaticTranslation()
        })
    }
    trimAutomaticOverlays(new Set(windowStates))
}

function setAutomaticTranslation(enabled) {
    autoTranslation.enabled = enabled === true
    autoTranslation.epoch += 1
    autoTranslation.paused = ""
    if (autoTranslation.timer) clearTimeout(autoTranslation.timer)
    autoTranslation.timer = 0
    for (const state of autoTranslation.surfaces) {
        state.autoQueued = false
        if (state.autoStatus === "failed") state.autoStatus = "idle"
        if (!state.isTranslating) setIdleButtonState(state)
    }
    scheduleAutomaticTranslation()
}

function automaticConfigChanged() {
    autoTranslation.epoch += 1
    autoTranslation.paused = ""
    clearTranslationRequestCache()
    for (const state of autoTranslation.surfaces) {
        state.requestVersion += 1
        invalidateTranslatedResult(state)
        // 无气泡不受译文排版影响；其他结果按新配置重新生成。
        if (state.autoStatus !== "skipped") state.autoStatus = "idle"
    }
    scheduleAutomaticTranslation()
}

function initAutomaticTranslation() {
    const storage = globalThis.chrome?.storage
    storage?.local?.get({ [autoSiteStorageKey()]: false }, (values) => {
        if (globalThis.chrome?.runtime?.lastError) return
        setAutomaticTranslation(values[autoSiteStorageKey()])
    })
    storage?.onChanged?.addListener((changes, area) => {
        if (area !== "local") return
        if (changes[autoSiteStorageKey()]) setAutomaticTranslation(changes[autoSiteStorageKey()].newValue)
        if (changes.translate_text_direction || changes.translate_config_revision) automaticConfigChanged()
    })
    if (typeof IntersectionObserver !== "undefined") {
        autoTranslation.observer = new IntersectionObserver(scheduleAutomaticTranslation, { rootMargin: "3000px 0px" })
        for (const state of autoTranslation.surfaces) autoTranslation.observer.observe(state.surface)
    }
    autoTranslation.lastScrollY = window.scrollY || 0
    autoTranslation.lastScrollAt = Date.now()
    window.addEventListener("scroll", (event) => {
        const now = Date.now()
        const target = event.target === document ? window : event.target
        const y = target === window ? (window.scrollY || 0) : (target.scrollTop || 0)
        const delta = autoTranslation.lastScrollTarget === target ? y - autoTranslation.lastScrollY : 0
        autoTranslation.lastScrollTarget = target
        if (Math.abs(delta) > 4) {
            const elapsed = Math.max(100, now - autoTranslation.lastScrollAt)
            autoTranslation.speed = autoTranslation.speed * 0.6 + Math.min(4000, Math.abs(delta) * 1000 / elapsed) * 0.4
            autoTranslation.direction = delta > 0 ? 1 : -1
        }
        autoTranslation.lastScrollY = y
        autoTranslation.lastScrollAt = now
        scheduleAutomaticTranslation()
    }, { passive: true, capture: true })
    window.addEventListener("resize", scheduleAutomaticTranslation)
    document.addEventListener("visibilitychange", scheduleAutomaticTranslation)
}

const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
        if (mutation.type === "attributes") {
            handleSurfaceAttributeChange(mutation.target)
            return
        }
        mutation.addedNodes.forEach((node) => handleAddedNode(node))
        mutation.removedNodes.forEach((node) => handleRemovedNode(node))
    })
})

observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["sizes", "src", "srcset", "data-src", "data-original", "data-lazy-src"],
    childList: true,
    subtree: true,
})

init()
initAutomaticTranslation()
