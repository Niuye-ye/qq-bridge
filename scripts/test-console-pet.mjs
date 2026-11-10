// 控制台「手机桌宠」页（src/console/pet.mjs）离线测试。
// 纯函数直测 handler：假 req/res（不启 HTTP 服务），断言只接管 GET /pet、只回 HTML、
// 页面只调允许的只读/控制接口，且不含任何令牌或 state 落盘路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePetRoutes, PET_PAGE_HTML } from '../src/console/pet.mjs';

const SECURITY_HEADERS = { 'x-frame-options': 'SAMEORIGIN', 'x-content-type-options': 'nosniff' };

function makeRes() {
  const res = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { res.status = status; res.headers = headers; },
    end(body) { res.body = body ?? ''; },
  };
  return res;
}

function makeCtx(method, pathname) {
  const res = makeRes();
  return {
    res,
    ctx: {
      req: { method, headers: {} },
      url: new URL('http://127.0.0.1' + pathname),
      res,
      SECURITY_HEADERS,
    },
  };
}

test('GET /pet 回 200 HTML 并带上安全头', async () => {
  const { ctx, res } = makeCtx('GET', '/pet?token=t0k');
  const handled = await handlePetRoutes(ctx);
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(res.body, PET_PAGE_HTML);
  assert.ok(res.body.length > 4000, '页面不能是空壳');
});

test('只接管 GET /pet，其他方法/路径一律 return false 且不写响应', async () => {
  for (const [method, p] of [['POST', '/pet'], ['GET', '/pets'], ['GET', '/'], ['GET', '/llm-key'], ['GET', '/api/socialV2/self']]) {
    const { ctx, res } = makeCtx(method, p);
    assert.equal(await handlePetRoutes(ctx), false, method + ' ' + p + ' 不该被接管');
    assert.equal(res.status, null, method + ' ' + p + ' 不该写响应');
    assert.equal(res.body, '');
  }
});

test('页面数据源只用 self + mood，控制动作只用 turbo/level/activity', () => {
  const html = PET_PAGE_HTML;
  for (const p of ['/api/socialV2/self', '/api/socialV2/mood', '/api/socialV2/turbo', '/api/socialV2/level', '/api/socialV2/activity']) {
    assert.ok(html.includes(p), '页面缺少 ' + p);
  }
  // 不允许偷偷扩权：不碰管理端、不碰人格/记忆/发送、不直接读 state 文件。
  for (const bad of ['/api/admin', '/api/roles', '/api/socialV2/facts', '/api/socialV2/send', '/state/', 'fs.read', 'require(']) {
    assert.ok(!html.includes(bad), '页面不该出现 ' + bad);
  }
});

test('令牌只在浏览器侧拼进请求，不进服务端渲染的 HTML', () => {
  assert.ok(PET_PAGE_HTML.includes('new URLSearchParams(location.search).get("token")'));
  assert.ok(PET_PAGE_HTML.includes('encodeURIComponent'));
  assert.ok(!/token=[A-Za-z0-9_-]{16,}/.test(PET_PAGE_HTML), 'HTML 里不能硬编码令牌');
});

test('页面把外部文本都过一遍转义，避免心情/待办里的字符破坏结构', () => {
  assert.ok(PET_PAGE_HTML.includes('function esc(s)'));
  assert.ok(PET_PAGE_HTML.includes('esc('));
  // 界面上所有动态文本都来自 esc()/textContent，不允许 innerHTML 直接拼未转义变量。
  assert.ok(!/innerHTML\s*=\s*(?!.*map\().*(?<!esc\(.*)\+\s*a\./.test(PET_PAGE_HTML));
  assert.ok(PET_PAGE_HTML.includes('textContent'));
});

test('桌面上有的关键功能都给了入口（心情/好感/她在干嘛/想干的事/去玩/活跃度/暂停）', () => {
  const html = PET_PAGE_HTML;
  for (const label of ['心情', '好感', '她在干嘛', '想干的事', '玩手机', 'Minecraft', '活跃度', '暂停她']) {
    assert.ok(html.includes(label), '页面缺少「' + label + '」');
  }
  for (const id of ['mood', 'aff', 'doing', 'goals', 'life', 'levels', 'pauseBtn', 'playPhone', 'playMc', 'playBoth', 'stopPlay']) {
    assert.ok(html.includes('id="' + id + '"'), '页面缺少元素 #' + id);
  }
});

test('自动刷新有节流：15 秒一轮，不是死循环', () => {
  assert.ok(PET_PAGE_HTML.includes('setInterval(load,15000)'));
  assert.ok(PET_PAGE_HTML.includes('visibilitychange'));
});
