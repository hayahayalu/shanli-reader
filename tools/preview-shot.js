'use strict';

/* 外观预览截图：按真实尺寸渲染三种状态并截图。
 *   空状态 / 正文  → 400 × 200（启动尺寸）
 *   单行阅读       → 400 × 20 （真的压成一行，不是「高窗口里居中一行字」）
 *
 * 窗口本身是「完全透明」的，直接截图只会得到一堆透明像素，看不出效果，
 * 所以这里临时刻意铺一层「假壁纸」（左浅右深）来模拟桌面，
 * 用来检查：米白字在明暗两种桌面上是否都读得清、14px 一行能放多少字。
 *
 * 每次改尺寸都重新 loadFile —— 隐藏窗口 setBounds 不会重排，
 * 但「先改尺寸再重新加载」拿到的一定是新尺寸下的真实布局。
 *
 * 用法： npm run shot   → 图片写到项目里的 preview/ 目录
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'preview');
const BOOK = path.join(os.tmpdir(), 'shanli-reader-test', 'utf8-book.txt');

/* 假壁纸：左半浅色、右半深色，两难场景一次看全 */
const WALLPAPER = `
  html {
    background: linear-gradient(90deg, #dfe6ef 0 50%, #1b1f24 50% 100%) !important;
  }
`;

function openWin(width, height) {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2) console.log(`  [渲染层错误] ${msg}`);
  });
  return win;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = openWin(400, 200);
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const wait = (ms) => run(`new Promise(r => setTimeout(r, ${ms}))`);
  const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');

  /** 改到目标尺寸并重新加载（新页面 = 新布局），再按需注入状态 */
  const stage = async (w, h, setup) => {
    win.setBounds({ width: w, height: h }, false);
    await win.loadFile(INDEX);
    await wait(400);
    // 关掉瞬时提示（toast）：它 1.5 秒后自己消失，但截图时常常正好盖在正文上，
    // 而且 20px 高的单行窗口会被它整个糊住
    await run('toast = function () {}; els.toast.classList.remove("show"); els.toast.textContent = "";');
    if (setup) await run(setup);
  };

  /** 铺假壁纸 + 截图（同时存 1:1 与 2× 放大图） */
  const shoot = async (name, note) => {
    // 页码药丸（HUD）是看图要看的东西，闪一下让它显形
    await run(`(function(){
      var s = document.getElementById('__wall');
      if (!s) { s = document.createElement('style'); s.id = '__wall'; document.head.appendChild(s); }
      s.textContent = ${JSON.stringify(WALLPAPER)};
      els.toast.classList.remove('show');
      els.toast.textContent = '';
      if (S.book) showHud();
    })()`);
    await wait(400);
    const img = await win.webContents.capturePage();
    const b = win.getBounds();
    fs.writeFileSync(path.join(OUT, `shot-${name}.png`), img.toPNG());
    const zoom = path.join(OUT, `shot-${name}@2x.png`);
    fs.writeFileSync(zoom, img.resize({ width: b.width * 2, height: b.height * 2 }).toPNG());
    console.log(`  ${name.padEnd(10)} ${b.width + '×' + b.height}  ${note}`);
    console.log(`             ${zoom}`);
  };

  const bookJson = JSON.stringify(JSON.stringify(require('../lib/book-parser').parseBook(BOOK)));
  const loadBookJs = `window.__b=${bookJson}; loadBook(JSON.parse(window.__b)); window.__b=null;`;

  console.log('\n外观预览');

  try {
    /* 1. 空状态 400 × 200 */
    await stage(400, 200, null);
    await shoot('empty', '空状态（未导入书籍）');

    /* 2. 正文（普通分页）400 × 200 */
    await stage(400, 200, loadBookJs);
    await wait(500);
    const info = JSON.parse(await run(`JSON.stringify({
      lines: Math.round(els.content.clientHeight / parseFloat(getComputedStyle(els.content).lineHeight)),
      perPage: S.pages[0] ? S.pages[0].end - S.pages[0].start : 0,
      pages: S.pages.length,
      fs: getComputedStyle(els.content).fontSize
    })`));
    console.log(`  几何      ${info.fs} 字号 · ${info.lines} 行/页 · 每页 ${info.perPage} 字 · 共 ${info.pages} 页`);
    await shoot('normal', '正文（普通分页）');

    /* 3. 单行阅读 400 × 20（真的压成一行） */
    await stage(400, 20, loadBookJs);
    await wait(400);
    await run('toggleSingleLine(true)');
    await wait(700);
    const one = JSON.parse(await run(`JSON.stringify({
      chars: els.content.textContent.length,
      over: els.content.scrollWidth - els.content.clientWidth,
      vh: window.innerHeight
    })`));
    console.log(`  单行      窗口高 ${one.vh}px · 一行 ${one.chars} 字 · 溢出 ${one.over}px`);
    await shoot('single', '单行阅读（窗口就是一行）');
  } catch (err) {
    console.log('  截图失败: ' + (err && err.message ? err.message : err));
    app.exit(1);
    return;
  }

  app.exit(0);
});
