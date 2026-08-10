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

function createHarness() {
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
    fetch: async () => {
      fetchCalls += 1
      const payload = deferredFetch ? await deferredFetch.promise : fetchPayload
      deferredFetch = null
      return {
        json: async () => payload,
        ok: true,
        status: 200,
      }
    },
    queueMicrotask,
    setTimeout(callback) {
      timerId += 1
      timers.set(timerId, callback)
      return timerId
    },
    window: {
      getComputedStyle(node) {
        return {
          borderRadius: "8px",
          borderTopLeftRadius: "8px",
          objectFit: "fill",
          position: node === body ? "static" : "static",
        }
      },
      location: {
        hostname: "example.com",
        protocol: "https:",
      },
    },
  }
  context.globalThis = context

  const source = readFileSync(new URL("../content.js", import.meta.url), "utf8")
  const sourceWithoutBoot = source.replace(/\nconst observer = new MutationObserver[\s\S]*?\ninit\(\)\s*$/, "")
  vm.runInNewContext(
    `${sourceWithoutBoot}\n;globalThis.__contentTest = {
      cleanupSurface,
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
