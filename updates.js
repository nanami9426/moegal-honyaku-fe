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
      // 旧安装可能没有标识文件，此时必须显示未知，不能假定已是最新。
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

async function checkRepositoryUpdate(localCommit) {
  const latest = await requestUpdateJSON(`commits/${UPDATE_BRANCH}`)
  if (!isCommitSha(latest.sha)) throw new Error("GitHub 返回了无效的提交信息。")
  const result = {
    localCommit,
    remoteCommit: latest.sha,
    message: typeof latest.commit?.message === "string" ? latest.commit.message.split("\n")[0] : "",
    commitUrl: `${UPDATE_REPO_URL}/commit/${latest.sha}`,
  }
  if (!isCommitSha(localCommit)) return { ...result, status: "unknown" }
  if (localCommit === latest.sha) return { ...result, status: "identical" }
  const comparison = await requestUpdateJSON(`compare/${localCommit}...${latest.sha}`)
  if (!["ahead", "behind", "diverged", "identical"].includes(comparison.status)) {
    throw new Error("GitHub 返回了无效的版本比较结果。")
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
