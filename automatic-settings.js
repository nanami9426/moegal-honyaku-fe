async function initAutomaticSettings() {
  const toggle = document.getElementById("auto-translate-toggle")
  const status = document.getElementById("auto-translate-status")
  const syncStatus = () => { status.textContent = toggle.checked ? "开启" : "关闭" }
  let origin
  try {
    origin = (await chrome.runtime.sendMessage({ type: "moegal-auto-site" }))?.origin
  } catch (_) { /* 禁止注入的页面也能打开设置，但不能启用本站翻译。 */ }
  if (!origin) {
    toggle.disabled = true
    toggle.title = "当前页面不支持自动翻译"
    return
  }
  const key = `auto_translate_site:${origin}`
  const read = () => new Promise((resolve, reject) => {
    chrome.storage.local.get({ [key]: false }, (values) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve(values[key] === true)
    })
  })
  try {
    toggle.checked = await read()
    syncStatus()
    toggle.disabled = false
  } catch (_) {
    toggle.title = "读取自动翻译设置失败，请重新打开面板。"
    return
  }
  toggle.addEventListener("change", async () => {
    const enabled = toggle.checked
    toggle.disabled = true
    try {
      await new Promise((resolve, reject) => {
        chrome.storage.local.set({ [key]: enabled }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
          else resolve()
        })
      })
      toggle.title = ""
    } catch (_) {
      toggle.checked = !enabled
      toggle.title = "保存失败，请重试。"
    } finally {
      syncStatus()
      toggle.disabled = false
    }
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[key]) {
      toggle.checked = changes[key].newValue === true
      syncStatus()
    }
  })
}

void initAutomaticSettings()
