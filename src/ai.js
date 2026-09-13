// AI 适配器：OpenAI 兼容 /chat/completions（支持工具调用与视觉图片）
export class AiError extends Error {}

export function isConfigured(cfg) {
  if (!cfg) return false;
  if (cfg.provider === 'mock') return true; // 内置演示不联网
  return !!(cfg.baseUrl && cfg.model && cfg.apiKey);
}

/** 是否视觉模型可用 */
export function visionModel(cfg, hasImage) {
  if (!hasImage) return cfg.model;
  return cfg.visionModel || cfg.model;
}

function normBaseUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

/**
 * 调用聊天补全接口
 * @param cfg {baseUrl, apiKey, model, temperature, thinking?: 'auto'|'on'|'off'}
 * @param opts {messages, tools?, hasImage?}
 */
export async function chatComplete(cfg, { messages, tools, hasImage = false }) {
  const model = visionModel(cfg, hasImage);
  const base = normBaseUrl(cfg.baseUrl);
  const body = {
    model,
    messages,
    temperature: cfg.temperature ?? 0.2,
    stream: false
  };
  if (tools && tools.length) body.tools = tools;
  // 推理开关：文本操作默认关思考（生成量减半、响应更快）；拍照识别保留思考
  const mode = cfg.thinking || 'auto';
  if (mode === 'off' || (mode === 'auto' && !hasImage)) body.thinking = { type: 'disabled' };
  else if (mode === 'on' || mode === 'auto') body.thinking = { type: 'enabled' };

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000)
    });
  } catch (e) {
    throw new AiError('AI 请求失败（网络/超时）: ' + e.message);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) {
    const msg = data && data.error && (data.error.message || data.error.msg)
      ? data.error.message || data.error.msg
      : text.slice(0, 300);
    const hint = res.status === 401 ? '（请检查 API Key）'
      : res.status === 404 ? '（接口地址可能不对，请核对 baseUrl 与模型名）'
      : res.status === 429 ? '（触发限流，请稍后重试）'
      : res.status === 400 ? '（请求被拒绝，常见原因：模型不支持工具调用或图片，或消息格式问题）' : '';
    throw new AiError(`AI 接口返回 ${res.status} ${hint}：${msg}`);
  }
  const choice = data && data.choices && data.choices[0];
  const message = choice && choice.message;
  if (!message) throw new AiError('AI 返回内容为空，请重试');
  return {
    content: message.content || '',
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : null
  };
}

/** 连接测试：发一条极短消息 */
export async function testConnection(cfg) {
  if (cfg.provider === 'mock') return { ok: true, note: '演示模式（本地模拟AI），无需联网' };
  const out = await chatComplete(cfg, { messages: [{ role: 'user', content: '你好，请回复：OK' }] });
  return { ok: true, reply: String(out.content || 'OK').slice(0, 120), model: cfg.model };
}

/** 把本地图片 buffer 包装成视觉消息内容 */
export function imagePart(buffer, mime) {
  const b64 = buffer.toString('base64');
  return { type: 'image_url', image_url: { url: `data:${mime || 'image/jpeg'};base64,${b64}` } };
}

export function textPart(text) {
  return { type: 'text', text };
}
