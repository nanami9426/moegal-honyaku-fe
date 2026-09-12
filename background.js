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
