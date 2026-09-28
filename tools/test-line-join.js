'use strict';
/**
 * 单行模式「行与行是否衔接」专项测试
 *
 * 思路：把每一行真正渲染出来的文字抓下来，拼起来跟原文比对，
 * 看有没有「丢字」（间隙）或「重复字」（重叠）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');

const BOOK = path.join(os.tmpdir(), 'shanli-reader-test', 'utf8-book.txt');

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 880, height: 640, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const errs = [];
  w.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2) errs.push(msg);
  });
  await w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const run = (c) => w.webContents.executeJavaScript(c, true);

  const { parseBook } = require('../lib/book-parser');
  const book = parseBook(BOOK);
  await run('window.__b = ' + JSON.stringify(JSON.stringify(book)) +
    '; loadBook(JSON.parse(window.__b));');
  await run('new Promise(r=>setTimeout(r,600))');

  // 进入单行模式
  await run('toggleSingleLine(true)');
  await run('new Promise(r=>setTimeout(r,400))');

  const info = await run(`(function(){
    return JSON.stringify({
      vpW: els.viewport.clientWidth,
      vpWv2: singleLineWidth(),
      lines: S.lineStarts ? S.lineStarts.length : 0,
      flatLen: S.flat.length,
      start: S.pages[0].start,
      end: S.pages[0].end,
      text: els.content.textContent
    });
  })()`);
  console.log('单行模式初始化:', info);

  // 逐行前进，抓取每行渲染文本
  const trace = await run(`(function(){
    var rows = [];
    for (var i = 0; i < 40; i++) {
      var p = S.pages[0];
      rows.push({
        i: i,
        start: p.start,
        end: p.end,
        rendered: els.content.textContent,
        raw: S.flat.slice(p.start, p.end)
      });
      var before = S.pages[0].start;
      singleLineStep(1);
      if (S.pages[0].start === before) { rows.push({i:'STUCK'}); break; }
    }
    return JSON.stringify(rows);
  })()`);

  const rows = JSON.parse(trace);
  console.log('\n序号 | 起点-终点 | 宽度(起点差) | 渲染文本');
  console.log('-'.repeat(100));
  let gapTotal = 0;
  let overlapCount = 0;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    if (r.i === 'STUCK') { console.log('卡住'); break; }
    const prev = k > 0 ? rows[k - 1] : null;
    const step = prev ? r.start - prev.start : 0;
    console.log(
      String(r.i).padStart(2) + ' | ' +
      String(r.start).padStart(5) + '-' + String(r.end).padStart(5) + ' | ' +
      String(r.end - r.start).padStart(4) + ' | ' +
      JSON.stringify((r.rendered || '').slice(0, 46))
    );
  }

  // 关键校验：把渲染文本按顺序拼起来，跟原文比对
  const check = await run(`(function(){
    // 从 S.pages[0].start 开始连续前进 40 行，收集渲染文本
    var joined = '';
    var firstStart = S.pages[0].start;
    var lastEnd = S.pages[0].end;
    var n = 0;
    for (var i = 0; i < 40; i++) {
      joined += els.content.textContent;
      lastEnd = S.pages[0].end;
      var before = S.pages[0].start;
      singleLineStep(1);
      if (S.pages[0].start === before) break;
      n++;
    }
    var raw = S.flat.slice(firstStart, lastEnd);
    var norm = function(s){ return s.replace(/\\s+/g, ''); };
    return JSON.stringify({
      firstStart: firstStart, lastEnd: lastEnd, lines: n,
      rawLen: norm(raw).length,
      joinedLen: norm(joined).length,
      match: norm(raw) === norm(joined),
      // 找出第一个不一致的位置
      diffAt: (function(){
        var a = norm(raw), b = norm(joined);
        for (var i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) return { i: i, raw: a.slice(Math.max(0,i-12), i+12), got: b.slice(Math.max(0,i-12), i+12) };
        }
        return null;
      })()
    });
  })()`);
  console.log('\n拼接校验:', check);

  // 再测：视觉宽度。每行渲染后文字是否真的铺满了可用宽度
  const widths = await run(`(function(){
    var out = [];
    // 回到第一行
    S.pageCharStart = 0; rebuildSinglePages(); renderPage(0);
    for (var i = 0; i < 12; i++) {
      out.push({
        i: i,
        spanW: Math.round(els.content.scrollWidth),
        boxW: Math.round(els.content.clientWidth),
        text: els.content.textContent
      });
      var before = S.pages[0].start;
      singleLineStep(1);
      if (S.pages[0].start === before) break;
    }
    return JSON.stringify(out);
  })()`);
  console.log('\n视觉宽度（scrollWidth vs clientWidth）:');
  for (const o of JSON.parse(widths)) {
    const fill = (o.spanW / o.boxW * 100).toFixed(1);
    console.log(`  行${String(o.i).padStart(2)}  宽 ${String(o.spanW).padStart(4)}/${o.boxW}  填充 ${fill}%  ${JSON.stringify(o.text.slice(0,40))}`);
  }

  console.log('\n渲染层错误:', errs.length ? errs.join('\n') : '无');
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
