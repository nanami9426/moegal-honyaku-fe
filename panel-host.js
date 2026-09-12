(() => {
  // 每次点击图标注入一次；复用关闭函数切换面板，避免重复绑定事件。
  if (globalThis.__moegalClosePanel) {
    globalThis.__moegalClosePanel()
    return
  }

  const host = document.createElement("div")
  host.style.cssText = `
    all: initial !important;
    position: fixed !important;
    top: 16px !important;
    right: 16px !important;
    width: min(380px, calc(100vw - 32px)) !important;
    height: min(760px, calc(100dvh - 32px)) !important;
    z-index: 2147483647 !important;
  `
  const root = host.attachShadow({ mode: "closed" })
  const style = document.createElement("style")
  // 模糊必须放在网页这一层，iframe 内的 backdrop-filter 无法采样外部网页。
  style.textContent = `
    .glass {
      width: 100%; height: 100%; overflow: hidden;
      border: 1px solid rgba(255,255,255,.6); border-radius: 16px;
      box-sizing: border-box; background: transparent;
      backdrop-filter: blur(16px) saturate(115%);
      -webkit-backdrop-filter: blur(16px) saturate(115%);
      box-shadow: 0 12px 40px rgba(77,59,57,.18);
    }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
  `
  const glass = document.createElement("div")
  glass.className = "glass"
  const frame = document.createElement("iframe")
  const popupUrl = chrome.runtime.getURL("popup.html")
  frame.src = `${popupUrl}?embedded=1`
  frame.title = "Moegal Honyaku 翻译配置"
  glass.appendChild(frame)
  root.append(style, glass)

  const previousFocus = document.activeElement
  let dragStart = null

  function movePanel(left, top) {
    const rect = host.getBoundingClientRect()
    // 拖动和窗口缩放时都保证面板留在可视区域内。
    const x = Math.max(0, Math.min(left, window.innerWidth - rect.width))
    const y = Math.max(0, Math.min(top, window.innerHeight - rect.height))
    host.style.setProperty("left", `${x}px`, "important")
    host.style.setProperty("top", `${y}px`, "important")
    host.style.setProperty("right", "auto", "important")
  }

  function onResize() {
    const rect = host.getBoundingClientRect()
    movePanel(rect.left, rect.top)
  }

  function closePanel() {
    window.removeEventListener("message", onMessage)
    window.removeEventListener("keydown", onKeyDown, true)
    window.removeEventListener("resize", onResize)
    host.remove()
    delete globalThis.__moegalClosePanel
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  }

  function onMessage(event) {
    if (event.source !== frame.contentWindow || event.origin !== new URL(popupUrl).origin) return
    if (event.data?.type === "moegal-panel-close") closePanel()
    if (event.data?.type === "moegal-panel-drag-end") dragStart = null
    const { type, x, y } = event.data || {}
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    if (type === "moegal-panel-drag-start") {
      const rect = host.getBoundingClientRect()
      dragStart = { x, y, left: rect.left, top: rect.top }
    } else if (type === "moegal-panel-drag-move" && dragStart) {
      movePanel(dragStart.left + x - dragStart.x, dragStart.top + y - dragStart.y)
    }
  }

  function onKeyDown(event) {
    if (event.key === "Escape") closePanel()
  }

  globalThis.__moegalClosePanel = closePanel
  window.addEventListener("message", onMessage)
  window.addEventListener("keydown", onKeyDown, true)
  window.addEventListener("resize", onResize)
  document.documentElement.appendChild(host)
  frame.addEventListener("load", () => frame.focus(), { once: true })
})()
