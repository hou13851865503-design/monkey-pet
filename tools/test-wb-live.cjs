// 端到端联调：起一个假 WorkBuddy 接口，然后让 Electron 真的去调它
// 验证的是「Electron net.request 传输层 + wb.js 客户端 + 桌宠主流程不被拖垮」这条真实链路
// 跑法：node tools/test-wb-live.cjs
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = path.join(os.tmpdir(), 'pet-wb-live.json');
const SETTINGS = path.join(os.tmpdir(), 'pet-wb-live-settings.json');
const UD = path.join(os.tmpdir(), 'pet-wb-live-ud');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const auth = req.headers.authorization || '';
        if (auth !== 'Bearer live-test-key') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        }
        let body = {};
        try { body = JSON.parse(raw); } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: '收到（' + body.model + '）' } }],
          usage: { total_tokens: 7 },
        }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

(async () => {
  const { srv, port } = await startMock();
  try { fs.unlinkSync(OUT); } catch (_) {}
  try { fs.unlinkSync(SETTINGS); } catch (_) {}

  const env = Object.assign({}, process.env, {
    PET_TEST_WB: OUT,
    PET_TEST_WB_URL: 'http://127.0.0.1:' + port + '/v1',
    PET_TEST_WB_KEY: 'live-test-key',
    PET_SETTINGS_PATH: SETTINGS,      // 别把测试配置写进真实 settings.json
  });
  delete env.ELECTRON_RUN_AS_NODE;

  console.log('启动 Electron（接口指向 127.0.0.1:' + port + '）…');
  // 用独立 userData：免得撞上正在运行的桌宠的单实例锁（撞上会静默退出，表现为"没产物"）
  const child = spawn(ELECTRON, ['.', '--no-sandbox', '--user-data-dir=' + UD], { cwd: ROOT, env, stdio: 'ignore' });

  const deadline = Date.now() + 60000;
  while (!fs.existsSync(OUT) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
  }
  await new Promise((r) => setTimeout(r, 600));
  try { child.kill(); } catch (_) {}
  srv.close();

  if (!fs.existsSync(OUT)) {
    console.log('\n  \u2717 没拿到结果文件，Electron 可能没跑起来');
    process.exit(1);
  }
  const r = JSON.parse(fs.readFileSync(OUT, 'utf8'));

  console.log('\n[正常调用]');
  ok('ok=true', r.ok && r.ok.ok === true, r.ok);
  ok('正文来自 mock 服务', r.ok && /收到（DeepSeek-V4\.1-Flash）/.test(r.ok.text), r.ok && r.ok.text);
  ok('模型名就是 DeepSeek-V4.1-Flash', r.ok && r.ok.model === 'DeepSeek-V4.1-Flash', r.ok && r.ok.model);
  ok('usage 透传上来', r.ok && r.ok.usage && r.ok.usage.total_tokens === 7);

  console.log('\n[鉴权失败]');
  ok('ok=false 而不是抛异常', r.auth && r.auth.ok === false, r.auth);
  ok('错误码 auth', r.auth && r.auth.code === 'auth', r.auth && r.auth.code);
  ok('人话提示', r.auth && /鉴权失败/.test(r.auth.error), r.auth && r.auth.error);
  ok('细节里保留服务端原话', r.auth && /invalid api key/.test(r.auth.detail || ''), r.auth && r.auth.detail);

  console.log('\n[未配置]');
  ok('回 no-config 而不是崩', r.none && r.none.code === 'no-config', r.none);

  console.log('\n[连不上]');
  ok('回 network', r.down && r.down.code === 'network', r.down);

  console.log('\n[主流程存活]');
  ok('进程走到最后一步（四次调用无一抛出）', r.alive === true, r);
  ok('没有 fatal', !r.fatal, r.fatal);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
