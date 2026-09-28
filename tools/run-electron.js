#!/usr/bin/env node
'use strict';

/**
 * 用 Electron 运行一个脚本 / 应用，并清掉两个会捣乱的环境变量。
 *
 * 1. ELECTRON_RUN_AS_NODE=1
 *    本机环境常驻这个变量，会让 electron.exe 退化成普通 Node，
 *    结果 require('electron').app 是 undefined，窗口根本打不开，
 *    报错还很不直观（像是代码写错了）。
 *
 * 2. NODE_OPTIONS=--require=…/node-language-shim.cjs
 *    本机注入的 Node shim。它会被 Electron 带进子进程，在打包后的 app 里
 *    那个路径不存在，表现是渲染进程直接崩（Renderer process crashed）、
 *    窗口永远读不到标题。
 *
 * 所有 npm script 都走这里，避免每次手工 unset。
 * 用法：node tools/run-electron.js <脚本路径或 .> [额外参数]
 */

const { spawn } = require('child_process');

// 在普通 Node 里 require('electron') 返回可执行文件路径
const electronPath = require('electron');
const args = process.argv.slice(2);

if (!args.length) {
  console.error('用法：node tools/run-electron.js <脚本路径或 .> [额外参数]');
  process.exit(2);
}

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(electronPath, args, { stdio: 'inherit', env });

child.on('error', (err) => {
  console.error('启动 Electron 失败：', err.message);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code == null ? 1 : code);
});
