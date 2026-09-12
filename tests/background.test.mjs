import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

const source = readFileSync(new URL("../background.js", import.meta.url), "utf8")

function harness(injectionFails = false) {
  const calls = []
  let onClick
  vm.runInNewContext(source, {
    chrome: {
      action: {
        onClicked: { addListener: (listener) => { onClick = listener } },
        setPopup: async (options) => calls.push(["setPopup", JSON.parse(JSON.stringify(options))]),
        openPopup: async (options) => calls.push(["openPopup", JSON.parse(JSON.stringify(options))]),
      },
      scripting: {
        executeScript: async (options) => {
          calls.push(["inject", JSON.parse(JSON.stringify(options))])
          if (injectionFails) throw new Error("禁止注入")
        },
      },
    },
    console,
  })
  return { onClick, calls }
}

test("点击扩展图标向当前标签页注入实时面板", async () => {
  const { onClick, calls } = harness()
  await onClick({ id: 12, windowId: 3 })
  assert.deepEqual(calls, [["inject", { target: { tabId: 12 }, files: ["panel-host.js"] }]])
})

test("禁止注入时回退原生弹窗，随后恢复网页面板入口", async () => {
  const { onClick, calls } = harness(true)
  await onClick({ id: 12, windowId: 3 })
  assert.deepEqual(calls.slice(1), [
    ["setPopup", { tabId: 12, popup: "popup.html" }],
    ["openPopup", { windowId: 3 }],
    ["setPopup", { tabId: 12, popup: "" }],
  ])
})
