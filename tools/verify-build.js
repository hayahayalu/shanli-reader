#!/usr/bin/env node
'use strict';

/* 验证打包产物真的能跑（npm run verify:build）。
 *
 * 「打包成功」≠「能跑」：asar 里的路径、preload 桥、图标、内置 GBK 表，都得等
 * 窗口真的渲染出来才算数。这个脚本启动打包后的 exe，让它自己把关键状态写成
 * JSON（main.js 里的 SHANLI_SELFCHECK 分支），再读回来逐项断言。
 *
 * 为什么不用 tasklist 去查进程和窗口标题：
 *   1. 这个 shell 的 PATH 是 git-bash 风格（/c/Windows/...），Node 按它找不到 tasklist.exe
 *   2. 沙箱下 spawnSync 只要用管道就报 EBUSY（stdio 'ignore' / 'inherit' 才可以）
 *   3. 中文 Windows 上 tasklist /V 是 GBK 输出，还得单独解码
 * 让应用自己报告更准，还能顺带验到「渲染进程有没有崩」。
 *
 * 用法：
 *   npm run verify:build               验证 dist/win-unpacked
 *   npm run verify:build -- --portable 验证便携版单文件（要先自解压，慢几秒）
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const PNAME = pkg.build.productName;

const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const TASKKILL = path.join(SYS32, 'taskkill.exe');

const portable = process.argv.includes('--portable');
const portableArtifact = (pkg.build.portable.artifactName || '')
  .replace('${version}', pkg.version)
  .replace('${ext}', 'exe');

const exePath = portable
  ? path.join(ROOT, 'dist', portableArtifact)
  : path.join(ROOT, 'dist', 'win-unpacked', `${PNAME}.exe`);

const beacon = path.join(os.tmpdir(), `shanli-selfcheck-${Date.now()}.json`);

let fail = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 杀掉进程树。taskkill 必须 stdio:'ignore'，用管道会 EBUSY */
function killTree(pid) {
  if (!pid) return;
  spawnSync(TASKKILL, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

(async () => {
  console.log(`\n  验证打包产物${portable ? '（便携版）' : '（解包目录）'}\n`);
  console.log(`  ${exePath}\n`);

  if (!fs.existsSync(exePath)) {
    ok('产物存在', false, '先跑 npm run build:exe');
    process.exit(1);
  }

  try {
    fs.unlinkSync(beacon);
  } catch {
    /* 本来就没有 */
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 漏进来会让它退化成普通 Node，窗口根本开不出
  // 本机注入的 NODE_OPTIONS=--require=…shim 会被带进渲染进程，打包后的 app 里
  // 那个路径不存在，表现是「Renderer process crashed」+ 窗口永远拿不到标题
  delete env.NODE_OPTIONS;
  env.SHANLI_SELFCHECK = beacon;

  const child = spawn(exePath, [], { detached: true, stdio: 'ignore', env });
  child.unref();
  const launchPid = child.pid;

  // 等自检报告落地。便携版要先自解压到临时目录，给足时间
  const deadline = Date.now() + (portable ? 30000 : 20000);
  while (Date.now() < deadline && !fs.existsSync(beacon)) await sleep(400);

  const appeared = fs.existsSync(beacon);
  ok('应用启动并完成自检', appeared, appeared ? '' : `等不到 ${path.basename(beacon)}，窗口大概是没建起来`);
  if (!appeared) {
    killTree(launchPid);
    console.log(`\n  ✗ 无法自检，产物未验证通过\n`);
    process.exit(1);
  }

  let r;
  try {
    r = JSON.parse(fs.readFileSync(beacon, 'utf8'));
  } catch (e) {
    ok('自检报告可解析', false, e.message);
    killTree(launchPid);
    process.exit(1);
  }

  const p = r.probe || {};

  console.log(`  应用版本 ${r.version}  ·  ${r.packaged ? '打包模式' : '开发模式'}\n`);

  ok('以打包模式运行', r.packaged === true);
  ok('窗口标题正确', r.title === PNAME, r.title);
  ok('启动尺寸 400×200', r.bounds.width === 400 && r.bounds.height === 200,
    `${r.bounds.width}×${r.bounds.height}`);
  ok('窗口已显示', r.visible === true);
  ok('preload 桥可用', p.api === 'object', `window.api 是 ${p.api}`);
  ok('渲染层结构完整', p.frame === true && p.content === true,
    `frame=${p.frame} content=${p.content}`);
  ok('页面标题一致', p.docTitle === PNAME, p.docTitle);
  ok('默认底色全透明', p.bodyBg === 'rgba(0, 0, 0, 0)', p.bodyBg);
  ok('默认字号 14px', p.fontSize === '14px', p.fontSize);
  ok('文字投影生效', !!p.textShadow && p.textShadow !== 'none');
  ok('图标能从 asar 里读出来', r.iconOk === true, r.icon ? `${r.icon} ${r.iconSize.width}×${r.iconSize.height}` : '无图标');
  ok('内置 GBK 表可用', r.gbkOk === true, String(r.gbkOk));
  ok('渲染层无错误', r.renderErrors.length === 0, r.renderErrors.join(' | ') || '干净');

  killTree(r.pid);
  killTree(launchPid);
  await sleep(400);
  try {
    fs.unlinkSync(beacon);
  } catch {
    /* 已经没了 */
  }

  console.log(fail ? `\n  ✗ ${fail} 项未通过\n` : '\n  ✓ 打包产物可用\n');
  process.exit(fail ? 1 : 0);
})();
