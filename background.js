chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["panel-host.js"],
    })
  } catch (error) {
    // 浏览器内部页面禁止注入，仍提供原生弹窗访问配置。
    try {
      await chrome.action.setPopup({ tabId: tab.id, popup: "popup.html" })
      await chrome.action.openPopup({ windowId: tab.windowId })
    } catch (popupError) {
      console.error("无法打开配置面板:", popupError)
    } finally {
      await chrome.action.setPopup({ tabId: tab.id, popup: "" })
    }
  }
})

chrome.runtime?.onMessage?.addListener((message, sender, respond) => {
  if (message?.type !== "moegal-auto-site") return
  // 内嵌设置使用自己的所属标签页，避免切换活动标签后把开关保存到别的网站。
  ;(async () => {
    const tab = sender.tab?.id != null
      ? await chrome.tabs.get(sender.tab.id)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
    const url = new URL(tab?.url || "about:blank")
    respond({ origin: ["http:", "https:"].includes(url.protocol) ? url.origin : null })
  })().catch(() => respond({ origin: null }))
  return true
})
