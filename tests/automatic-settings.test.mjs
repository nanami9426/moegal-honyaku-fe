import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

const source = readFileSync(new URL("../automatic-settings.js", import.meta.url), "utf8")
  .replace(/\s*void initAutomaticSettings\(\)\s*$/, "")

async function harness(origin = "https://manga.example", enabled = false) {
  const nodes = new Map()
  const values = { [`auto_translate_site:${origin}`]: enabled }
  const runtime = { sendMessage: async () => ({ origin }) }
  let changeStorage
  let failWrite = false
  const context = {
    URL,
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, { disabled: true, checked: false, textContent: "", addEventListener(type, listener) { this[type] = listener } })
        return nodes.get(id)
      },
    },
    chrome: {
      runtime,
      storage: {
        local: {
          get(defaults, callback) { callback({ ...defaults, ...values }) },
          set(update, callback) {
            if (failWrite) runtime.lastError = { message: "storage error" }
            else Object.assign(values, update)
            callback()
            delete runtime.lastError
          },
        },
        onChanged: { addListener(listener) { changeStorage = listener } },
      },
    },
  }
  vm.runInNewContext(source, context)
  await context.initAutomaticSettings()
  return { nodes, values, failWrite() { failWrite = true }, changeStorage }
}

test("默认关闭且只保存当前站点，刷新可恢复开启状态", async () => {
  const h = await harness()
  const toggle = h.nodes.get("auto-translate-toggle")
  assert.equal(toggle.checked, false)
  assert.equal(toggle.disabled, false)
  assert.equal(h.nodes.get("auto-translate-status").textContent, "关闭")
  toggle.checked = true
  await toggle.change()
  assert.deepEqual(h.values, { "auto_translate_site:https://manga.example": true })
  assert.equal(h.nodes.get("auto-translate-status").textContent, "开启")
  const reopened = await harness("https://manga.example", true)
  assert.equal(reopened.nodes.get("auto-translate-toggle").checked, true)
})

test("不支持的页面禁用开关，保存失败回滚", async () => {
  const unsupported = await harness(null)
  assert.equal(unsupported.nodes.get("auto-translate-toggle").disabled, true)
  const h = await harness()
  h.failWrite()
  const toggle = h.nodes.get("auto-translate-toggle")
  toggle.checked = true
  await toggle.change()
  assert.equal(toggle.checked, false)
  assert.equal(h.nodes.get("auto-translate-status").textContent, "关闭")
  assert.match(toggle.title, /保存失败/)
})

test("其他面板修改同一站点开关时同步显示", async () => {
  const h = await harness()
  h.changeStorage({ "auto_translate_site:https://manga.example": { newValue: true } }, "local")
  assert.equal(h.nodes.get("auto-translate-toggle").checked, true)
  assert.equal(h.nodes.get("auto-translate-status").textContent, "开启")
})
