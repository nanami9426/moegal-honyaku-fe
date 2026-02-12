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

// 处理动态加载图片
const observer = new MutationObserver(() => init())
observer.observe(document.body, { childList: true, subtree: true })

init()
