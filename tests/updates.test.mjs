import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash, webcrypto } from "node:crypto"
import test from "node:test"
import vm from "node:vm"

const source = readFileSync(new URL("../updates.js", import.meta.url), "utf8")
const local = "a".repeat(40)
const remote = "b".repeat(40)
const oldFiles = { "manifest.json": '{"version":"1.0"}', "content.js": "old content\n" }
const latestFiles = { ...oldFiles, "content.js": "latest content\n" }

function harness({ sha = remote, comparison = "ahead", code = 200, installed = local,
  files = oldFiles, remoteFiles = latestFiles, tree } = {}) {
  const requests = []
  const nodes = new Map()
  const context = {
    AbortSignal,
    TextEncoder,
    TextDecoder,
    crypto: webcrypto,
    console: { error() {} },
    chrome: { runtime: { getURL: (path) => `extension://${path}` } },
    document: { getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, { hidden: false, addEventListener(name, callback) { this[name] = callback } })
      return nodes.get(id)
    } },
    fetch: async (url) => {
      requests.push(url)
      if (url.startsWith("extension://")) {
        const path = decodeURIComponent(url.slice("extension://".length))
        if (/^update-version(?:\.local)?\.json$/.test(path)) return { ok: true, json: async () => ({ commit: installed }) }
        return {
          ok: Object.hasOwn(files, path),
          arrayBuffer: async () => new TextEncoder().encode(files[path]).buffer,
        }
      }
      return {
        ok: code === 200,
        status: code,
        json: async () => {
          if (url.includes("/compare/")) return { status: comparison, ahead_by: 2 }
          if (url.includes("/git/trees/")) return tree || { truncated: false, tree: Object.entries(remoteFiles).map(([path, text]) => ({
            path, type: "blob", sha: createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex"),
          })) }
          return { sha, commit: { message: "新功能\n\n说明" } }
        },
      }
    },
  }
  vm.runInNewContext(source, context)
  return { context, requests, nodes }
}

test("只在远端 main 领先本地时提示新提交", async () => {
  for (const status of ["ahead", "behind", "diverged"]) {
    const { context, requests } = harness({ comparison: status })
    const result = await context.checkRepositoryUpdate(local)
    assert.equal(result.status, status)
    assert.equal(result.message, "新功能")
    assert.equal(requests[0], "https://api.github.com/repos/nanami9426/moegal-honyaku-fe/commits/main")
    assert.ok(requests[1].endsWith(`/compare/${local}...${remote}`))
  }
})

test("提交相同时直接返回最新，避免多余比较请求", async () => {
  const { context, requests } = harness({ sha: local })
  assert.equal((await context.checkRepositoryUpdate(local)).status, "identical")
  assert.equal(requests.length, 1)
})

test("版本文件过期但已拉取最新代码时，不误报更新", async () => {
  for (const comparison of ["ahead", "diverged"]) {
    const { context, nodes } = harness({ comparison, files: latestFiles })
    context.initUpdateControls()
    await nodes.get("check-update-button").click()
    assert.equal(nodes.get("update-repository-link").hidden, true)
    assert.equal(nodes.get("update-status").textContent, "已是最新版本")
  }
})

test("缺少版本标识也可以通过实际文件确认已是最新", async () => {
  const { context, requests } = harness({ installed: "$Format:%H$", files: latestFiles })
  assert.equal((await context.checkRepositoryUpdate(await context.readInstalledCommit())).status, "identical")
  assert.equal(requests.some(url => url.includes("/compare/")), false)
})

test("代码内容变化或新文件尚未下载时，仍提示更新", async () => {
  for (const files of [oldFiles, { "manifest.json": latestFiles["manifest.json"] }]) {
    const { context } = harness({ files })
    assert.equal((await context.checkRepositoryUpdate(local)).status, "ahead")
  }
})

test("文档、测试和导出版本标识不会造成更新误报", async () => {
  const { context } = harness({ files: latestFiles, remoteFiles: {
    ...latestFiles, "README.md": "new documentation", "tests/updates.test.mjs": "new tests",
    "scripts/update-version.mjs": "new script", "update-version.json": "$Format:%H$",
  } })
  assert.equal((await context.checkRepositoryUpdate(local)).status, "identical")
})

test("Windows 签出转换的 CRLF 行尾不会误报更新", async () => {
  const { context } = harness({ files: { ...latestFiles, "content.js": "latest content\r\n" } })
  assert.equal((await context.checkRepositoryUpdate(local)).status, "identical")
})

test("文件列表被截断或无效时不猜测有更新", async () => {
  for (const tree of [{ truncated: true, tree: [] }, { tree: [] }, { tree: null },
    { tree: [{ path: "manifest.json", type: "blob", sha: "invalid" }] }]) {
    const { context, nodes } = harness({ tree })
    context.initUpdateControls()
    await nodes.get("check-update-button").click()
    assert.equal(nodes.get("update-status").textContent, "检查失败，请重试")
    assert.equal(nodes.get("update-repository-link").hidden, true)
  }
})

test("本地提交未知时不会当成最新或可更新", async () => {
  const { context, requests } = harness({ installed: "$Format:%H$" })
  assert.equal(await context.readInstalledCommit(), null)
  assert.equal((await context.checkRepositoryUpdate(null)).status, "unknown")
  assert.equal(requests.filter(url => url.includes("/compare/")).length, 0)
})

test("压缩包标识优先于旧的本地标识", async () => {
  const { context, requests } = harness()
  assert.equal(await context.readInstalledCommit(), local)
  assert.equal(requests.length, 1)
})

test("限流、未发布提交和无效响应显示检查失败", async () => {
  for (const code of [403, 429, 404, 500]) {
    const { context } = harness({ code })
    await assert.rejects(context.checkRepositoryUpdate(local))
  }
  const { context } = harness({ sha: "invalid" })
  await assert.rejects(context.checkRepositoryUpdate(local), /无效/)
})

test("发现更新后显示仓库入口，检查本身不打开页面或下载", async () => {
  const { context, nodes } = harness()
  context.initUpdateControls()
  await nodes.get("check-update-button").click()
  assert.equal(nodes.get("update-status").hidden, true)
  assert.equal(nodes.get("update-repository-link").hidden, false)
  assert.equal(nodes.get("update-repository-link").href, "https://github.com/nanami9426/moegal-honyaku-fe")
  assert.equal(nodes.get("check-update-button").disabled, false)
})

test("无需更新、版本未知或检查失败时不展示更新入口", async () => {
  for (const options of [{ sha: local }, { comparison: "behind" }, { installed: null }, { code: 403 }]) {
    const { context, nodes } = harness(options)
    context.initUpdateControls()
    await nodes.get("check-update-button").click()
    assert.equal(nodes.get("update-repository-link").hidden, true)
    assert.equal(nodes.get("check-update-button").disabled, false)
    assert.equal(nodes.get("update-status").textContent,
      options.installed === null || options.code ? "检查失败，请重试" : "已是最新版本")
  }
})
