// WorkBuddy API 客户端
// 只依赖注入进来的 transport，不 require electron —— 这样能用普通 node 跑回归测试。
// 设计原则：**永远不抛异常**。所有失败都收敛成 { ok:false, code, message }，
// 调用方（对话 / 名片 / 论文解析，将来还有更多）只需要看 ok，桌宠主流程不会因为接口挂了而崩。

const DEFAULTS = {
  baseUrl: '',
  apiKey: '',
  model: 'DeepSeek-V4.1-Flash',
  timeoutMs: 25000,
  maxRetries: 2,          // 只对"值得重试"的错误生效
  retryBaseMs: 600,       // 指数退避的基数
  breakerAfter: 4,        // 连续失败几次后熔断
  breakerCoolMs: 45000,   // 熔断冷却时间
};

// ---------- 地址拼接 ----------
// WorkBuddy 的模型接入是 OpenAI 兼容协议，踩过的两个坑都在这处理掉：
//   1. 地址末尾带 / 会拼出 //chat/completions
//   2. 已经写到 /chat/completions 的（开了"自定义协议"原样发送）不能再拼一次
function endpointFor(base) {
  const b = String(base || '').trim().replace(/\s+/g, '');
  if (!b) return null;
  if (/\/chat\/completions$/i.test(b)) return b;
  return b.replace(/\/+$/, '') + '/chat/completions';
}

function isHttpUrl(u) {
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; }
  catch (_) { return false; }
}

// ---------- 错误分类 ----------
// 分成"重试有意义"和"重试没意义"两类：401 重试三次只会让你等更久。
const KIND = {
  NO_CONFIG: 'no-config',
  BAD_URL: 'bad-url',
  AUTH: 'auth',
  MODEL: 'model-not-found',
  BAD_REQUEST: 'bad-request',
  NOT_FOUND: 'not-found',
  RATE_LIMIT: 'rate-limit',
  SERVER: 'server',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  BAD_RESPONSE: 'bad-response',
  CIRCUIT: 'circuit-open',
};

const RETRYABLE = new Set([KIND.RATE_LIMIT, KIND.SERVER, KIND.NETWORK, KIND.TIMEOUT]);

function friendly(code, message) {
  const tail = message ? '（' + message + '）' : '';
  switch (code) {
    case KIND.NO_CONFIG: return '还没配置 WorkBuddy API 地址 / 密钥，打开「AI 设置」填一下';
    case KIND.BAD_URL: return '接口地址格式不对，应该像 https://xxx/v1' + tail;
    case KIND.AUTH: return '鉴权失败：API Key 不对或已过期' + tail;
    case KIND.MODEL: return '模型名不可用：检查「' + (DEFAULTS.model) + '」是否在该接口的可用列表里' + tail;
    case KIND.RATE_LIMIT: return '请求太频繁被限流，稍等一下再试' + tail;
    case KIND.SERVER: return 'WorkBuddy 服务端出错，稍后重试' + tail;
    case KIND.NETWORK: return '连不上接口：检查网络或代理是否开着' + tail;
    case KIND.TIMEOUT: return '请求超时，可能是网络慢或模型排队' + tail;
    case KIND.NOT_FOUND: return '接口路径不存在，检查 Base URL 要不要带 /v1' + tail;
    case KIND.BAD_RESPONSE: return '接口返回的内容看不懂（不是预期的 JSON 结构）' + tail;
    case KIND.CIRCUIT: return '连续失败太多，已暂停请求 45 秒（避免拖慢桌宠）';
    default: return '请求失败' + tail;
  }
}

// 从各家五花八门的错误体里把有用信息挖出来
function bodyMessage(json, text) {
  if (json && typeof json === 'object') {
    const e = json.error;
    if (e && typeof e === 'object') return String(e.message || e.msg || e.code || '');
    if (typeof e === 'string') return e;
    for (const k of ['message', 'msg', 'error_msg', 'detail', 'code']) {
      if (json[k] != null && typeof json[k] !== 'object') return String(json[k]);
    }
  }
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 160 ? t.slice(0, 160) + '…' : t;
}

function kindForStatus(status, msg) {
  const m = String(msg || '').toLowerCase();
  if (status === 401 || status === 403) return KIND.AUTH;
  if (status === 404) return KIND.NOT_FOUND;
  if (status === 408) return KIND.TIMEOUT;
  if (status === 409 || status === 425) return KIND.SERVER;   // 暂时性冲突，重试有意义
  if (status === 429) return KIND.RATE_LIMIT;
  if (status >= 500) return KIND.SERVER;
  if (status === 400 || status === 422) {
    // 模型名不存在时各家都爱返回 400，得看文案才能区分
    if (/model|模型/.test(m) && /not|exist|invalid|未|不存在|不支持/.test(m)) return KIND.MODEL;
    return KIND.BAD_REQUEST;
  }
  return KIND.BAD_REQUEST;
}

