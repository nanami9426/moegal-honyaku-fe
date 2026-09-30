const UPDATE_REPO = "nanami9426/moegal-honyaku-fe"
const UPDATE_BRANCH = "main"
const UPDATE_REPO_URL = `https://github.com/${UPDATE_REPO}`

function isCommitSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value)
}

async function readInstalledCommit() {
  // 压缩包内的标识优先，避免覆盖安装后残留的本地标识干扰判断。
  for (const path of ["update-version.json", "update-version.local.json"]) {
    try {
      const response = await fetch(chrome.runtime.getURL(path), { cache: "no-store" })
      if (!response.ok) continue
      const info = await response.json()
      if (isCommitSha(info.commit)) return info.commit
    } catch {
      // 旧安装可能没有标识文件，后续通过实际文件校验，不猜测安装版本。
    }
  }
  return null
}

async function requestUpdateJSON(path) {
  const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/${path}`, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      throw new Error("GitHub 暂时限制了请求，请稍后重试。")
    }
    if (response.status === 404) {
      throw new Error("无法在远端找到仓库或本地提交，本地提交可能尚未推送。")
    }
    throw new Error(`检查更新失败 (${response.status})，请稍后重试。`)
  }
  return response.json()
}

async function gitBlobSha(bytes) {
  // Git 的文件 SHA 包含 blob 头，不能直接对文件正文计算摘要。
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`)
  const blob = new Uint8Array(header.length + bytes.byteLength)
  blob.set(header)
  blob.set(bytes, header.length)
  const digest = await crypto.subtle.digest("SHA-1", blob)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
}

async function matchesInstalledFiles(commit) {
  const tree = await requestUpdateJSON(`git/trees/${commit}?recursive=1`)
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("无法获取完整的远端文件列表")
  // 只比较扩展运行文件；文档、测试和生成的版本标识不代表功能更新。
  const files = tree.tree.filter(item => item.type === "blob"
    && typeof item.path === "string"
    && !/(^|\/)(?:\.[^/]*|tests?|scripts|docs)(?:\/|$)/.test(item.path)
    && !/^update-version(?:\.local)?\.json$/.test(item.path)
    && /\.(?:[cm]?js|css|html|json|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|wasm)$/i.test(item.path))
  if (!files.some(item => item.path === "manifest.json")) throw new Error("远端文件列表缺少扩展清单")
  for (const file of files) {
    if (!isCommitSha(file.sha) || file.path.startsWith("/") || file.path.split("/").includes("..")) {
      throw new Error("远端文件信息无效")
    }
    let bytes
    try {
      const path = file.path.split("/").map(encodeURIComponent).join("/")
      const response = await fetch(chrome.runtime.getURL(path), { cache: "no-store" })
      if (!response.ok) return false
      bytes = new Uint8Array(await response.arrayBuffer())
    } catch {
      // 新版本增加文件时，本地资源不存在，说明尚未安装这份版本。
      return false
    }
    if (await gitBlobSha(bytes) === file.sha) continue
    // Windows 的 Git 签出可能转换行尾，不能把 CRLF 当作功能差异。
    if (/\.(?:[cm]?js|css|html|json|svg)$/i.test(file.path)) {
      const normalized = new TextEncoder().encode(new TextDecoder().decode(bytes).replace(/\r\n/g, "\n"))
      if (await gitBlobSha(normalized) === file.sha) continue
    }
    return false
  }
  return true
}

async function checkRepositoryUpdate(localCommit) {
  const latest = await requestUpdateJSON(`commits/${UPDATE_BRANCH}`)
  if (!isCommitSha(latest.sha)) throw new Error("GitHub 返回了无效的提交信息。")
  const result = {
    localCommit,
    remoteCommit: latest.sha,
    message: typeof latest.commit?.message === "string" ? latest.commit.message.split("\n")[0] : "",
    commitUrl: `${UPDATE_REPO_URL}/commit/${latest.sha}`,
  }
  if (!isCommitSha(localCommit)) {
    return { ...result, status: await matchesInstalledFiles(latest.sha) ? "identical" : "unknown" }
  }
  if (localCommit === latest.sha) return { ...result, status: "identical" }
  const comparison = await requestUpdateJSON(`compare/${localCommit}...${latest.sha}`)
  if (!["ahead", "behind", "diverged", "identical"].includes(comparison.status)) {
    throw new Error("GitHub 返回了无效的版本比较结果。")
  }
  // 源码安装后的提交或 pull 不会自动刷新 local.json；提示更新前核对真实文件。
  if (["ahead", "diverged"].includes(comparison.status) && await matchesInstalledFiles(latest.sha)) {
    return { ...result, status: "identical" }
  }
  return {
    ...result,
    status: comparison.status,
    aheadBy: comparison.ahead_by,
    commitUrl: `${UPDATE_REPO_URL}/compare/${localCommit}...${latest.sha}`,
  }
}

function initUpdateControls() {
  const button = document.getElementById("check-update-button")
  const status = document.getElementById("update-status")
  const repository = document.getElementById("update-repository-link")
  button.addEventListener("click", async () => {
    button.disabled = true
    button.textContent = "检查中…"
    status.hidden = true
    repository.hidden = true
    try {
      const result = await checkRepositoryUpdate(await readInstalledCommit())
      if (result.status === "ahead" || result.status === "diverged") {
        repository.href = UPDATE_REPO_URL
        repository.hidden = false
      } else if (result.status === "identical" || result.status === "behind") {
        status.textContent = "已是最新版本"
        status.hidden = false
      } else {
        throw new Error("无法识别本地提交")
      }
    } catch (error) {
      // 失败不冒充最新版本，详细原因仅记录到控制台。
      console.error("检查更新失败:", error)
      status.textContent = "检查失败，请重试"
      status.hidden = false
    } finally {
      button.textContent = "检查更新"
      button.disabled = false
    }
  })
}
