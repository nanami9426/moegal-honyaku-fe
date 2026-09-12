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

function config(backend = "opencv", status = {}) {
  return {
    translate_api_type: "custom",
    translate_mode: "parallel",
    use_gpu: false,
    inpaint_backend: backend,
    inpaint_status: {
      requested: backend,
      effective_backend: backend,
      available: true,
      model_loaded: backend === "lama",
      message: "",
      ...status,
    },
  }
}

function harness({ conf = config(), options, update } = {}) {
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
        return { ok: true, json: async () => options ?? { inpaint_backend: ["opencv", "lama"] } }
      }
      if (url.endsWith("/conf/query")) return { ok: true, json: async () => conf }
      assert.equal(url, "http://127.0.0.1:8000/conf/update")
      return update ? update(request) : { ok: true, json: async () => config(JSON.parse(init.body).v) }
    },
  }
  // 每例使用独立页面状态，防止缓存、异步请求和事件监听相互影响。
  vm.runInNewContext(
    `${sourceWithoutInit}\n;globalThis.__inpaintTest = {
      bindEvents, normalizeOptions, onConfigChange,
      setLoading, state, syncConfig, view,
    };`,
    context,
  )
  const api = context.__inpaintTest
  Object.keys(api.view).forEach((key) => { api.view[key] = createNode() })
  api.bindEvents()
  return { ...api, cache, requests }
}

function cachedConfig(cache) {
  return JSON.parse(cache.get("popup_last_translate_conf"))
}

test("popup 提供擦除方法选择和当前实际方法状态", () => {
  const html = readFileSync(new URL("../popup.html", import.meta.url), "utf8")
  for (const id of ["inpaint-select", "current-inpaint", "inpaint-tip"]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
})

test("擦除方法选项只包含支持的方法并去重", () => {
  const { normalizeOptions } = harness()
  const result = normalizeOptions({ inpaint_backend: ["lama", "unknown", "opencv", "lama", null, ""] })
  assert.deepEqual(Array.from(result.inpaint_backend), ["lama", "opencv"])
})

test("同步配置渲染后端选择的 LaMa 并缓存", async () => {
  const { syncConfig, state, view, cache } = harness({ conf: config("lama") })
  await syncConfig()

  assert.equal(state.supportsInpaint, true)
  assert.equal(state.current.inpaint_backend, "lama")
  assert.equal(view.inpaintSelect.value, "lama")
  assert.equal(view.inpaintSelect.disabled, false)
  assert.deepEqual(view.inpaintSelect.options.map((item) => item.value), ["opencv", "lama"])
  assert.match(view.currentInpaint.textContent, /LaMa/i)
  assert.equal(cachedConfig(cache).inpaint_backend, "lama")
})

test("选择擦除方法发送真实配置更新并以服务端返回值为准", async () => {
  const { syncConfig, state, view, requests, cache } = harness({
    // 服务端可以纠正请求，页面和缓存必须使用确认后的配置。
    update: async () => ({ ok: true, json: async () => config("opencv") }),
  })
  await syncConfig()
  await view.inpaintSelect.change("lama")

  const updates = requests.filter((item) => item.url.endsWith("/conf/update"))
  assert.equal(updates.length, 1)
  assert.equal(updates[0].method, "POST")
  assert.equal(updates[0].headers["Content-Type"], "application/json")
  assert.deepEqual(JSON.parse(updates[0].body), { attr: "inpaint_backend", v: "lama" })
  assert.equal(state.current.inpaint_backend, "opencv")
  assert.equal(view.inpaintSelect.value, "opencv")
  assert.match(view.currentInpaint.textContent, /OpenCV/i)
  assert.equal(cachedConfig(cache).inpaint_backend, "opencv")
  assert.equal(view.inpaintSelect.disabled, false)
})

test("保存 LaMa 成功后更新当前方法和本地缓存", async () => {
  const { syncConfig, state, view, cache } = harness()
  await syncConfig()
  await view.inpaintSelect.change("lama")

  assert.equal(state.current.inpaint_backend, "lama")
  assert.equal(view.inpaintSelect.value, "lama")
  assert.match(view.currentInpaint.textContent, /LaMa/i)
  assert.equal(cachedConfig(cache).inpaint_backend, "lama")
  assert.equal(view.inpaintSelect.disabled, false)
})

test("保存请求期间禁用选择，失败回滚并恢复操作", async () => {
  let resolveUpdate
  const { syncConfig, state, view, cache } = harness({
    update: () => new Promise((resolve) => { resolveUpdate = resolve }),
  })
  await syncConfig()
  const saving = view.inpaintSelect.change("lama")
  assert.equal(view.inpaintSelect.disabled, true)
  assert.equal(view.reloadButton.disabled, true)

  resolveUpdate({ ok: false, status: 500, json: async () => ({ detail: "擦除配置保存失败" }) })
  await saving

  assert.equal(state.current.inpaint_backend, "opencv")
  assert.equal(view.inpaintSelect.value, "opencv")
  assert.equal(cachedConfig(cache).inpaint_backend, "opencv")
  assert.equal(view.inpaintSelect.disabled, false)
  assert.equal(view.reloadButton.disabled, false)
  assert.match(view.errorTip.textContent, /擦除配置保存失败/)
  assert.equal(view.errorTip.hidden, false)
})

test("LaMa 模型缺失时保留用户选择并显示实际 OpenCV 回退", async () => {
  const message = "LaMa 模型不存在，已回退到 OpenCV"
  const fallback = config("lama", {
    effective_backend: "opencv",
    available: false,
    model_loaded: false,
    message,
  })
  const { syncConfig, state, view, cache } = harness({ conf: fallback })
  await syncConfig()

  assert.equal(state.current.inpaint_backend, "lama")
  assert.equal(view.inpaintSelect.value, "lama")
  assert.equal(cachedConfig(cache).inpaint_backend, "lama")
  assert.equal(state.inpaintStatus.effective_backend, "opencv")
  assert.match(view.currentInpaint.textContent, /OpenCV/i)
  assert.match(view.currentInpaint.textContent, /回退/)
  assert.equal(view.inpaintTip.textContent, "切换后用于下一次翻译。")
  assert.match(view.errorTip.textContent, /LaMa 模型不存在/)
  assert.equal(view.errorTip.hidden, false)
  assert.equal(view.inpaintSelect.disabled, false)
})

test("旧后端缺少擦除配置时禁用控件并阻止不支持的更新", async () => {
  const conf = { translate_api_type: "custom", translate_mode: "parallel", use_gpu: false }
  const { syncConfig, state, view, requests, onConfigChange, setLoading } = harness({ conf, options: {} })
  await syncConfig()

  assert.equal(state.supportsInpaint, false)
  assert.equal(view.inpaintSelect.disabled, true)
  assert.match(view.inpaintTip.textContent, /更新|升级/)
  setLoading(true, "同步中")
  setLoading(false, "")
  assert.equal(view.inpaintSelect.disabled, true)
  await onConfigChange("inpaint_backend", "lama")
  assert.equal(requests.filter((item) => item.url.endsWith("/conf/update")).length, 0)
})
