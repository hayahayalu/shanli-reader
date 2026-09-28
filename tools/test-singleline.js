'use strict';

/* 单行阅读的「前进/后退可逆性」专项测试
   要求：在任何位置，前进一行再后退一行，应回到原处（或误差 0）。
*/

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');

let win = null;
const errors = [];

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 880, height: 660, show: false,
    frame: false, transparent: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2) errors.push(`renderer[${lvl}] ${msg}`);
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const run = (c) => win.webContents.executeJavaScript(c, true);

  const { parseBook } = require('../lib/book-parser');
  const book = parseBook(path.join(os.tmpdir(), 'shanli-reader-test', 'utf8-book.txt'));

  await run('window.__b=' + JSON.stringify(JSON.stringify(book)) + '; loadBook(JSON.parse(window.__b));');
  await run('new Promise(r=>setTimeout(r,600))');
  await run('toggleSingleLine(true)');
  await run('new Promise(r=>setTimeout(r,600))');

  console.log('单行模式已就绪，每行字符数 =', await run('measureLineChars(0)'));

  // 先把行表整本建好，否则下面拿不到分散的行号
  const lineCount = await run(`(function(){
    buildLineStarts(S.flatLine.length);
    return S.lineStarts.length;
  })()`);
  console.log('行表项数 =', lineCount);

  // 从多个「行起点」测试可逆性
  // 注意：必须从真实的行边界出发，因为 mid-line 位置会被吸附到所在行
  const res = JSON.parse(await run(`(function(){
    var results = [];
    // 每次都重新取 S.lineStarts：它可能在补行时被替换
    var n = S.lineStarts.length - 2;

    var idxs = [];
    for (var k = 0; k <= 8; k++) idxs.push(Math.floor(n * k / 8));
    [1, 2, 3, 5, 10, 20, 50, 100, 200].forEach(function (x) { if (x < n) idxs.push(x); });

    for (var i = 0; i < idxs.length; i++) {
      var li = Math.max(1, Math.min(idxs[i], n));
      var a = S.lineStarts;
      var origin = a[li];
      var wantBack = a[li - 1];

      S.pageCharStart = origin;
      S.lineIndex = li;
      singleLineStep(-1);
      var afterBack = S.pageCharStart;

      singleLineStep(1);
      var afterFwd = S.pageCharStart;

      results.push({
        line: li,
        origin: origin,
        wantBack: wantBack,
        back: afterBack,
        fwd: afterFwd,
        reversible: afterFwd === origin,
        backOk: afterBack === wantBack,
        delta: afterFwd - origin
      });
    }
    return JSON.stringify(results);
  })()`));

  let bad = 0;
  console.log('\n行号 | 起点 -> 后退 -> 前进（前进应回到起点，后退应到上一行起点）');
  for (const r of res) {
    const ok = r.reversible && r.backOk;
    const mark = ok ? '  ok ' : '  BAD';
    if (!ok) bad++;
    console.log(
      `${mark} 第${String(r.line).padStart(4)}行  ${String(r.origin).padStart(6)} -> ` +
      `${String(r.back).padStart(6)} -> ${String(r.fwd).padStart(6)}` +
      `  (Δ${r.delta >= 0 ? '+' : ''}${r.delta}${r.backOk ? '' : ' 后退错'})`
    );
  }

  // 连续前进 N 次再后退 N 次，也应精确回到原处
  const roundTrip = JSON.parse(await run(`(function(){
    var N = 25;
    var a = S.lineStarts;
    var li = Math.min(40, a.length - 2);
    S.lineIndex = li;
    S.pageCharStart = a[li];
    var origin = S.pageCharStart;
    for (var i = 0; i < N; i++) singleLineStep(1);
    var far = S.pageCharStart;
    for (var j = 0; j < N; j++) singleLineStep(-1);
    return JSON.stringify({ origin: origin, far: far, back: S.pageCharStart, lines: N });
  })()`));
  console.log(`\n往返测试：${roundTrip.origin} -> 前进${roundTrip.lines}行到 ${roundTrip.far} -> 后退回 ${roundTrip.back}`);
  const rtOk = roundTrip.back === roundTrip.origin;
  console.log(rtOk ? '  ok  往返精确可逆' : '  BAD 往返偏差: ' + (roundTrip.back - roundTrip.origin));

  console.log('');
  if (bad > 0 || !rtOk || errors.length) {
    console.log(`=== 失败：可逆性 ${res.length - bad}/${res.length}，往返 ${rtOk ? 'ok' : 'bad'} ===`);
    errors.forEach((e) => console.log(' * ' + e));
    app.exit(1);
  } else {
    console.log(`=== 全部通过：可逆性 ${res.length}/${res.length}，往返 ok ===`);
    app.exit(0);
  }
});
