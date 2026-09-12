import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// git clone / pull 不进行 export-subst，直接加载源码时生成本地提交标识。
const root = fileURLToPath(new URL("../", import.meta.url))
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("无法读取当前 Git 提交")
writeFileSync(new URL("../update-version.local.json", import.meta.url), `${JSON.stringify({ commit }, null, 2)}\n`)
console.log(`已记录本地版本：${commit.slice(0, 7)}。提交或拉取代码后请重新运行此命令。`)
