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
            image_url: surface.currentSrc || surface.src,
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

function getSurfaceSourceSignature(surface) {
    if (surface instanceof HTMLImageElement) {
        const source = surface.currentSrc || ""
        const declaredSource = surface.src || ""
        const sourceSet = surface.srcset || ""
        const sizes = surface.sizes || ""
        return `img:${source}|src:${declaredSource}|srcset:${sourceSet}|sizes:${sizes}|${surface.naturalWidth || 0}x${surface.naturalHeight || 0}`
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

async function applyTranslatedResult(state, translatedDataUrl, sourceSignature) {
    const overlayState = ensureTranslationOverlay(state.surface, state)
    overlayState.overlay.classList.remove("is-visible")
    await loadTranslatedOverlayImage(overlayState, translatedDataUrl)

    if (state.destroyed || getSurfaceSourceSignature(state.surface) !== sourceSignature) {
        overlayState.image.removeAttribute("src")
        throw new Error("原图已更新，请重新翻译")
    }

    state.translatedDataUrl = translatedDataUrl
    state.sourceSignature = sourceSignature
    return setTranslatedView(state, TRANSLATED_VIEW)
}

async function requestTranslation(surface) {
    const payload = await getTranslatePayload(surface)
    const response = await fetch(TRANSLATE_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
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
    }

    surfaceButtons.set(surface, state)

    const updateButtonPosition = () => {
        const rect = getSurfaceRect(surface)
        button.style.setProperty("top", `${Math.max(0, rect.top + 3)}px`, "important")
        button.style.setProperty("left", `${Math.max(0, rect.left + 3)}px`, "important")
    }

    const showButton = () => {
        clearHideTimer(state)
        if (hasSurfaceSourceChanged(state)) {
            invalidateTranslatedResult(state)
        }
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

        if (state.isTranslating) return

        if (hasSurfaceSourceChanged(state)) {
            invalidateTranslatedResult(state)
        }

        if (state.translatedDataUrl) {
            toggleTranslatedView(state)
            return
        }

        if (!isTranslatableSurface(surface)) {
            setButtonMessage(state, "仅支持漫画图", 1200)
            return
        }

        state.isTranslating = true
        state.requestVersion += 1
        const requestVersion = state.requestVersion
        const sourceSignature = getSurfaceSourceSignature(surface)
        if (state.resetTimeout) {
            clearTimeout(state.resetTimeout)
            state.resetTimeout = 0
        }
        button.textContent = "处理中..."
        button.title = "处理中..."
        button.setAttribute("aria-label", "处理中...")
        button.setAttribute("aria-busy", "true")

        try {
            const result = await requestTranslation(surface)
            if (state.destroyed || requestVersion !== state.requestVersion) {
                throw new Error("原图已更新，请重新翻译")
            }
            if (getSurfaceSourceSignature(surface) !== sourceSignature) {
                throw new Error("原图已更新，请重新翻译")
            }
            if (typeof result?.res_img !== "string" || !result.res_img.trim()) {
                throw new Error("后端未返回译图，请重试")
            }
            const translatedDataUrl = "data:image/png;base64," + result.res_img
            await applyTranslatedResult(state, translatedDataUrl, sourceSignature)
            button.textContent = "翻译完成"
            button.title = "翻译完成"
            button.setAttribute("aria-label", "翻译完成")
        } catch (error) {
            clearTranslatedResult(state)
            console.error("翻译失败:", error)
            const errorMessage = error instanceof Error ? error.message : String(error || "")
            if (/原图已更新/i.test(errorMessage)) {
                button.textContent = "原图已更新，请重试"
            } else if (isMissingProviderConfigMessage(errorMessage)) {
                button.textContent = "请先配置翻译接口"
            } else if (surface instanceof HTMLCanvasElement) {
                if (isCanvasReadBlockedError(error)) {
                    button.textContent = "该页面canvas无法转base64"
                } else if (/structured|格式|数量|不匹配|列表|list/i.test(errorMessage)) {
                    button.textContent = "请重试/切并行"
                } else {
                    button.textContent = "翻译失败"
                }
            } else {
                if (/structured|格式|数量|不匹配|列表|list/i.test(errorMessage)) {
                    button.textContent = "请重试/切并行"
                } else {
                    button.textContent = "翻译失败"
                }
            }
            button.title = button.textContent
            button.setAttribute("aria-label", button.textContent)
        }

        scheduleButtonReset(
            state,
            state.translatedDataUrl ? TRANSLATION_SUCCESS_DELAY : BUTTON_RESET_DELAY,
        )
        state.isTranslating = false
        button.removeAttribute("aria-busy")
    }

    button.addEventListener("pointerdown", activateButton, true)
    button.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
    }, true)

    if (surface instanceof HTMLImageElement) {
        state.surfaceLoadHandler = () => {
            if (hasSurfaceSourceChanged(state)) {
                state.requestVersion += 1
                invalidateTranslatedResult(state)
            }
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
    if (!state || !hasSurfaceSourceChanged(state)) return
    state.requestVersion += 1
    invalidateTranslatedResult(state)
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
    attributeFilter: ["sizes", "src", "srcset"],
    childList: true,
    subtree: true,
})

init()
