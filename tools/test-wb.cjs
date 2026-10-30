// WorkBuddy API 客户端的回归测试：全部打本地 mock server，不依赖真实网络 / 真实 Key
// 跑法：node tools/test-wb.cjs
const http = require('http');
const wb = require('../wb');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

// ---------- 用 Node http 写一个 transport，模拟 Electron 的 net.request ----------
function makeTransport() {
  return (url, req) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = req.body ? Buffer.from(req.body, 'utf8') : null;
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: req.method || 'GET', headers: Object.assign({}, req.headers, body ? { 'Content-Length': body.length } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', (e) => reject(e));
    r.setTimeout(req.timeoutMs || 5000, () => {
      const e = new Error('请求超时'); e.code = 'ETIMEDOUT';
      r.destroy(e); reject(e);
    });
    if (body) r.write(body);
    r.end();
  });
}

// ---------- mock server：按路径决定行为 ----------
const hits = {};
let server;
function plan(path, fn) { if (!hits[path]) hits[path] = []; hits[path].push(fn); }

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const p = req.url.split('?')[0];
      const q = hits[p];
      const fn = q && q.length ? (q.length > 1 ? q.shift() : q[0]) : null;   // 最后一个一直复用
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        req.parsed = (() => { try { return JSON.parse(raw); } catch (_) { return null; } })();
        if (!fn) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"no route"}}'); }
        fn(req, res);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });
}

const jsonReply = (res, status, obj, headers) => {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers || {}));
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
};
const okReply = (text) => (req, res) => jsonReply(res, 200, {
  model: req.parsed && req.parsed.model,
  choices: [{ index: 0, message: { role: 'assistant', content: text } }],
  usage: { total_tokens: 12 },
});

