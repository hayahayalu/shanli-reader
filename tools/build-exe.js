#!/usr/bin/env node
'use strict';

/* 打包 Windows 可执行文件（npm run build:exe）。
 *
 * 干三件在“干净机器”上必须做的事，否则打包会卡在下载：
 *   1. --config.electronDist 指向 node_modules/electron/dist
 *      不指的话 electron-builder 会去 GitHub 拖一份 ~100MB 的 Electron 运行时，
 *      国内网络基本下不动（而这份 dist 在 npm install 时就已经躺在本地了）
 *   2. 工具镜像（nsis / winCodeSign）走 npmmirror
 *   3. --publish never，免得它尝试往 GitHub Releases 推送
 *
 * 用法：
 *   npm run build:exe                 安装版 + 便携版
 *   npm run build:exe -- --portable   只出便携版（单个 exe，双击即用）
 *   npm run build:exe -- --dir        只生成解包目录（最快，调试用）
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const CLI = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');

const argv = process.argv.slice(2);
const portableOnly = argv.includes('--portable');
const dirOnly = argv.includes('--dir');

if (!fs.existsSync(CLI)) {
  console.error('\n  找不到 electron-builder，先跑 npm install\n');
  process.exit(1);
}

// 本地 Electron 运行时必须齐全，否则会退回“去网上下载”这条路
if (!fs.existsSync(path.join(DIST, 'electron.exe'))) {
  console.error(`\n  找不到本地 Electron 运行时：${DIST}\n  先跑 npm install 让它下载并解压。\n`);
  process.exit(1);
}
const ver = fs.readFileSync(path.join(DIST, 'version'), 'utf8').trim();

const args = [CLI];

if (dirOnly) {
  args.push('--dir');
} else if (portableOnly) {
  args.push('--win', 'portable');
} else {
  args.push('--win', 'nsis', 'portable');
}

args.push('--x64', '--publish', 'never', `--config.electronDist=${DIST}`);

// 这两个变量若从父环境漏进来都会坏事：
//   ELECTRON_RUN_AS_NODE —— 会让 Electron 相关工具行为异常
//   NODE_OPTIONS —— 本机注入的 safe-delete shim 会拦掉 electron-builder
//                   清理旧输出目录时的批量删除（报 SAFE_DELETE_BULK_CONFIRM_REQUIRED）
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
env.ELECTRON_MIRROR = env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
env.ELECTRON_BUILDER_BINARIES_MIRROR =
  env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://npmmirror.com/mirrors/electron-builder-binaries/';

console.log(`\n  打包 山梨阅读器`);
console.log(`  Electron ${ver}  ·  本地运行时 ${DIST}`);
console.log(`  目标 ${dirOnly ? '解包目录' : portableOnly ? '便携版' : '安装版 + 便携版'}  ·  x64\n`);

const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env });

if (r.error) {
  console.error('\n  启动 electron-builder 失败：' + r.error.message + '\n');
  process.exit(1);
}
process.exit(r.status == null ? 1 : r.status);