function kindForNetwork(err) {
  const c = String((err && (err.code || err.errno)) || '');
  const m = String((err && err.message) || err || '');
  if (/timeout|timedout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(c + ' ' + m)) return KIND.TIMEOUT;
  return KIND.NETWORK;
}

function retryAfterMs(headers) {
  const h = headers || {};
  const v = h['retry-after'] || h['Retry-After'];
  if (!v) return 0;
  const sec = Number(v);
  if (Number.isFinite(sec)) return Math.max(0, Math.min(sec * 1000, 15000));
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 15000)) : 0;
}

// 回复内容归一化：有的是字符串，有的网关返回 [{type:'text',text:'...'}]，推理模型还会塞 reasoning_content
function pickContent(message) {
  if (!message || typeof message !== 'object') return '';
  const c = message.content;
  if (typeof c === 'string' && c.trim()) return c;
  if (Array.isArray(c)) {
    const parts = c
      .map((p) => (typeof p === 'string' ? p : p && (p.text || p.content) ? String(p.text || p.content) : ''))
      .filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
    return message.reasoning_content;
  }
  return '';
}

function textFromJson(json) {
  if (!json || typeof json !== 'object') return '';
  const ch = json.choices;
  if (Array.isArray(ch) && ch.length) {
    const first = ch[0] || {};
    const c = pickContent(first.message);
    if (c) return c;
    if (typeof first.text === 'string' && first.text.trim()) return first.text;
  }
  // 少数兼容层把结果平铺在顶层
  if (typeof json.output_text === 'string') return json.output_text;
  if (typeof json.content === 'string') return json.content;
  return '';
}

// ---------- 客户端 ----------
/**
 * @param {object} opts
 * @param {(url:string, req:object)=>Promise<{status:number, headers:object, body:string}>} opts.transport
 * @param {() => object} opts.getConfig  每次调用时现取配置，改设置不用重建客户端
 * @param {() => number} [opts.now]
 */
