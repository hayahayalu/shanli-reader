'use strict';
/* 单行模式：窗口宽度变化后，行表能否重建，且每行仍不溢出、首尾相接 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');

const BOOK = path.join(os.tmpdir(), 'shanli-reader-test', 'utf8-book.txt');
let bad = 0;
function ok(name, cond, extra) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) bad++;
}

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 880, height: 660, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const run = (c) => w.webContents.executeJavaScript(c, true);

  const { parseBook } = require('../lib/book-parser');
  const book = parseBook(BOOK);
  await run('window.__b=' + JSON.stringify(JSON.stringify(book)) + '; loadBook(JSON.parse(window.__b));');
  await run('new Promise(r=>setTimeout(r,600))');

  await run('toggleSingleLine(true)');
  await run('new Promise(r=>setTimeout(r,500))');

  const widths = [880, 640, 1180, 420, 760, 900];

  for (const wpx of widths) {
    // 隐藏窗口 setBounds 不生效，直接改视口尺寸来驱动真实布局
    await run(`(function(){
      els.viewport.style.cssText = 'position:absolute;left:0;top:0;width:${wpx - 16}px;height:46px;overflow:hidden;';
      void els.viewport.offsetWidth;
    })()`);
    await run('new Promise(r=>setTimeout(r,240))');
    await run('reflow(S.pageCharStart)');
    await run('new Promise(r=>setTimeout(r,200))');

    const r = JSON.parse(await run(`(function(){
      var overflowRows = 0, maxOver = 0, gaps = 0;
      var joined = '', covFrom = null, covTo = null, prevEnd = null;
      S.pageCharStart = 0;
      rebuildSinglePages();
      renderPage(0);
      var firstWidth = null;
      for (var i = 0; i < 40; i++) {
        var p = S.pages[0];
        var over = els.content.scrollWidth - els.content.clientWidth;
        if (over > 0) { overflowRows++; if (over > maxOver) maxOver = over; }
        if (firstWidth === null) firstWidth = { sw: els.content.scrollWidth, cw: els.content.clientWidth };
        if (covFrom === null) covFrom = p.start;
        if (prevEnd !== null && p.start !== prevEnd) gaps++;
        prevEnd = p.end;
        covTo = p.end;
        joined += els.content.textContent;
        var before = p.start;
        singleLineStep(1);
        if (S.pages[0].start === before) break;
      }
      var norm = function (s) { return s.replace(/\\s+/g, ''); };
      var raw = (S.flatLine || S.flat).slice(covFrom, covTo);
      return JSON.stringify({
        vpW: els.viewport.clientWidth, lineW: singleLineWidth(),
        padL: getComputedStyle(els.content).paddingLeft,
        overflowRows: overflowRows, maxOver: maxOver, gaps: gaps,
        lines: S.lineStarts.length,
        allFit: norm(joined) === norm(raw),
        firstWidth: firstWidth
      });
    })()`));

    ok(
      `窗宽 ${String(wpx).padStart(4)}px  行宽 ${String(r.lineW).padStart(4)}px  ` +
      `内边距 ${r.padL}  行表 ${String(r.lines).padStart(4)} 项`,
      r.overflowRows === 0 && r.gaps === 0 && r.allFit,
      r.overflowRows ? `溢出 ${r.overflowRows} 行(最多${r.maxOver}px)` : (r.gaps ? `空隙 ${r.gaps}` : '')
    );
  }

  console.log('');
  console.log(bad ? `=== 失败 ${bad} 项 ===` : '=== 全部通过 ===');
  app.exit(bad ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
