// 媒体预检单测：node --test scripts/test-media-preflight.mjs
// 纯逻辑，不 spawn 真进程 —— runPython / whichFfmpeg 全部注入假实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  probeVideoEnv,
  modulesFromPythonError,
  prettyModule,
  videoUnavailableText,
} from '../src/mcp/tools/media-preflight.mjs';

const okPy = () => '';

test('环境齐全 -> ok，没有文案', () => {
  const r = probeVideoEnv({
    whichFfmpeg: () => '/usr/bin/ffmpeg',
    python: '/usr/bin/python3',
    scriptPath: '/repo/scripts/make-video.py',
    exists: () => true,
    runPython: () => ({ status: 0, stderr: '' }),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.equal(videoUnavailableText(r.missing), '');
});

test('没有 ffmpeg -> 报 ffmpeg，且不再去 bump python', () => {
  let called = false;
  const r = probeVideoEnv({
    whichFfmpeg: () => null,
    python: '/usr/bin/python3',
    scriptPath: '/repo/scripts/make-video.py',
    exists: () => true,
    runPython: () => { called = true; return { status: 0, stderr: '' }; },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['ffmpeg']);
  assert.equal(called, false);
});

test('缺 Pillow / edge-tts -> 翻成人话名字', () => {
  const r = probeVideoEnv({
    whichFfmpeg: () => 'ffmpeg',
    python: 'python',
    scriptPath: '/repo/scripts/make-video.py',
    exists: () => true,
    runPython: () => ({ status: 1, stderr: "ModuleNotFoundError: No module named 'PIL'\nModuleNotFoundError: No module named 'edge_tts'" }),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['Pillow', 'edge-tts']);
});

test('缺依赖但 stderr 认不出来 -> 给一条兜底名字', () => {
  const r = probeVideoEnv({
    whichFfmpeg: () => 'ffmpeg',
    python: 'python',
    scriptPath: '/repo/scripts/make-video.py',
    exists: () => true,
    runPython: () => ({ status: 2, stderr: 'Segmentation fault' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 1);
  assert.match(r.missing[0], /Pillow/);
});

test('渲染脚本丢了 -> 报渲染脚本', () => {
  const r = probeVideoEnv({
    whichFfmpeg: () => 'ffmpeg',
    python: 'python',
    scriptPath: '/repo/scripts/make-video.py',
    exists: () => false,
    runPython: () => ({ status: 0, stderr: '' }),
  });
  assert.deepEqual(r.missing, ['渲染脚本']);
});

test('探测自己抛异常 -> fail-open 放行', () => {
  const r = probeVideoEnv({
    whichFfmpeg: () => { throw new Error('boom'); },
    python: 'python',
    scriptPath: '/x',
    exists: () => true,
    runPython: okPy,
  });
  assert.equal(r.ok, true);
});

test('python 探针抛异常 -> fail-open 放行', () => {
  const r = probeVideoEnv({
    whichFfmpeg: () => 'ffmpeg',
    python: 'python',
    scriptPath: '/x',
    exists: () => true,
    runPython: () => { throw new Error('spawn ENOENT'); },
  });
  assert.equal(r.ok, true);
});

test('文案：手机版明确劝退重试，PC 版提示装依赖', () => {
  const phone = videoUnavailableText(['Pillow'], { style: 'phone' });
  assert.match(phone, /手机/);
  assert.match(phone, /别硬做/);
  assert.match(phone, /Pillow/);
  const pc = videoUnavailableText(['ffmpeg'], { style: 'pc' });
  assert.match(pc, /机器/);
  assert.doesNotMatch(pc, /手机/);
});

test('modulesFromPythonError 去重且截掉子模块', () => {
  const s = "No module named 'PIL.Image'\nNo module named 'PIL'";
  assert.deepEqual(modulesFromPythonError(s), ['PIL']);
  assert.deepEqual(modulesFromPythonError(''), []);
  assert.deepEqual(modulesFromPythonError(null), []);
});

test('prettyModule 未知名字原样返回', () => {
  assert.equal(prettyModule('numpy'), 'numpy');
  assert.equal(prettyModule('edge_tts'), 'edge-tts');
  assert.equal(prettyModule('foo'), 'foo');
});
