function save_conf(conf) {
  chrome.storage.local.set(conf, () => {})
}


const update_conf = async () => {
  try {
    const current_conf = await chrome.storage.local.get(['translate_engine'])
    pyload = {
      translate_api_type: current_conf.translate_engine,
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
    const response = await fetch("http://127.0.0.1:8000/conf/query", {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      },

    })
    if (!response.ok) throw new Error("请求失败")
    const result = await response.json()
    document.getElementById('current-engine').textContent = result.translate_api_type
  } catch (e) {
    console.error("查询失败:", e)
  }
}

const init = async () => {
  // 绑定设置按钮
  document.getElementById("update_conf_button").addEventListener("click", async () => {
    const translate_engine = document.getElementById('translate_engine').value
    save_conf({
      translate_engine: translate_engine,
    })
    await update_conf()
    await query_conf()
  })

  // 查询后端配置
  await query_conf()
}


init()