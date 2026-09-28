'use strict';

/* 启动自检：直接 require 真实的 main.js（不是复刻窗口配置），
 * 检查「真正启动时」的窗口尺寸、透明底、渲染桥与首屏状态。
 * 其它测试套件都是自己造窗口，只有这里能验证 main.js 里的窗口参数。
 */

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const errors = [];
const logs = [];
process.on('uncaughtException', (e) => errors.push('main uncaught: ' + (e.stack || e)));

/* 让主进程按真实流程启动 */
require(path.join(__dirname, '..', 'main.js'));

const ok = (name, cond, extra) => {
  if (cond) console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`);
  else {
    errors.push(name + (extra ? '  ' + extra : ''));
    console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`);
  }
};

app.whenReady().then(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1400); // 等 ready-to-show → show()

  const win = BrowserWindow.getAllWindows()[0];
  ok('主进程创建了窗口', !!win && !win.isDestroyed());
  if (!win) {
    finish();
    return;
  }

  win.webContents.on('console-message', (_e, lvl, msg, line, src) => {
    if (lvl >= 2) logs.push(`renderer[${lvl}] ${msg} (${path.basename(src)}:${line})`);
  });

  const b = win.getBounds();
  ok('启动尺寸 400 × 200', b.width === 400 && b.height === 200, `${b.width} × ${b.height}`);

  const { workArea } = require('electron').screen.getDisplayMatching(b);
  const centeredX = Math.abs(b.x - Math.round(workArea.x + (workArea.width - b.width) / 2)) <= 2;
  const centeredY = Math.abs(b.y - Math.round(workArea.y + (workArea.height - b.height) / 2)) <= 2;
  ok('启动时居中显示', centeredX && centeredY, `x=${b.x} y=${b.y}`);

  ok('窗口可继续缩小', win.isResizable() && win.getMinimumSize()[0] <= 120,
    `最小 ${win.getMinimumSize().join(' × ')}`);

  const probe = JSON.parse(
    await win.webContents.executeJavaScript(
      `JSON.stringify({
        api: typeof window.api,
        frame: !!document.getElementById('frame'),
        title: document.title,
        emptyTitle: document.querySelector('.empty-title').textContent.trim(),
        measure: !!document.getElementById('measure'),
        htmlBg: getComputedStyle(document.documentElement).backgroundColor,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        alpha: getComputedStyle(document.documentElement).getPropertyValue('--bg-alpha').trim(),
        fs: getComputedStyle(document.documentElement).getPropertyValue('--fs').trim(),
        fg: getComputedStyle(document.documentElement).getPropertyValue('--fg').trim(),
        ring: getComputedStyle(document.getElementById('frame')).borderTopColor,
        emptyShown: !document.getElementById('empty').classList.contains('hide')
      })`,
      true
    )
  );

  ok('preload 桥已注入', probe.api === 'object', probe.api);
  ok('方框 / 量尺元素就位', probe.frame && probe.measure);
  ok('窗口底色真透明（html/body 无底色）',
    probe.htmlBg === 'rgba(0, 0, 0, 0)' && probe.bodyBg === 'rgba(0, 0, 0, 0)',
    `${probe.htmlBg} / ${probe.bodyBg}`);
  ok('默认 14px / 米白字 / 全透明底',
    probe.fs === '14px' && probe.alpha === '0' && probe.fg.toLowerCase() === '#e8e4dc',
    `${probe.fs} ${probe.fg} α=${probe.alpha}`);
  ok('透明底仍有可见描边', probe.ring !== 'rgba(0, 0, 0, 0)', probe.ring);
  ok('首屏显示空状态引导', probe.emptyShown === true);

  /* 应用名散落在窗口标题、空状态、关于弹窗、打包配置里，改名时最容易漏掉一两处 */
  ok('窗口标题与空状态都是「山梨阅读器」',
    win.getTitle() === '山梨阅读器' && probe.title === '山梨阅读器' && probe.emptyTitle === '山梨阅读器',
    `${win.getTitle()} / ${probe.title} / ${probe.emptyTitle}`);
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  ok('打包名与 AppID 已同步改名',
    pkg.productName === '山梨阅读器' && pkg.build.productName === '山梨阅读器' &&
    pkg.build.appId === 'com.shanli.reader' && pkg.name === 'shanli-reader',
    `${pkg.productName} · ${pkg.build.appId}`);

  await wait(300);
  ok('渲染层无错误', logs.length === 0, logs.join(' | ') || '干净');

  /* ---- 应用图标（窗口/任务栏/打包都用它） ---- */
  const icoPath = path.join(__dirname, '..', 'assets', 'icon.ico');
  const pngPath = path.join(__dirname, '..', 'assets', 'icon.png');
  ok('图标文件就位', fs.existsSync(icoPath) && fs.existsSync(pngPath),
    fs.existsSync(icoPath) ? `${(fs.statSync(icoPath).size / 1024).toFixed(0)} KB` : '缺 assets/icon.ico');
  if (fs.existsSync(icoPath)) {
    // 自己解析一遍 ICO 目录：Electron 能读 ≠ 每档都合法，任务栏会挑其中一档用
    const buf = fs.readFileSync(icoPath);
    const count = buf.readUInt16LE(4);
    const sizes = [];
    let broken = 0;
    for (let i = 0; i < count; i++) {
      const p = 6 + i * 16;
      const size = buf[p] === 0 ? 256 : buf[p];
      const bytes = buf.readUInt32LE(p + 8);
      const off = buf.readUInt32LE(p + 12);
      sizes.push(size);
      if (buf.readUInt32LE(off) !== 40 || buf.readInt32LE(off + 4) !== size || off + bytes > buf.length) broken++;
    }
    ok('ICO 是多尺寸且每档都合法',
      buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1 && count >= 5 && broken === 0,
      `${count} 档 ${sizes.join('/')}${broken ? ` · ${broken} 档损坏` : ''}`);
    ok('任务栏要用的 16 / 32 档都在', sizes.includes(16) && sizes.includes(32));
    const icoImg = nativeImage.createFromPath(icoPath);
    ok('Electron 能读出这个图标', !icoImg.isEmpty(),
      icoImg.isEmpty() ? '读不出来' : `${icoImg.getSize().width}×${icoImg.getSize().height}`);
  }

  /* ---- 单行模式：真窗口的高度必须就是一行文字 ---- */
  const fixture = path.join(require('os').tmpdir(), 'shanli-reader-test', 'utf8-book.txt');
  if (fs.existsSync(fixture)) {
    const { parseBook } = require(path.join(__dirname, '..', 'lib', 'book-parser'));
    const book = parseBook(fixture);
    await win.webContents.executeJavaScript(
      `window.__b=${JSON.stringify(JSON.stringify(book))}; loadBook(JSON.parse(window.__b)); window.__b=null;`,
      true
    );
    await wait(500);

    win.webContents.send('cmd:singleLineToggle');
    await wait(700);
    const bar = win.getBounds();
    const inSingle = await win.webContents.executeJavaScript('S.singleLine && S.pages.length === 1', true);
    ok('单行模式把窗口压成一行高', inSingle === true && bar.height >= 20 && bar.height <= 40,
      `${bar.width} × ${bar.height}`);
    const minNow = win.getMinimumSize();
    ok('单行模式放开最小高度限制', minNow[1] <= 24, `最小高度 ${minNow[1]}`);

    // 单行里放大字号 → 窗口高度必须跟着长，否则文字被 overflow:hidden 裁掉
    win.webContents.send('cmd:lineFontStep', 1);
    await wait(600);
    const taller = win.getBounds();
    ok('单行字号变大时条子跟着变高', taller.height > bar.height,
      `${bar.height}px -> ${taller.height}px`);
    const overflow = await win.webContents.executeJavaScript(
      'els.content.scrollWidth - els.content.clientWidth',
      true
    );
    ok('单行文字没有被裁', overflow <= 0, `溢出 ${overflow}px`);

    win.webContents.send('cmd:singleLineToggle');
    await wait(700);
    const back = win.getBounds();
    ok('退出单行后恢复启动尺寸', back.width === 400 && back.height === 200,
      `${back.width} × ${back.height}`);
    ok('退出单行后收回最小高度限制', win.getMinimumSize()[1] === 40, `最小高度 ${win.getMinimumSize()[1]}`);
  } else {
    console.log('  SKIP  单行窗口测试（缺测试书籍，先跑 npm run books）');
  }

  await wait(200);
  ok('全程渲染层无错误', logs.length === 0, logs.join(' | ') || '干净');

  finish();

  function finish() {
    console.log('');
    if (errors.length) {
      console.log(`=== 发现 ${errors.length} 个问题 ===`);
      errors.forEach((e) => console.log(' * ' + e));
    } else {
      console.log('=== 全部通过 ===');
    }
    app.exit(errors.length ? 1 : 0);
  }
});
