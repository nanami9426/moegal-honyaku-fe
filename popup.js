function save_conf(conf) {
  chrome.storage.local.set(conf, () => { })
}

const get_req_format_api_key = (engine_type, conf) => {
  if (engine_type == conf.translate_engine) return conf.api_key
  return null
}

const update_conf = async () => {
  try {
    const current_conf = await chrome.storage.local.get(['translate_engine', 'api_key'])
    pyload = {
      translate_api_type: current_conf.translate_engine,
      api_key_translate_openai: get_req_format_api_key("openai", current_conf),
      api_key_translate_ernie: get_req_format_api_key("ernie", current_conf)
    }
    const response = await fetch("http://127.0.0.1:8000/conf/init", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(pyload)
    })
    if (!response.ok) throw new Error("请求失败")
    const result = await response.json()
    return result
  } catch (e) {
    console.error("更新失败:", e)
  }
}

const query_conf = async () => {
  try {
    const current_conf = await chrome.storage.local.get(['translate_engine', 'api_key'])
    const response = await fetch("http://127.0.0.1:8000/conf/query", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        translate_api_type: current_conf.translate_engine,
      })
    })
    if (!response.ok) throw new Error("请求失败")
    const result = await response.json()

    document.getElementById('current-engine').textContent = result.translate_api_type
    document.getElementById('current-apikey').textContent = result.apikey || "获取 API key 失败"
  } catch (e) {
    console.error("查询失败:", e)
  }
}

const init = async () => {
  // 绑定设置按钮
  document.getElementById("update_conf_button").addEventListener("click", async () => {
    const translate_engine = document.getElementById('translate_engine').value
    const api_key = document.getElementById('api_key_input').value
    save_conf({
      translate_engine: translate_engine,
      api_key: api_key
    })
    await update_conf()
    await query_conf()
  })
  
  // 更新后端配置
  await update_conf()

  // 查询后端配置
  await query_conf()
}


init()