(async () => {
  const base = await startServer();
  const mk = (cfg) => wb.createClient({ transport: makeTransport(), getConfig: () => cfg });
  const CFG = { baseUrl: base + '/v1', apiKey: 'test-key', model: 'DeepSeek-V4.1-Flash', timeoutMs: 3000, maxRetries: 2 };

  console.log('\n[地址拼接]');
  ok('末尾带 / 不会拼出 //chat/completions',
    wb.endpointFor('https://a.com/v1/') === 'https://a.com/v1/chat/completions', wb.endpointFor('https://a.com/v1/'));
  ok('已经写到 /chat/completions 的不再重复拼',
    wb.endpointFor('https://a.com/v1/chat/completions') === 'https://a.com/v1/chat/completions');
  ok('空地址返回 null', wb.endpointFor('  ') === null);

  console.log('\n[正常返回]');
  plan('/v1/chat/completions', okReply('你好，我是小猴。'));
  const c1 = mk(CFG);
  const r1 = await c1.chat({ messages: [{ role: 'user', content: 'hi' }] });
  ok('ok=true 且取到正文', r1.ok && r1.text === '你好，我是小猴。', r1);
  ok('用量被透出', r1.usage && r1.usage.total_tokens === 12);
  ok('默认模型是 DeepSeek-V4.1-Flash', r1.model === 'DeepSeek-V4.1-Flash', r1.model);

  console.log('\n[内容形态兼容]');
  const c2 = mk(CFG);
  ok('content 是数组分段时能拼起来',
    wb.textFromJson({ choices: [{ message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] } }] }) === 'A\nB');
  ok('只有 reasoning_content 时也能取到', wb.textFromJson({ choices: [{ message: { reasoning_content: '思考' } }] }) === '思考');
  ok('老式 text 字段兼容', wb.textFromJson({ choices: [{ text: 'old' }] }) === 'old');

  console.log('\n[鉴权失败：不重试]');
  plan('/auth/chat/completions', (req, res) => jsonReply(res, 401, { error: { message: 'invalid api key' } }));
  const c3 = mk(Object.assign({}, CFG, { baseUrl: base + '/auth' }));
  const r3 = await c3.chat({ messages: [{ role: 'user', content: 'x' }] });
  ok('code=auth', r3.code === wb.KIND.AUTH, r3.code);
  ok('不可重试', r3.retryable === false);
  ok('错误文案里带上了服务端的原话', /invalid api key/.test(r3.message), r3.message);
  ok('给了人话提示', /鉴权失败/.test(r3.hint), r3.hint);

  console.log('\n[模型名不存在：400 + 文案]');
  plan('/nomodel/chat/completions', (req, res) => jsonReply(res, 400, { error: { message: 'model DeepSeek-V4.1-Flash not found' } }));
  const r4 = await mk(Object.assign({}, CFG, { baseUrl: base + '/nomodel' })).chat({ messages: [] });
  ok('识别成 model-not-found', r4.code === wb.KIND.MODEL, r4.code);
  ok('不重试', r4.retryable === false);

  console.log('\n[400 普通参数错误]');
  plan('/badreq/chat/completions', (req, res) => jsonReply(res, 400, { error: { message: 'messages is required' } }));
  const r5 = await mk(Object.assign({}, CFG, { baseUrl: base + '/badreq' })).chat({ messages: [] });
  ok('识别成 bad-request', r5.code === wb.KIND.BAD_REQUEST, r5.code);

  console.log('\n[429 限流 → 按 Retry-After 重试成功]');
  let n429 = 0;
  plan('/rate/chat/completions', (req, res) => {
    n429++;
    if (n429 === 1) return jsonReply(res, 429, { error: { message: 'rate limited' } }, { 'Retry-After': '0' });
    return jsonReply(res, 200, { choices: [{ message: { content: '第二次成功' } }] });
  });
  const r6 = await mk(Object.assign({}, CFG, { baseUrl: base + '/rate' })).chat({ messages: [{ role: 'user', content: 'x' }] });
  ok('重试后成功', r6.ok && r6.text === '第二次成功', r6);
  ok('attempts=2', r6.attempts === 2, r6.attempts);

  console.log('\n[500 一直失败 → 用尽重试]');
  let n500 = 0;
  plan('/boom/chat/completions', (req, res) => { n500++; jsonReply(res, 500, { error: { message: 'internal' } }); });
  const r7 = await mk(Object.assign({}, CFG, { baseUrl: base + '/boom' })).chat({ messages: [{ role: 'user', content: 'x' }] });
  ok('ok=false', r7.ok === false);
  ok('code=server', r7.code === wb.KIND.SERVER, r7.code);
  ok('总共请求了 maxRetries+1 次', n500 === 3, n500);

  console.log('\n[200 但不是 JSON]');
  plan('/html/chat/completions', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>gateway error</html>'); });
  const r8 = await mk(Object.assign({}, CFG, { baseUrl: base + '/html' })).chat({ messages: [{ role: 'user', content: 'x' }] });
  ok('code=bad-response', r8.code === wb.KIND.BAD_RESPONSE, r8.code);
  ok('不重试', r8.retryable === false);

  console.log('\n[200 但没有内容]');
  plan('/empty/chat/completions', (req, res) => jsonReply(res, 200, { choices: [] }));
  const r9 = await mk(Object.assign({}, CFG, { baseUrl: base + '/empty' })).chat({ messages: [{ role: 'user', content: 'x' }] });
  ok('code=bad-response', r9.code === wb.KIND.BAD_RESPONSE, r9.code);

  console.log('\n[超时]');
  plan('/slow/chat/completions', () => { /* 故意不回 */ });
  const r10 = await mk(Object.assign({}, CFG, { baseUrl: base + '/slow', timeoutMs: 300, maxRetries: 0 })).chat({ messages: [{ role: 'user', content: 'x' }] });
  ok('code=timeout', r10.code === wb.KIND.TIMEOUT, r10.code);
  ok('可重试标记为 true', r10.retryable === true);

  console.log('\n[连不上：端口没开]');
  const r11 = await wb.createClient({
    transport: makeTransport(),
    getConfig: () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', timeoutMs: 500, maxRetries: 0 }),
  }).chat({ messages: [{ role: 'user', content: 'x' }] });
  ok('code=network', r11.code === wb.KIND.NETWORK, r11.code);
  ok('提示检查网络/代理', /连不上|网络/.test(r11.hint), r11.hint);

  console.log('\n[配置缺失不抛异常]');
  const noCfg = wb.createClient({ transport: makeTransport(), getConfig: () => ({}) });
  const r12 = await noCfg.chat({ messages: [] });
  ok('code=no-config', r12.code === wb.KIND.NO_CONFIG, r12.code);
  const badUrl = await wb.createClient({ transport: makeTransport(), getConfig: () => ({ baseUrl: 'ftp://x/y', apiKey: 'k' }) }).chat({ messages: [] });
  ok('非 http(s) 地址被挡住', badUrl.code === wb.KIND.BAD_URL, badUrl.code);

  console.log('\n[熔断]');
  let nBreaker = 0;
  plan('/nb/chat/completions', (req, res) => { nBreaker++; jsonReply(res, 500, { error: { message: 'down' } }); });
  const cb = mk(Object.assign({}, CFG, { baseUrl: base + '/nb', maxRetries: 0 }));
  for (let i = 0; i < 5; i++) await cb.chat({ messages: [{ role: 'user', content: 'x' }] });
  const afterOpen = await cb.chat({ messages: [{ role: 'user', content: 'x' }] });
  ok('连续失败后进入熔断', afterOpen.code === wb.KIND.CIRCUIT, afterOpen.code);
  ok('熔断期间不再打网络', nBreaker === 4, nBreaker);
  cb.reset();
  ok('reset 后立刻放行', (await cb.chat({ messages: [{ role: 'user', content: 'x' }] })).code === wb.KIND.SERVER);

  console.log('\n[ping 自检]');
  plan('/ping/chat/completions', okReply('pong'));
  const pr = await mk(Object.assign({}, CFG, { baseUrl: base + '/ping' })).ping();
  ok('ping 成功带 model 与耗时', pr.ok && pr.model === 'DeepSeek-V4.1-Flash' && typeof pr.ms === 'number', pr);
  const pf = await mk(Object.assign({}, CFG, { baseUrl: base + '/auth' })).ping();
  ok('ping 失败也返回结构化结果（不抛）', pf.ok === false && pf.code === wb.KIND.AUTH, pf);

  console.log('\n[请求体检查]');
  let seen = null;
  plan('/inspect/chat/completions', (req, res) => { seen = { body: req.parsed, auth: req.headers.authorization }; okReply('x')(req, res); });
  await mk(Object.assign({}, CFG, { baseUrl: base + '/inspect' })).chat({
    messages: [{ role: 'user', content: 'hi' }], maxTokens: 32, temperature: 0.2, jsonMode: true,
  });
  ok('Authorization 头正确', seen && seen.auth === 'Bearer test-key', seen && seen.auth);
  ok('model 用配置里的值', seen && seen.body.model === 'DeepSeek-V4.1-Flash', seen && seen.body.model);
  ok('max_tokens 透传', seen && seen.body.max_tokens === 32);
  ok('jsonMode 转成 response_format', seen && seen.body.response_format && seen.body.response_format.type === 'json_object');

  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
