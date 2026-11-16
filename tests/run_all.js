#!/usr/bin/env node
/**
 * 全量测试入口（v0.7.2 新增）。
 *
 * 为什么不再用 `node a && node b`：`&&` 在前一套失败时会短路，后面几套根本不跑；
 * 而 npm 的 `&` 串行写法在 cmd.exe 下语义不同，Windows 上会并发或在后台跑。
 * 这里用 Node 逐套 spawn（参数走数组、不经 shell），全跑完再汇总退出码，
 * 于是 Windows 与 POSIX 得到同一行为：**失败不遮住后续套件，任一失败即整体失败**。
 *
 * 运行：node tests/run_all.js（或 npm test）
 * 退出码：0 全通过；1 有失败套件或崩溃。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SUITES = [
  'docformat_test.js',
  'gate_test.js',
  'robustness_test.js',
  'rhythm_test.js',
  'crossplatform_test.js',
];

const results = [];

SUITES.forEach((name) => {
  const file = path.join(__dirname, name);
  if (!fs.existsSync(file)) {
    results.push({ name, status: 'MISSING', code: null });
    console.log('SKIP ' + name + '（文件不存在）');
    return;
  }
  console.log('\n=== ' + name + ' ' + '='.repeat(Math.max(0, 50 - name.length)));
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  const crashed = r.status === null;
  results.push({ name, status: crashed ? 'CRASH' : (r.status === 0 ? 'PASS' : 'FAIL'), code: r.status });
});

const bad = results.filter((r) => r.status !== 'PASS');
console.log('\n' + '='.repeat(56));
console.log('全量回归：' + (results.length - bad.length) + ' / ' + results.length + ' 套通过');
results.forEach((r) => console.log('  ' + (r.status === 'PASS' ? '✔' : '✘') + ' ' + r.name + '（' + r.status + '）'));
console.log('注意：本入口只跑 tests/ 下的 Node 套件；author 侧的 tools/verify.py 不在此列。');
process.exitCode = bad.length ? 1 : 0;