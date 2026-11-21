// LLM 统一封装：按设置页里用户自配的 OpenAI 兼容接口发请求（BYOK）。
// 没配 Key / 模型时抛出带白话文案的错误，路由层原样回给前端引导去设置页。
const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./settings');
const { DATA_DIR } = require('./db');

class LlmError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'LLM_ERROR';
  }
}

// 网络层重试封装：这台机器上 Node 的 fetch 偶尔会选到不通的路径（实测间歇性
// fetch failed），所以凡是「还没拿到任何 HTTP 响应」就断掉的（fetch 抛错：连不上、
// 超时、连接重置）都自动重试，最多 3 次、间隔 600ms。一旦拿到了响应——哪怕是
// 401/400/500——都不重试，原样交回调用方按原逻辑处理，别把真错误拖成慢失败。
async function fetchWithNetworkRetry(url, options) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(url, options);
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw lastErr;
}

function requireConfig() {
  const { llm } = loadSettings();
  if (!llm.apiKey || !llm.model) {
    throw new LlmError(
      '还没有配置模型：请先到「设置」页填好接口地址、模型名和你的 API Key，保存后就能开始上课了。',
      'NO_LLM_CONFIG'
    );
  }
  return llm;
}

async function chat(messages, { temperature = 0.7 } = {}) {
  const cfg = requireConfig();
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  let resp;
  try {
    // 只在 fetch 阶段（还没收到任何响应）走网络重试；响应到手后断开不在这里重发，
    // 避免整条生成重复。生成调用非流式，resp 一次拿全，不存在吐字中途重发的问题。
    resp = await fetchWithNetworkRetry(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: cfg.model, messages, temperature }),
    });
  } catch (e) {
    throw new LlmError(`连不上模型接口（${base}）：${e.message}。请检查接口地址和网络。`, 'LLM_NETWORK');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new LlmError(
      `模型接口返回了错误（HTTP ${resp.status}）：${text.slice(0, 300)}。请检查 Key 和模型名是否填对。`,
      'LLM_HTTP'
    );
  }
  const data = await resp.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  if (!content) throw new LlmError('模型没有返回内容，请稍后重试。', 'LLM_EMPTY');
  return content;
}

// 要求模型只回 JSON，并做宽容解析（去代码围栏、截取首个 JSON 块）。
async function chatJSON(system, user, opts) {
  const raw = await chat(
    [
      { role: 'system', content: system + '\n只输出 JSON，不要输出任何解释文字或 Markdown 代码围栏。' },
      { role: 'user', content: user },
    ],
    opts
  );
  return parseJSON(raw);
}

function parseJSON(raw) {
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = Math.min(
      ...['{', '['].map((c) => {
        const i = s.indexOf(c);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      })
    );
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (start !== Number.MAX_SAFE_INTEGER && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new LlmError('模型返回的内容格式不对，没能解析成数据，请重试一次。', 'LLM_PARSE');
  }
}

// 设置页「测试连接」：用当前（或表单里刚填的）配置发一句 ping。
async function testConnection(override) {
  const cur = loadSettings().llm;
  const cfg = { ...cur, ...(override || {}) };
  if (!cfg.apiKey || !cfg.model) {
    return { ok: false, message: '请先填好模型名和 API Key 再测试。' };
  }
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  try {
    const resp = await fetchWithNetworkRetry(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    });
    if (resp.ok) return { ok: true, message: `连接成功，模型「${cfg.model}」可用。` };
    const text = await resp.text().catch(() => '');
    return { ok: false, message: `接口返回 HTTP ${resp.status}：${text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, message: `连不上接口：${e.message}` };
  }
}

// ---------- 模型列表：从接口拉取 + 服务端缓存 ----------
// 缓存存 data/models-cache.json，按接口地址分开记一份（换了服务商不会串），
// 每份带 fetchedAt 时间戳；设置页打开时先读缓存，点「获取模型列表」才重新请求。
const MODELS_CACHE_FILE = path.join(DATA_DIR, 'models-cache.json');

function normalizeBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function loadModelsCache() {
  try {
    return JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveModelsCache(cache) {
  try {
    fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    /* 缓存写不进去不影响拉取结果本身 */
  }
}

// 读某个接口地址的缓存：{ models: [...], fetchedAt }，没有就 null。
function cachedModels(baseUrl) {
  const entry = loadModelsCache()[normalizeBase(baseUrl)];
  if (!entry || !Array.isArray(entry.models) || !entry.models.length) return null;
  return { models: entry.models, fetchedAt: entry.fetchedAt || 0 };
}

// 设置页「获取模型列表」：拿表单里刚填的（或已保存的）地址 + Key 请求 {baseUrl}/models。
// 失败一律回大白话，说清是哪种问题；成功后顺手写缓存。
async function fetchModels(override) {
  const cur = loadSettings().llm;
  const cfg = { ...cur, ...(override || {}) };
  const base = normalizeBase(cfg.baseUrl);
  if (!base) return { ok: false, message: '请先填好接口地址，再获取模型列表。' };
  if (!cfg.apiKey) {
    return { ok: false, message: '还没有 API Key：请先在上面填好 Key（填完不用先保存，直接点获取也行），再获取模型列表。' };
  }
  // 网络层失败时自动重试，与上课生成、测试连接共用 fetchWithNetworkRetry 同一口径。
  let resp;
  try {
    resp = await fetchWithNetworkRetry(`${base}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
  } catch (e) {
    return {
      ok: false,
      message: `连不上这个接口地址（${base}）：${e.message}。请检查地址写没写对、网络通不通。`,
    };
  }
  if (resp.status === 401 || resp.status === 403) {
    return {
      ok: false,
      message: `Key 不对，或者这个 Key 没有权限（接口返回 ${resp.status}）。请检查 Key 有没有填错、有没有过期。`,
    };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return {
      ok: false,
      message: `接口返回了错误（HTTP ${resp.status}）：${text.slice(0, 200)}。请检查接口地址是否正确。`,
    };
  }
  const data = await resp.json().catch(() => null);
  const models = Array.isArray(data && data.data)
    ? data.data.map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean)
    : [];
  if (!models.length) {
    return {
      ok: false,
      message: '接口是通的，但它没有返回任何模型。可能这个服务不支持模型列表接口，模型名还是手动填吧。',
    };
  }
  models.sort();
  const fetchedAt = Date.now();
  const cache = loadModelsCache();
  cache[base] = { models, fetchedAt };
  saveModelsCache(cache);
  return { ok: true, models, fetchedAt, message: `已获取 ${models.length} 个模型，点模型名输入框就能选，也可以继续手动输入。` };
}

module.exports = { chat, chatJSON, parseJSON, testConnection, fetchModels, cachedModels, LlmError, requireConfig };
