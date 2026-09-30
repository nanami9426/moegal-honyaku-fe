import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

class FakeClassList {
  constructor(owner) {
    this.owner = owner
    this.values = new Set()
  }

  add(...names) {
    names.forEach((name) => this.values.add(name))
  }

  contains(name) {
    return this.values.has(name)
  }

  remove(...names) {
    names.forEach((name) => this.values.delete(name))
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force)
    if (enabled) this.values.add(name)
    else this.values.delete(name)
    return enabled
  }
}

class FakeStyle {
  constructor() {
    this.values = new Map()
    this.position = ""
  }

  setProperty(name, value) {
    this.values.set(name, value)
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.parentElement = null
    this.isConnected = true
    this.style = new FakeStyle()
    this.classList = new FakeClassList(this)
    this.listeners = new Map()
    this.attributes = new Map()
    this.dataset = {}
    this.id = ""
    this.className = ""
    this.scrollLeft = 0
    this.scrollTop = 0
    this.textContent = ""
    this.title = ""
    this.rect = { bottom: 800, height: 700, left: 20, right: 540, top: 100, width: 520 }
  }

  get lastElementChild() {
    return this.children.at(-1) || null
  }

  get nextElementSibling() {
    if (!this.parentElement) return null
    const index = this.parentElement.children.indexOf(this)
    return this.parentElement.children[index + 1] || null
  }

  get previousElementSibling() {
    if (!this.parentElement) return null
    const index = this.parentElement.children.indexOf(this)
    return index > 0 ? this.parentElement.children[index - 1] : null
  }

  addEventListener(type, listener) {
    const values = this.listeners.get(type) || []
    values.push(listener)
    this.listeners.set(type, values)
  }

  appendChild(child) {
    if (child.parentElement) {
      const oldIndex = child.parentElement.children.indexOf(child)
      if (oldIndex >= 0) child.parentElement.children.splice(oldIndex, 1)
    }
    child.parentElement = this
    child.isConnected = this.isConnected
    this.children.push(child)
    return child
  }

  closest(selector) {
    if (selector !== ".moegal-translate-overlay") return null
    let current = this
    while (current) {
      if (current.className === "moegal-translate-overlay") return current
      current = current.parentElement
    }
    return null
  }

  getAttribute(name) {
    return this.attributes.get(name) || null
  }

  getBoundingClientRect() {
    return { ...this.rect }
  }

  querySelectorAll(selector) {
    if (selector !== "img, canvas") return []
    const result = []
    const visit = (node) => {
      node.children.forEach((child) => {
        if (child instanceof FakeImage || child instanceof FakeCanvas) result.push(child)
        visit(child)
      })
    }
    visit(this)
    return result
  }

  remove() {
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this)
      if (index >= 0) this.parentElement.children.splice(index, 1)
    }
    this.parentElement = null
    this.isConnected = false
  }

  removeAttribute(name) {
    this.attributes.delete(name)
    if (name === "src") this._src = ""
  }

  removeEventListener(type, listener) {
    const values = this.listeners.get(type) || []
    this.listeners.set(type, values.filter((item) => item !== listener))
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }
}

class FakeImage extends FakeElement {
  constructor(source = "") {
    super("img")
    this._src = source
    this.currentSrc = source
    this.naturalWidth = 1200
    this.naturalHeight = 1800
    this.alt = "manga page"
    this.draggable = true
    this.failNextLoad = false
    this.complete = true
  }

  get src() {
    return this._src
  }

  set src(value) {
    this._src = value
    queueMicrotask(() => {
      if (this.failNextLoad) {
        this.failNextLoad = false
        this.onerror?.(new Error("load failed"))
      } else {
        this.onload?.()
      }
    })
  }
}

class FakeCanvas extends FakeElement {
  constructor() {
    super("canvas")
    this.width = 1200
    this.height = 1800
    this.className = "manga-page"
  }

  toDataURL() {
    return "data:image/png;base64,canvas-original"
  }
}

class FakeResizeObserver {
  static instances = []

