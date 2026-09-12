const PROVIDER_CONFIG_URL = "http://127.0.0.1:8000/conf"

async function requestProviderConfig(path, options = { method: "GET" }) {
  const response = await fetch(`${PROVIDER_CONFIG_URL}/${path}`, options)
  const conf = await response.json()
  if (!response.ok) {
    throw new Error(conf?.detail || conf?.message || `接口配置请求失败 (${response.status})`)
  }
  return conf
}

async function ensureTranslationProvider(conf, preferCustom = false) {
  if (!conf) conf = await requestProviderConfig("query")
  const custom = conf.provider_status?.custom || conf.provider_status?.openai
  const current = (conf.translate_api_type || "custom").trim().toLowerCase()
  let provider = current === "openai" ? "custom" : current

  // 同步默认配置时优先自定义；翻译时保留手动选择，仅在自定义未配置时回退。
  // 旧后端未提供配置状态时，不把未知状态当成未配置。
  if (preferCustom && custom?.configured === true) provider = "custom"
  if (provider === "custom" && custom?.configured === false) provider = "dashscope"
  if (provider === current || (current === "openai" && provider === "custom")) return conf

  // 必须更新后端实际使用的配置，不能只更改弹窗显示值。
  return requestProviderConfig("update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attr: "translate_api_type", v: provider }),
  })
}
