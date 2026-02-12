const EXCLUDED_IMAGE_KEYWORDS = /(avatar|icon|logo|emoji|emoticon|sprite|thumb|thumbnail|favicon|profile|userpic|badge)/i
const COMIC_IMAGE_HINT_KEYWORDS = /(comic|manga|manhua|manhwa|chapter|panel|page|raw)/i

const MIN_RENDERED_WIDTH = 160
const MIN_RENDERED_HEIGHT = 160
const MIN_RENDERED_AREA = 42000
const MIN_NATURAL_WIDTH = 260
const MIN_NATURAL_HEIGHT = 260
const MIN_ASPECT_RATIO = 0.28
const MAX_ASPECT_RATIO = 3.5

function decodeSafe(text) {
    try {
        return decodeURIComponent(text)
    } catch (error) {
        return text
    }
}

function getNodeTextForMatch(node) {
    if (!node || !(node instanceof Element)) return ""
    const id = node.id || ""
    const className = typeof node.className === "string" ? node.className : ""
    const ariaLabel = node.getAttribute("aria-label") || ""
    return `${id} ${className} ${ariaLabel}`.toLowerCase()
}

function hasExcludedKeywordAroundImage(img) {
    let current = img
    let depth = 0
    while (current && depth < 4) {
        if (EXCLUDED_IMAGE_KEYWORDS.test(getNodeTextForMatch(current))) {
            return true
        }
        current = current.parentElement
        depth += 1
    }
    return false
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

function isTranslatableImage(img) {
    if (!(img instanceof HTMLImageElement)) return false
    if (!img.isConnected) return false

    const rect = img.getBoundingClientRect()
    if (rect.width < MIN_RENDERED_WIDTH || rect.height < MIN_RENDERED_HEIGHT) return false
    if (rect.width * rect.height < MIN_RENDERED_AREA) return false
    if (rect.bottom <= 0 || rect.right <= 0) return false

    const naturalWidth = img.naturalWidth || rect.width
    const naturalHeight = img.naturalHeight || rect.height
    if (naturalWidth < MIN_NATURAL_WIDTH || naturalHeight < MIN_NATURAL_HEIGHT) return false

    const ratio = naturalWidth / naturalHeight
    if (ratio < MIN_ASPECT_RATIO || ratio > MAX_ASPECT_RATIO) return false

    const src = decodeSafe((img.currentSrc || img.src || "").toLowerCase())
    if (!src) return false
    if (src.startsWith("data:image/svg") || /\.svg(\?|#|$)/i.test(src)) return false
    if (EXCLUDED_IMAGE_KEYWORDS.test(src)) return false

    const alt = (img.alt || "").toLowerCase()
    if (EXCLUDED_IMAGE_KEYWORDS.test(alt)) return false
    if (EXCLUDED_IMAGE_KEYWORDS.test(getNodeTextForMatch(img))) return false
    if (hasExcludedKeywordAroundImage(img)) return false

    // 头像常见特征：圆角接近圆形，且 URL 不包含漫画相关关键词。
    if (isLikelyRoundAvatar(img, rect) && !COMIC_IMAGE_HINT_KEYWORDS.test(src)) return false

    return true
}

function createTranslateButton(img) {
    if (img.dataset.hasButton) return
    const button = document.createElement('button')
    button.textContent = "翻译图片"
    button.className = "translate-btn"
    button.style.position = "absolute"
    button.style.zIndex = 9999
    button.style.display = "none"
    document.body.appendChild(button)
    img.dataset.hasButton = "true"
    const updateButtonPosition = () => {
        const rect = img.getBoundingClientRect()
        button.style.top = `${rect.top + window.scrollY + 3}px`
        button.style.left = `${rect.left + window.scrollX + 3}px`
    }
    let hideTimeout
    const showButton = () => {
        if (!isTranslatableImage(img)) {
            button.style.display = "none"
            return
        }
        updateButtonPosition()
        button.style.display = "block"
        clearTimeout(hideTimeout)
    };
    const hideButtonWithDelay = () => {
        hideTimeout = setTimeout(() => {
            button.style.display = "none"
        }, 200); // 延迟隐藏，给鼠标移到按钮留一点时间
    };
    img.addEventListener('mouseenter', showButton)
    img.addEventListener('mouseleave', hideButtonWithDelay)
    button.addEventListener('mouseenter', showButton)
    button.addEventListener('mouseleave', hideButtonWithDelay)
    button.addEventListener('click', async () => {
        if (!isTranslatableImage(img)) {
            button.textContent = "仅支持漫画图"
            setTimeout(() => {
                button.textContent = "翻译图片"
            }, 1200)
            return
        }
        button.textContent = "处理中..."
        const baseUrl = `${window.location.protocol}//${window.location.hostname}`
        try {
            const imageUrl = img.src
            const response = await fetch("http://127.0.0.1:8000/api/v1/translate/web", {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    image_url: imageUrl,
                    referer: baseUrl
                })
            })
            let result = null
            try {
                result = await response.json()
            } catch (e) {
                result = null
            }
            if (!response.ok) {
                const errorMessage =
                    result?.detail ||
                    result?.info ||
                    result?.message ||
                    `请求失败 (${response.status})`
                throw new Error(errorMessage)
            }
            console.log("-------------------------------------")
            console.log(`耗时：${result.duration}，花费${result.price}`)
            console.log(`原句：${result.raw_text}`)
            console.log(`翻译：${result.cn_text}`)
            console.log("-------------------------------------")
            if (result.status !== "success") {
                throw new Error(result.info || "error")
            }
            img.src = "data:image/png;base64," + result.res_img
            button.textContent = "翻译完成"
        } catch (e) {
            console.error("翻译失败:", e)
            const errorMessage = e?.message || ""
            if (/structured|格式|数量|不匹配|列表|list/i.test(errorMessage)) {
                button.textContent = "请重试/切并行"
            } else {
                button.textContent = "翻译失败"
            }
        }
        setTimeout(() => {
            button.textContent = "翻译图片"
        }, 2000)
    })
}


function getBase64FromImg(img) {
    return new Promise((resolve, reject) => {
        try {
            const canvas = document.createElement('canvas')
            canvas.width = img.naturalWidth
            canvas.height = img.naturalHeight
            const ctx = canvas.getContext('2d')
            ctx.drawImage(img, 0, 0)
            resolve(canvas.toDataURL('image/png'))
        } catch (e) {
            reject(e)
        }
    });
}


function init() {
    const imgs = document.querySelectorAll('img')
    imgs.forEach(img => createTranslateButton(img))
}

function handleAddedNode(node) {
    if (!(node instanceof Element)) return
    if (node.tagName === "IMG") {
        createTranslateButton(node)
    }
    const imgs = node.querySelectorAll?.("img")
    imgs?.forEach((img) => createTranslateButton(img))
}

// 处理动态加载图片
const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => handleAddedNode(node))
    })
})
observer.observe(document.body, { childList: true, subtree: true })

init()