  constructor(callback) {
    this.callback = callback
    this.disconnected = false
    this.observed = []
    FakeResizeObserver.instances.push(this)
  }

  disconnect() {
    this.disconnected = true
  }

  observe(node) {
    this.observed.push(node)
  }
}

function createHarness({ scripts } = {}) {
  const body = new FakeElement("body")
  body.rect = { bottom: 900, height: 900, left: 0, right: 600, top: 0, width: 600 }
  const timers = new Map()
  let timerId = 0
  let fetchCalls = 0
  let fetchPayload = { res_img: "translated", status: "success" }
  let deferredFetch = null
  let failNextOverlayImage = false

  const document = {
    body,
    documentElement: body,
    baseURI: "https://example.com/chapter/1",
    visibilityState: "visible",
    addEventListener() {},
    createElement(name) {
      if (name === "img") {
        const image = new FakeImage()
        image.failNextLoad = failNextOverlayImage
        failNextOverlayImage = false
        return image
      }
      return new FakeElement(name)
    },
    querySelectorAll() {
      return []
    },
  }

  const context = {
    AbortController,
    Element: FakeElement,
    HTMLCanvasElement: FakeCanvas,
    HTMLImageElement: FakeImage,
    MutationObserver: class {},
    ResizeObserver: FakeResizeObserver,
    URL,
    chrome: {
      runtime: {},
      storage: {
        local: {
          get(defaults, callback) {
            callback(defaults)
          },
        },
      },
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    console: {
      error() {},
      log() {},
    },
    decodeURIComponent,
    document,
    fetch: async (url) => {
      if (url.endsWith("/conf/query")) {
        return {
          ok: true,
          json: async () => ({ translate_api_type: "custom", provider_status: { custom: { configured: true } } }),
        }
      }
      fetchCalls += 1
      const payload = deferredFetch ? await deferredFetch.promise : fetchPayload
      deferredFetch = null
      return {
        json: async () => payload,
        ok: !payload.httpStatus || payload.httpStatus < 400,
        status: payload.httpStatus || 200,
      }
    },
    queueMicrotask,
    setTimeout(callback) {
      timerId += 1
      timers.set(timerId, callback)
      return timerId
    },
    window: {
      innerHeight: 900,
      innerWidth: 1200,
      scrollY: 0,
      addEventListener() {},
      getComputedStyle(node) {
        return {
          borderRadius: "8px",
          borderTopLeftRadius: "8px",
          objectFit: "fill",
          position: node === body ? "static" : "static",
        }
      },
      location: {
        href: "https://example.com/chapter/1",
        origin: "https://example.com",
        hostname: "example.com",
        protocol: "https:",
      },
    },
  }
  context.globalThis = context

  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"))
  const source = (scripts || manifest.content_scripts[0].js)
    .map((file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).join("\n")
  const sourceWithoutBoot = source.replace(/\nconst observer = new MutationObserver[\s\S]*$/, "")
  vm.runInNewContext(
    `${sourceWithoutBoot}\n;globalThis.__contentTest = {
      cleanupSurface,
      autoTranslation,
      automaticWindow,
      automaticConfigChanged,
      pumpAutomaticTranslation,
      setAutomaticTranslation,
      syncSurfaceSource,
      translateSurface,
      getSurfaceSourceUrl,
      handleAddedNode,
      handleSurfaceAttributeChange,
      createTranslateButton,
      getSurfaceSourceSignature,
      handleRemovedNode,
      surfaceButtons,
      translationOverlays,
    };`,
    context,
  )

  const api = context.__contentTest
  return {
    ...api,
    body,
    context,
    flushTimers() {
      const callbacks = [...timers.values()]
      timers.clear()
      callbacks.forEach((callback) => callback())
    },
    get fetchCalls() {
      return fetchCalls
    },
    setFetchPayload(payload) {
      fetchPayload = payload
    },
    failOverlayImageLoad() {
      failNextOverlayImage = true
    },
    async settle() {
      // 排空请求、图片加载及 finally 调度产生的微任务，不靠真实定时等待。
      for (let i = 0; i < 40; i += 1) await Promise.resolve()
    },
    deferFetch() {
      let resolve
      const promise = new Promise((promiseResolve) => {
        resolve = promiseResolve
      })
      deferredFetch = { promise }
      return resolve
    },
  }
}

function eventStub() {
  return {
    preventDefault() {},
    stopImmediatePropagation() {},
    stopPropagation() {},
  }
}

async function activate(state) {
  const listener = state.button.listeners.get("pointerdown")[0]
  await listener(eventStub())
}

test("普通图片保留原 src，并可无限切换且只翻译一次", async () => {
  const harness = createHarness()
  const container = new FakeElement("div")
  container.rect = { bottom: 820, height: 720, left: 10, right: 550, top: 90, width: 540 }
  harness.body.appendChild(container)
  const image = new FakeImage("https://example.com/manga-page.jpg")
  container.appendChild(image)
  harness.createTranslateButton(image)
  const state = harness.surfaceButtons.get(image)

  await activate(state)

  const overlayState = harness.translationOverlays.get(image)
  assert.equal(image.src, "https://example.com/manga-page.jpg")
  assert.equal(image.currentSrc, "https://example.com/manga-page.jpg")
  assert.equal(state.view, "translated")
  assert.equal(overlayState.overlay.classList.contains("is-visible"), true)
  assert.equal(state.button.getAttribute("aria-pressed"), "true")
  assert.equal(harness.fetchCalls, 1)

  await activate(state)
  assert.equal(state.view, "original")
  assert.equal(state.button.textContent, "查看译图")
  assert.equal(overlayState.overlay.classList.contains("is-visible"), false)

  await activate(state)
  assert.equal(state.view, "translated")
  assert.equal(state.button.textContent, "查看原图")
  assert.equal(harness.fetchCalls, 1)
})

test("Canvas 使用同一覆盖层切换并在尺寸变化时失效", async () => {
  const harness = createHarness()
  const container = new FakeElement("div")
  container.className = "comic-reader"
  harness.body.appendChild(container)
  const canvas = new FakeCanvas()
  container.appendChild(canvas)
  harness.createTranslateButton(canvas)
  const state = harness.surfaceButtons.get(canvas)

  await activate(state)
  assert.equal(state.view, "translated")
  assert.equal(harness.fetchCalls, 1)

  canvas.rect.width = 430
  canvas.rect.right = canvas.rect.left + canvas.rect.width
  const overlayState = harness.translationOverlays.get(canvas)
  overlayState.resizeObserver.callback()
  assert.equal(overlayState.overlay.style.width, "430px")

  canvas.width = 1600
  overlayState.resizeObserver.callback()

  assert.equal(state.translatedDataUrl, null)
  assert.equal(state.button.textContent, "翻译图片")
  assert.equal(overlayState.overlay.classList.contains("is-visible"), false)
})

test("图片换源后旧译图失效", async () => {
  const harness = createHarness()
  const container = new FakeElement("div")
  harness.body.appendChild(container)
  const image = new FakeImage("https://example.com/page-1.jpg")
  container.appendChild(image)
  harness.createTranslateButton(image)
  const state = harness.surfaceButtons.get(image)
  await activate(state)

  image._src = "https://example.com/page-2.jpg"
  image.currentSrc = image._src
  state.surfaceLoadHandler()

  assert.equal(state.translatedDataUrl, null)
  assert.equal(state.button.textContent, "翻译图片")
})

test("翻译请求期间图片换源时丢弃过期结果", async () => {
  const harness = createHarness()
  const container = new FakeElement("div")
  harness.body.appendChild(container)
  const image = new FakeImage("https://example.com/pending-1.jpg")
  container.appendChild(image)
  harness.createTranslateButton(image)
  const state = harness.surfaceButtons.get(image)
  const resolveFetch = harness.deferFetch()

  const pending = activate(state)
  image._src = "https://example.com/pending-2.jpg"
  image.currentSrc = image._src
  resolveFetch({ res_img: "stale-translation", status: "success" })
  await pending

  assert.equal(state.translatedDataUrl, null)
  assert.equal(image.src, "https://example.com/pending-2.jpg")
  assert.equal(harness.translationOverlays.has(image), false)
})

test("空译图和译图加载失败时保留原图", async () => {
  const emptyHarness = createHarness()
  const emptyContainer = new FakeElement("div")
  emptyHarness.body.appendChild(emptyContainer)
  const emptyImage = new FakeImage("https://example.com/empty.jpg")
  emptyContainer.appendChild(emptyImage)
  emptyHarness.createTranslateButton(emptyImage)
  const emptyState = emptyHarness.surfaceButtons.get(emptyImage)
  emptyHarness.setFetchPayload({ res_img: "", status: "success" })

  await activate(emptyState)
  assert.equal(emptyImage.src, "https://example.com/empty.jpg")
  assert.equal(emptyState.translatedDataUrl, null)

  const failedHarness = createHarness()
  const failedContainer = new FakeElement("div")
  failedHarness.body.appendChild(failedContainer)
  const failedImage = new FakeImage("https://example.com/failed.jpg")
  failedContainer.appendChild(failedImage)
  failedHarness.failOverlayImageLoad()
  failedHarness.createTranslateButton(failedImage)
  const failedState = failedHarness.surfaceButtons.get(failedImage)

  await activate(failedState)
  assert.equal(failedImage.src, "https://example.com/failed.jpg")
  assert.equal(failedState.translatedDataUrl, null)
})

test("移除图片时清理按钮、覆盖层和 ResizeObserver", async () => {
  const harness = createHarness()
  const container = new FakeElement("div")
  harness.body.appendChild(container)
  const image = new FakeImage("https://example.com/remove.jpg")
  container.appendChild(image)
  harness.createTranslateButton(image)
  const state = harness.surfaceButtons.get(image)
  await activate(state)
  const overlayState = harness.translationOverlays.get(image)

  harness.handleRemovedNode(image)

  assert.equal(state.button.isConnected, false)
  assert.equal(overlayState.overlay.isConnected, false)
  assert.equal(overlayState.resizeObserver.disconnected, true)
  assert.equal(harness.surfaceButtons.has(image), false)
})

test("覆盖层包含顺滑过渡和减少动态效果降级", () => {
  const css = readFileSync(new URL("../inject.css", import.meta.url), "utf8")

  assert.match(css, /opacity 180ms ease/)
  assert.match(css, /\.moegal-translate-overlay\.is-visible/)
  assert.match(css, /pointer-events:\s*none/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
})

function addPage(harness, name, top = 100) {
  const image = new FakeImage(`https://example.com/${name}.jpg`)
  image.rect.top = top
  image.rect.bottom = top + image.rect.height
  harness.body.appendChild(image)
  harness.createTranslateButton(image)
  return harness.surfaceButtons.get(image)
}

test("扩展仍按旧清单加载时，悬停按钮也能显示并手动翻译", async () => {
  // 更新源码后仅刷新网页时，浏览器可能仍使用旧的脚本清单。
  for (const scripts of [
    ["provider.js", "content.js"],
    ["provider.js", "auto-translate.js", "content.js"],
  ]) {
    const h = createHarness({ scripts })
    const state = addPage(h, "legacy-manifest")
    state.surface.listeners.get("mouseenter")[0]()
    assert.equal(state.button.style.values.get("display"), "block")
    await activate(state)
    assert.equal(state.view, "translated")
    assert.equal(h.fetchCalls, 1)
  }
})

test("自动翻译开关及无气泡状态不影响悬停按钮和手动重试", async () => {
  const h = createHarness()
  const state = addPage(h, "hover-page")
  h.setFetchPayload({ status: "skipped", code: "NO_TEXT_BUBBLES" })
  for (const enabled of [false, true, false]) {
    h.setAutomaticTranslation(enabled)
    h.pumpAutomaticTranslation()
    await h.settle()
    state.surface.listeners.get("mouseenter")[0]()
    assert.equal(state.button.style.values.get("display"), "block")
  }
  assert.equal(state.button.textContent, "无气泡，点击重试")
  h.setFetchPayload({ status: "success", res_img: "retried" })
  await activate(state)
  state.surface.listeners.get("mouseleave")[0]()
  state.button.listeners.get("mouseenter")[0]()
  h.flushTimers()
  assert.equal(state.button.style.values.get("display"), "block")
  assert.equal(state.button.textContent, "查看原图")
})

test("自动翻译默认关闭，开启后提前翻译视野外后续图片并限制并发", async () => {
  const h = createHarness()
  const states = Array.from({ length: 10 }, (_, i) => addPage(h, `page-${i}`, 100 + i * 1000))
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(h.fetchCalls, 0)
  const resolve = h.deferFetch()
  h.setAutomaticTranslation(true)
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(h.fetchCalls, 2)
  assert.equal(states[1].isTranslating, true)
  assert.equal(h.autoTranslation.active, 2)
  resolve({ status: "success", res_img: "translated" })
  await h.settle()
  for (let i = 0; i < 4; i += 1) { h.flushTimers(); await h.settle() }
  assert.equal(h.fetchCalls, 5) // 当前一张 + 后续四张，不会把整章全部处理。
  assert.equal(states[4].view, "translated")
  assert.equal(states[5].translatedDataUrl, null)
})

test("无气泡记为跳过，反复滚动不重试，但允许手动重试", async () => {
  const h = createHarness()
  const state = addPage(h, "cover")
  h.setFetchPayload({ status: "skipped", code: "NO_TEXT_BUBBLES" })
  h.setAutomaticTranslation(true)
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(state.autoStatus, "skipped")
  for (let i = 0; i < 4; i += 1) { h.pumpAutomaticTranslation(); await h.settle() }
  assert.equal(h.fetchCalls, 1)
  assert.equal(h.translationOverlays.has(state.surface), false)
  h.setFetchPayload({ status: "success", res_img: "retried" })
  await activate(state)
  assert.equal(h.fetchCalls, 2)
  assert.equal(state.view, "translated")
})

test("旧后端的无文字响应也作为正常跳过", async () => {
  const h = createHarness()
  const state = addPage(h, "blank")
  h.setFetchPayload({ status: "error", info: "未检测出文字" })
  await activate(state)
  assert.equal(state.autoStatus, "skipped")
})

test("手动切回原图后自动队列不改变用户选择", async () => {
  const h = createHarness()
  const state = addPage(h, "read-original")
  h.setAutomaticTranslation(true)
  h.pumpAutomaticTranslation()
  await h.settle()
  await activate(state)
  assert.equal(state.view, "original")
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(state.view, "original")
  assert.equal(h.fetchCalls, 1)
})

test("请求中关闭自动翻译不会回填，重开可复用已完成结果", async () => {
  const h = createHarness()
  const state = addPage(h, "stop-pending")
  const resolve = h.deferFetch()
  h.setAutomaticTranslation(true)
  h.pumpAutomaticTranslation()
  await h.settle()
  h.setAutomaticTranslation(false)
  resolve({ status: "success", res_img: "finished-after-stop" })
  await h.settle()
  assert.equal(state.translatedDataUrl, null)
  assert.equal(h.autoTranslation.active, 0)
  h.setAutomaticTranslation(true)
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(state.view, "translated")
  assert.equal(h.fetchCalls, 1)
})

test("重复图片节点共用请求，随后新增相同图片复用缓存", async () => {
  const h = createHarness()
  const first = addPage(h, "duplicate")
  const second = addPage(h, "duplicate", 1100)
  h.setAutomaticTranslation(true)
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(h.fetchCalls, 1)
  assert.equal(first.view, "translated")
  assert.equal(second.view, "translated")
  const third = addPage(h, "duplicate", 2100)
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(third.view, "translated")
  assert.equal(h.fetchCalls, 1)
})

test("懒加载提前使用真实地址，加载完成不使预译结果失效", async () => {
  const h = createHarness()
  const state = addPage(h, "placeholder", 2100)
  state.surface.naturalWidth = 1
  state.surface.naturalHeight = 1
  state.surface.setAttribute("data-src", "/actual-manga.jpg")
  h.handleSurfaceAttributeChange(state.surface)
  assert.equal(h.getSurfaceSourceUrl(state.surface), "https://example.com/actual-manga.jpg")
  h.setAutomaticTranslation(true)
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(state.view, "translated")
  state.surface.currentSrc = "https://example.com/actual-manga.jpg"
  state.surface.naturalWidth = 1200
  state.surface.naturalHeight = 1800
  state.surfaceLoadHandler()
  assert.equal(state.view, "translated")
  assert.equal(h.fetchCalls, 1)
})

test("跳过的图片换源后重新排队，进行中的旧结果不会覆盖新图片", async () => {
  const h = createHarness()
  const state = addPage(h, "first-source")
  h.setFetchPayload({ code: "NO_TEXT_BUBBLES", status: "skipped" })
  h.setAutomaticTranslation(true)
  h.pumpAutomaticTranslation()
  await h.settle()
  state.surface.currentSrc = "https://example.com/new-source.jpg"
  h.handleSurfaceAttributeChange(state.surface)
  h.setFetchPayload({ status: "success", res_img: "new-image" })
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(h.fetchCalls, 2)
  assert.equal(state.sourceSignature, "img:https://example.com/new-source.jpg")
})

test("配置变更使正在运行的结果失效并重新排队", async () => {
  const h = createHarness()
  const state = addPage(h, "config-change")
  const resolve = h.deferFetch()
  h.setAutomaticTranslation(true)
  h.pumpAutomaticTranslation()
  await h.settle()
  h.automaticConfigChanged()
  resolve({ status: "success", res_img: "old-settings" })
  await h.settle()
  assert.equal(state.translatedDataUrl, null)
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(h.fetchCalls, 2)
  assert.equal(state.view, "translated")
})

test("后台标签页暂停自动调度，恢复可见后继续", async () => {
  const h = createHarness()
  addPage(h, "hidden-page")
  h.context.document.visibilityState = "hidden"
  h.setAutomaticTranslation(true)
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(h.fetchCalls, 0)
  h.context.document.visibilityState = "visible"
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(h.fetchCalls, 1)
})

test("配置错误暂停队列，普通图片失败不阻止后续图片", async () => {
  const h = createHarness()
  addPage(h, "bad-provider")
  h.setAutomaticTranslation(true)
  h.setFetchPayload({ httpStatus: 400, status: "error", code: "MISSING_TRANSLATE_CONFIG", info: "未配置 CUSTOM_API_KEY" })
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.match(h.autoTranslation.paused, /配置/)
  addPage(h, "next", 1100)
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(h.fetchCalls, 1)
  h.setAutomaticTranslation(true)
  h.setFetchPayload({ status: "error", info: "该图片损坏" })
  h.pumpAutomaticTranslation()
  await h.settle()
  assert.equal(h.autoTranslation.paused, "")
  assert.equal(h.fetchCalls, 3)
})

test("快速跳页和反向阅读会重新选择附近图片，Canvas 不自动提交", async () => {
  const h = createHarness()
  const states = Array.from({ length: 12 }, (_, i) => addPage(h, `long-${i}`, (i - 6) * 1000 + 100))
  h.autoTranslation.direction = 1
  assert.equal(h.automaticWindow()[1], states[7])
  h.autoTranslation.direction = -1
  assert.equal(h.automaticWindow()[1], states[5])
  const canvas = new FakeCanvas()
  h.body.appendChild(canvas)
  h.createTranslateButton(canvas)
  assert.equal(h.autoTranslation.surfaces.has(h.surfaceButtons.get(canvas)), false)
})
