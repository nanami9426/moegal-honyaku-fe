import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

const source = readFileSync(new URL("../background.js", import.meta.url), "utf8")

function harness(injectionFails = false) {
  const calls = []
  let onClick
  let onMessage
  vm.runInNewContext(source, {
    URL,
    chrome: {
      runtime: { onMessage: { addListener: (listener) => { onMessage = listener } } },
      tabs: {
        get: async (id) => ({ url: id === 99 ? "chrome://extensions" : "https://manga.example/chapter/2" }),
        query: async () => [{ url: "https://active.example/book/1" }],
      },
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
  return { onClick, onMessage, calls }
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

test("站点开关绑定内嵌面板所属标签页，原生弹窗使用活动标签", async () => {
  const { onMessage } = harness()
  for (const [sender, expected] of [
    [{ tab: { id: 12 } }, "https://manga.example"],
    [{}, "https://active.example"],
    [{ tab: { id: 99 } }, null],
  ]) {
    const response = await new Promise((resolve) => {
      assert.equal(onMessage({ type: "moegal-auto-site" }, sender, resolve), true)
    })
    assert.equal(response.origin, expected)
  }
})
