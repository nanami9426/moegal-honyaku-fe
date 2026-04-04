// Background script for handling cross-origin image fetching

// 存储当前需要修改 referer 的请求
let refererMap = new Map()
let ruleIdCounter = 1

// 初始化时清除所有动态规则
async function clearAllDynamicRules() {
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules()
    const ruleIds = existingRules.map(rule => rule.id)
    if (ruleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ruleIds })
    }
  } catch (e) {
    console.error("Clear rules error:", e)
  }
}

clearAllDynamicRules()

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_IMAGE") {
    fetchImageAsBase64(message.url, message.referer)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message }))
    return true // Keep the message channel open for async response
  }
})

async function fetchImageAsBase64(url, referer) {
  // 检查是否是 Pixiv 图片
  const isPixivImage = url.includes('pximg.net') || url.includes('pixiv.net')
  
  let ruleId = null
  
  if (isPixivImage && referer) {
    // 添加动态规则来修改请求头
    ruleId = ruleIdCounter++
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [{
          id: ruleId,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              {
                header: "Referer",
                operation: "set",
                value: referer
              }
            ]
          },
          condition: {
            urlFilter: url,
            resourceTypes: ["image", "xmlhttprequest", "other"]
          }
        }]
      })
    } catch (e) {
      console.error("Add rule error:", e)
    }
  }

  try {
    const headers = {
      "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    if (referer) {
      headers["Referer"] = referer
    }
    
    const response = await fetch(url, {
      credentials: "omit",
      headers: headers,
    })
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    
    const blob = await response.blob()
    
    // Convert to PNG format using createImageBitmap (works in service worker)
    const imageBitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height)
    const ctx = canvas.getContext("2d")
    ctx.drawImage(imageBitmap, 0, 0)
    
    const pngBlob = await canvas.convertToBlob({ type: "image/png" })
    
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve({ base64: reader.result })
      reader.onerror = () => reject(new Error("Failed to read PNG blob"))
      reader.readAsDataURL(pngBlob)
    })
  } catch (error) {
    throw error
  } finally {
    // 清理规则
    if (ruleId !== null) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [ruleId]
        })
      } catch (e) {}
    }
  }
}