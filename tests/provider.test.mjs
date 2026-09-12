import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

const source = readFileSync(new URL("../provider.js", import.meta.url), "utf8")

function harness(conf, updateFails = false) {
  const updates = []
  const context = {
    fetch: async (url, options) => {
      if (url.endsWith("/query")) return { ok: true, json: async () => conf }
      const update = JSON.parse(options.body)
      updates.push(update)
      return {
        ok: !updateFails,
        status: updateFails ? 500 : 200,
        json: async () => updateFails
          ? { detail: "配置保存失败" }
          : { ...conf, translate_api_type: update.v },
      }
    },
  }
  vm.runInNewContext(source, context)
  return { ensure: context.ensureTranslationProvider, updates }
}

test("同步设置时自定义 API 优先于 DashScope", async () => {
  const conf = { translate_api_type: "dashscope", provider_status: { custom: { configured: true } } }
  const { ensure, updates } = harness(conf)
  assert.equal((await ensure(conf, true)).translate_api_type, "custom")
  assert.deepEqual(updates, [{ attr: "translate_api_type", v: "custom" }])
})

test("直接翻译和设置同步都在自定义 API 未配置时回退", async () => {
  for (const preferCustom of [false, true]) {
    const conf = { translate_api_type: "custom", provider_status: { custom: { configured: false } } }
    const { ensure, updates } = harness(conf)
    assert.equal((await ensure(undefined, preferCustom)).translate_api_type, "dashscope")
    assert.equal(updates.length, 1)
  }
})

test("已配置自定义、未知配置状态和手动选择 DashScope 不重复更新", async () => {
  for (const conf of [
    { translate_api_type: "custom", provider_status: { custom: { configured: true } } },
    { translate_api_type: "custom" },
    { translate_api_type: "dashscope", provider_status: { custom: { configured: true } } },
  ]) {
    const { ensure, updates } = harness(conf)
    assert.equal(await ensure(), conf)
    assert.equal(updates.length, 0)
  }
})

test("旧 openai 别名也会在未配置时回退", async () => {
  const { ensure } = harness({ translate_api_type: "openai", provider_status: { openai: { configured: false } } })
  assert.equal((await ensure()).translate_api_type, "dashscope")
})

test("更新失败向调用方报告，避免误报切换成功", async () => {
  const { ensure } = harness({ translate_api_type: "custom", provider_status: { custom: { configured: false } } }, true)
  await assert.rejects(ensure(), /配置保存失败/)
})
