import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

const popupSource = readFileSync(new URL("../popup.js", import.meta.url), "utf8")
const sourceWithoutInit = popupSource.replace(/\s*void init\(\)\s*$/, "")

function createNode() {
  const listeners = new Map()
  return {
    value: "",
    textContent: "",
    disabled: false,
    hidden: false,
    options: [],
    classList: { add() {}, remove() {}, toggle() {} },
    set innerHTML(_value) { this.options = [] },
    appendChild(child) { this.options.push(child) },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) || []), listener])
    },
    async change(value) {
      this.value = value
      await Promise.all((listeners.get("change") || []).map((listener) => listener({ target: this })))
    },
  }
}

function config(overrides = {}) {
  return {
    translate_api_type: "custom",
    translate_mode: "parallel",
    use_gpu: false,
    ...overrides,
  }
}

function harness({ conf = config(), update } = {}) {
  const requests = []
  const cache = new Map()
  const context = {
    console: { error() {} },
    document: { createElement: () => createNode() },
    window: { addEventListener() {} },
    localStorage: {
      getItem: (key) => cache.get(key) ?? null,
      setItem: (key, value) => cache.set(key, value),
    },
    ensureTranslationProvider: async (value) => value,
    fetch: async (url, init) => {
      const request = { url, ...init }
      requests.push(request)
      if (url.endsWith("/conf/options")) {
        return { ok: true, json: async () => ({ translate_mode: ["parallel", "structured"] }) }
      }
      if (url.endsWith("/conf/query")) return { ok: true, json: async () => conf }
      assert.equal(url, "http://127.0.0.1:8000/conf/update")
      const { attr, v } = JSON.parse(init.body)
      return update ? update(request) : { ok: true, json: async () => config({ [attr]: v }) }
    },
  }
  // 每例使用独立页面状态，防止缓存、异步请求和事件监听相互影响。
  vm.runInNewContext(
    `${sourceWithoutInit}\n;globalThis.__configTest = { bindEvents, state, syncConfig, view };`,
    context,
  )
  const api = context.__configTest
  Object.keys(api.view).forEach((key) => { api.view[key] = createNode() })
  api.bindEvents()
  return { ...api, cache, requests }
}

function cachedConfig(cache) {
  return JSON.parse(cache.get("popup_last_translate_conf"))
}

test("同步配置展示当前翻译模式和实际计算设备并缓存", async () => {
  const conf = config({ translate_mode: "structured", use_gpu: true, gpu_status: { device: "cpu", message: "GPU 不可用，将自动使用 CPU" } })
  const { syncConfig, state, view, cache } = harness({ conf })
  await syncConfig()

  assert.equal(state.current.translate_mode, "structured")
  assert.equal(view.modeSelect.value, "structured")
  assert.deepEqual(view.modeSelect.options.map((item) => item.value), ["parallel", "structured"])
  assert.equal(view.currentMode.textContent, "structured")
  assert.equal(view.deviceSelect.value, "gpu")
  assert.equal(view.currentDevice.textContent, "CPU")
  assert.match(view.errorTip.textContent, /GPU 不可用/)
  assert.deepEqual(cachedConfig(cache), config({ translate_mode: "structured", use_gpu: true }))
})

test("选择翻译模式发送配置更新并以服务端返回值为准", async () => {
  const { syncConfig, state, view, requests, cache } = harness({
    // 服务端可以纠正请求，页面和缓存必须使用确认后的配置。
    update: async () => ({ ok: true, json: async () => config() }),
  })
  await syncConfig()
  await view.modeSelect.change("structured")

  const updates = requests.filter((item) => item.url.endsWith("/conf/update"))
  assert.equal(updates.length, 1)
  assert.equal(updates[0].method, "POST")
  assert.equal(updates[0].headers["Content-Type"], "application/json")
  assert.deepEqual(JSON.parse(updates[0].body), { attr: "translate_mode", v: "structured" })
  assert.equal(state.current.translate_mode, "parallel")
  assert.equal(view.modeSelect.value, "parallel")
  assert.equal(view.currentMode.textContent, "parallel")
  assert.equal(cachedConfig(cache).translate_mode, "parallel")
  assert.equal(view.modeSelect.disabled, false)
})

test("保存翻译模式成功后更新当前模式和本地缓存", async () => {
  const { syncConfig, state, view, cache } = harness()
  await syncConfig()
  await view.modeSelect.change("structured")

  assert.equal(state.current.translate_mode, "structured")
  assert.equal(view.modeSelect.value, "structured")
  assert.equal(view.currentMode.textContent, "structured")
  assert.equal(cachedConfig(cache).translate_mode, "structured")
  assert.equal(view.modeSelect.disabled, false)
})

test("保存请求期间禁用选择，失败回滚并恢复操作", async () => {
  let resolveUpdate
  const { syncConfig, state, view, cache } = harness({
    update: () => new Promise((resolve) => { resolveUpdate = resolve }),
  })
  await syncConfig()
  const saving = view.modeSelect.change("structured")
  for (const select of [view.providerSelect, view.modeSelect, view.directionSelect, view.deviceSelect]) {
    assert.equal(select.disabled, true)
  }
  assert.equal(view.reloadButton.disabled, true)

  resolveUpdate({ ok: false, status: 500, json: async () => ({ detail: "配置保存失败" }) })
  await saving

  assert.equal(state.current.translate_mode, "parallel")
  assert.equal(view.modeSelect.value, "parallel")
  assert.equal(cachedConfig(cache).translate_mode, "parallel")
  for (const select of [view.providerSelect, view.modeSelect, view.directionSelect, view.deviceSelect]) {
    assert.equal(select.disabled, false)
  }
  assert.equal(view.reloadButton.disabled, false)
  assert.match(view.errorTip.textContent, /配置保存失败/)
  assert.equal(view.errorTip.hidden, false)
})