function createClient(opts) {
  const transport = opts.transport;
  const getConfig = opts.getConfig || (() => ({}));
  const now = opts.now || (() => Date.now());

  let failStreak = 0;
  let breakerUntil = 0;
  let lastError = null;

  function cfg() {
    const c = getConfig() || {};
    return {
      baseUrl: String(c.baseUrl || DEFAULTS.baseUrl).trim(),
      apiKey: String(c.apiKey || DEFAULTS.apiKey).trim(),
      model: String(c.model || DEFAULTS.model).trim() || DEFAULTS.model,
      timeoutMs: Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : DEFAULTS.timeoutMs,
      maxRetries: Number.isFinite(Number(c.maxRetries)) ? Math.max(0, Math.min(Number(c.maxRetries), 4)) : DEFAULTS.maxRetries,
    };
  }

  function fail(code, message, extra) {
    lastError = { code, message, at: now() };
    return Object.assign({ ok: false, code, message, hint: friendly(code, ''), retryable: RETRYABLE.has(code) }, extra || {});
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 发一次对话请求。永不抛异常。
   * @returns {Promise<{ok:boolean, text?:string, usage?:object, model?:string, code?:string, message?:string, attempts?:number, ms?:number}>}
   */
  async function chat(opts2) {
    const o = opts2 || {};
    const c = cfg();
    const started = now();

    const url = endpointFor(c.baseUrl);
    if (!url) return fail(KIND.NO_CONFIG, '未填写接口地址');
    if (!isHttpUrl(url)) return fail(KIND.BAD_URL, url);
    if (!c.apiKey) return fail(KIND.NO_CONFIG, '未填写 API Key');

    // 熔断：连续失败太多次时直接快速失败，别让桌宠每个动作都等 25 秒
    if (now() < breakerUntil) {
      const left = Math.ceil((breakerUntil - now()) / 1000);
      return fail(KIND.CIRCUIT, '还需等待 ' + left + ' 秒');
    }

    const payload = {
      model: o.model || c.model,
      messages: Array.isArray(o.messages) ? o.messages : [],
      temperature: typeof o.temperature === 'number' ? o.temperature : 0.7,
    };
    if (Number.isFinite(o.maxTokens) && o.maxTokens > 0) payload.max_tokens = Math.floor(o.maxTokens);
    if (o.jsonMode) payload.response_format = { type: 'json_object' };

    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer ' + c.apiKey,
    };

    const maxAttempts = Math.max(1, Math.min(c.maxRetries, 4) + 1);
    let lastCode = KIND.NETWORK;
    let lastMsg = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try {
        res = await transport(url, { method: 'POST', headers, body, timeoutMs: c.timeoutMs });
      } catch (e) {
        // 网络层异常：DNS / 拒绝连接 / 代理挂了 / TLS / 超时
        lastCode = kindForNetwork(e);
        const err = e && (e.code || e.errno) || '';
        lastMsg = String((e && e.message) || e) + (err ? ' [' + err + ']' : '');
        if (!RETRYABLE.has(lastCode) || attempt === maxAttempts) break;
        await sleep(backoff(attempt, 0));
        continue;
      }

      const status = Number(res && res.status) || 0;
      const text = String((res && res.body) || '');

      if (status >= 200 && status < 300) {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) {
          // 有的网关会用 text/event-stream 或裸文本回，尽量兜一下
          if (/^\s*data:\s*\{/m.test(text)) {
            const line = text.split('\n').map((l) => l.replace(/^\s*data:\s*/, '')).filter((l) => l.trim().startsWith('{')).pop();
            try { json = JSON.parse(line); } catch (_e) { json = null; }
          }
        }
        if (!json) {
          failStreak += 1;
          if (failStreak >= DEFAULTS.breakerAfter) { breakerUntil = now() + DEFAULTS.breakerCoolMs; failStreak = 0; }
          return fail(KIND.BAD_RESPONSE, text.slice(0, 120));
        }
        const out = textFromJson(json);
        if (!out) {
          // 200 但没内容（模型拒答 / 触发了空回复）：算失败但不重试
          failStreak += 1;
          return fail(KIND.BAD_RESPONSE, '返回里没有 choices[0].message.content');
        }
        failStreak = 0;
        lastError = null;
        return {
          ok: true,
          text: out,
          model: json.model || payload.model,
          usage: json.usage || null,
          attempts: attempt,
          ms: now() - started,
        };
      }

      // 非 2xx：先解析错误体再分类
      let ej = null;
      try { ej = text ? JSON.parse(text) : null; } catch (_) {}
      const msg = bodyMessage(ej, text) || ('HTTP ' + status);
      lastCode = kindForStatus(status, msg);
      lastMsg = 'HTTP ' + status + ' ' + msg;

      if (!RETRYABLE.has(lastCode) || attempt === maxAttempts) break;
      await sleep(backoff(attempt, retryAfterMs(res && res.headers)));
    }

    // 走到这里说明重试用尽或不可重试
    if (RETRYABLE.has(lastCode)) {
      failStreak += 1;
      if (failStreak >= DEFAULTS.breakerAfter) { breakerUntil = now() + DEFAULTS.breakerCoolMs; failStreak = 0; }
    }
    return fail(lastCode, lastMsg, { attempts: maxAttempts, ms: now() - started });
  }

  // 指数退避 + 抖动：第 1 次 ~0.6s，第 2 次 ~1.2s；服务端给了 Retry-After 就用它的
  function backoff(attempt, hinted) {
    if (hinted > 0) return hinted + Math.floor(Math.random() * 200);
    return DEFAULTS.retryBaseMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
  }

  // 连通性自检：拿一句最短的话试，把真实的错误码给用户看，而不是干瘪的"测试失败"
  async function ping(overrides) {
    const r = await chat(Object.assign({
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0,
      maxTokens: 8,
    }, overrides || {}));
    if (!r.ok) return { ok: false, code: r.code, message: r.message, hint: r.hint };
    return { ok: true, model: r.model, ms: r.ms, text: String(r.text || '').slice(0, 40) };
  }

  function status() {
    const c = cfg();
    return {
      configured: !!(c.baseUrl && c.apiKey),
      model: c.model,
      endpoint: endpointFor(c.baseUrl) || '',
      breakerLeftMs: Math.max(0, breakerUntil - now()),
      lastError,
    };
  }

  // 改完设置要让熔断立刻放行，否则用户填对了 Key 还得等 45 秒
  function reset() { failStreak = 0; breakerUntil = 0; lastError = null; }

  return { chat, ping, status, reset, endpointFor, DEFAULTS, KIND };
}

module.exports = {
  createClient, endpointFor, isHttpUrl, kindForStatus, kindForNetwork,
  bodyMessage, textFromJson, pickContent, friendly, DEFAULTS, KIND, RETRYABLE,
};
