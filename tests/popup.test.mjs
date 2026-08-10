import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

const popupSource = readFileSync(new URL("../popup.js", import.meta.url), "utf8")
const sourceWithoutInit = popupSource.replace(/\s*void init\(\)\s*$/, "")
const context = {}
vm.runInNewContext(
  `${sourceWithoutInit}\n;globalThis.__popupTest = {
    backgroundStorageBytes,
    deviceValue,
    exportCroppedBackground,
    fitBackgroundExportSize,
    normalizeGpuStatus,
    normalizeUseGpu,
    persistBackground,
    readStoredBackground,
    state,
  };`,
  context,
)

const {
  backgroundStorageBytes,
  deviceValue,
  exportCroppedBackground,
  fitBackgroundExportSize,
  normalizeGpuStatus,
  normalizeUseGpu,
  persistBackground,
  readStoredBackground,
  state,
} = context.__popupTest

test("GPU 选项转换成后端布尔配置", () => {
  assert.equal(normalizeUseGpu(true), true)
  assert.equal(normalizeUseGpu("gpu"), true)
  assert.equal(normalizeUseGpu(false), false)
  assert.equal(normalizeUseGpu("cpu"), false)
  assert.equal(deviceValue(true), "gpu")
  assert.equal(deviceValue(false), "cpu")
})

test("后端回退状态按实际设备展示", () => {
  const status = normalizeGpuStatus(
    {
      device: "cpu",
      message: "GPU 不可用，将自动使用 CPU",
    },
    true,
  )

  assert.equal(status.requested, true)
  assert.equal(status.device, "cpu")
  assert.equal(status.message, "GPU 不可用，将自动使用 CPU")
})

test("popup 包含设备选择与当前设备状态节点", () => {
  const html = readFileSync(new URL("../popup.html", import.meta.url), "utf8")

  assert.match(html, /id="device-select"/)
  assert.match(html, /id="device-tip"/)
  assert.match(html, /id="current-device"/)
})

test("大背景导出尺寸受像素和边长限制", () => {
  const result = fitBackgroundExportSize(8000, 6000)

  assert.ok(Math.max(result.width, result.height) <= 1600)
  assert.ok(result.width * result.height <= 1_600_000)
  assert.ok(backgroundStorageBytes("data:image/webp;base64,AAAA") > 4)
})

test("压缩后仍过大的背景会继续缩小尺寸", () => {
  const canvas = {
    height: 0,
    width: 0,
    getContext() {
      return {
        clearRect() {},
        drawImage() {},
      }
    },
    toDataURL(_type, quality) {
      const encodedLength = Math.round(this.width * this.height * 4 * quality)
      return `data:image/webp;base64,${"x".repeat(encodedLength)}`
    },
  }
  context.document = {
    createElement(name) {
      assert.equal(name, "canvas")
      return canvas
    },
  }
  Object.assign(state.cropper, {
    image: { naturalHeight: 6000, naturalWidth: 8000 },
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    viewportHeight: 6000,
    viewportWidth: 8000,
  })

  const initialSize = fitBackgroundExportSize(8000, 6000)
  const dataUrl = exportCroppedBackground()

  assert.match(dataUrl, /^data:image\/webp/)
  assert.ok(backgroundStorageBytes(dataUrl) <= 3 * 1024 * 1024)
  assert.ok(canvas.width < initialSize.width)
})

test("背景使用扩展本地存储并迁移旧 localStorage 数据", async () => {
  const extensionValues = {}
  const legacyValues = new Map([["popup_custom_background", "data:image/png;base64,legacy"]])
  context.localStorage = {
    getItem(key) {
      return legacyValues.get(key) || null
    },
    removeItem(key) {
      legacyValues.delete(key)
    },
    setItem(key, value) {
      legacyValues.set(key, value)
    },
  }
  context.chrome = {
    runtime: {},
    storage: {
      local: {
        get(defaults, callback) {
          callback({ ...defaults, ...extensionValues })
        },
        remove(key, callback) {
          delete extensionValues[key]
          callback()
        },
        set(values, callback) {
          Object.assign(extensionValues, values)
          callback()
        },
      },
    },
  }

  const migrated = await readStoredBackground()
  assert.equal(migrated, "data:image/png;base64,legacy")
  assert.equal(extensionValues.popup_custom_background, migrated)
  assert.equal(legacyValues.has("popup_custom_background"), false)

  const next = "data:image/webp;base64,next"
  assert.equal(await persistBackground(next), true)
  assert.equal(await readStoredBackground(), next)
})
