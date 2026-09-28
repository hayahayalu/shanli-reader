'use strict';

/* 无界面冒烟测试：启动主进程、渲染层，注入一本测试书，检查分页与单行模式 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

const BOOK = path.join(os.tmpdir(), 'shanli-reader-test', 'utf8-book.txt');

const errors = [];
let win = null;
let step = 0;

process.on('uncaughtException', (e) => {
  errors.push('main uncaught: ' + e.stack);
});

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 700,
    height: 500,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      errors.push(`renderer console(level ${level}): ${message} @ ${sourceId}:${line}`);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    errors.push('render process gone: ' + JSON.stringify(d));
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const run = (code) => win.webContents.executeJavaScript(code, true);

  const log = (s) => console.log('  ' + s);

  try {
    // 等渲染层初始化
    await run('new Promise(r => setTimeout(r, 400))');

    // 1. 空状态不应报错
    const s0 = await run('({ hasBook: !!S.book, pages: S.pages.length, flat: S.flat.length })');
    log(`初始化: hasBook=${s0.hasBook} pages=${s0.pages} flat=${s0.flat}`);
    if (s0.hasBook) errors.push('初始化不该有书');

    // 2. 通过解析器载入测试书
    const { parseBook } = require('../lib/book-parser');
    const book = parseBook(BOOK);
    win.__bookJson = JSON.stringify(book);

    // 直接注入并调用 loadBook
    await run(`window.__book = ${win.__bookJson}; loadBook(window.__book);`);
    await run('new Promise(r => setTimeout(r, 600))');

    const s1 = await run(`({
      book: !!S.book,
      title: S.book && S.book.title,
      chapters: S.book ? S.book.chapters.length : 0,
      toc: S.toc.length,
      pages: S.pages.length,
      flat: S.flat.length,
      firstPageText: els.content.textContent.slice(0, 24),
      page0End: S.pages[0] ? S.pages[0].end : -1,
      allSame: S.pages.every(p => p.end > p.start)
    })`);
    log(`载入书籍: title="${s1.title}" 章=${s1.chapters} 目录=${s1.toc} 页=${s1.pages} 字符=${s1.flat}`);
    log(`首页文本: "${s1.firstPageText}"`);
    if (!s1.book) errors.push('书籍未载入');
    if (s1.chapters !== 12) errors.push('章节数应为 12，实际 ' + s1.chapters);
    if (s1.pages < 5) errors.push('页数过少: ' + s1.pages);
    if (!s1.allSame) errors.push('分页区间无效（end <= start）');

    // 3. 翻页
    await run('go(1,1)');
    const s2 = await run('({ page: S.page, text: els.content.textContent.slice(0,20) })');
    log(`翻到下一页: page=${s2.page} text="${s2.text}"`);
    if (s2.page !== 1) errors.push('翻页失败');
    if (s2.text === s1.firstPageText) errors.push('翻页后内容没变');

    // 4. 跳转（章节）
    await run('gotoChapter(5)');
    const s3 = await run('({ page: S.page, ch: S.pages[S.page].chapterIndex, text: els.content.textContent.slice(0,30) })');
    log(`跳到第 6 章: page=${s3.page} chapterIndex=${s3.ch} text="${s3.text.replace(/\\n/g,' ')}"`);
    if (s3.ch !== 5) errors.push('章节跳转错误: ' + s3.ch);

    // 5. 百分比跳转
    await run('doJump("80%")');
    const s4 = await run('({ page: S.page, pages: S.pages.length, pct: (S.page+1)/S.pages.length })');
    log(`跳到 80%: page=${s4.page}/${s4.pages} 实际=${(s4.pct*100).toFixed(1)}%`);
    if (s4.pct < 0.7 || s4.pct > 0.9) errors.push('百分比跳转偏差过大: ' + s4.pct);

    // 6. 字号变化后重排（真正改字号，再统计全书页数）
    const s5 = await run(`(function(){
      paginate(null);
      var beforePages = S.pages.length;
      var beforeFs = S.fontSize;
      // 直接走 fontStep：放大字号
      fontStep(6);
      var afterFs = S.fontSize;
      paginate(null);
      var afterPages = S.pages.length;
      return { beforePages: beforePages, afterPages: afterPages, beforeFs: beforeFs, afterFs: afterFs };
    })()`);
    log(`字号 ${s5.beforeFs} -> ${s5.afterFs}: ${s5.beforePages} 页 -> ${s5.afterPages} 页`);
    if (s5.afterFs <= s5.beforeFs) errors.push('字号未生效: ' + s5.beforeFs + ' -> ' + s5.afterFs);
    if (s5.afterPages <= s5.beforePages) {
      errors.push(`放大字号后页数未增加: ${s5.beforePages} -> ${s5.afterPages}`);
    }

    // 7. 主题
    await run('S.bg="#000000"; S.bgAlpha=0; applyTheme()');
    const s6 = await run(`({
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      a: getComputedStyle(document.documentElement).getPropertyValue('--bg-alpha').trim()
    })`);
    log(`主题: bg=${s6.bg} alpha=${s6.a}`);
    if (s6.a !== '0') errors.push('透明度未生效');
    await run('S.bg="#f5ecd9"; S.bgAlpha=1; applyTheme()');

    // 8. 单行模式：模拟真实窗口尺寸
    await run('S.singleLine = true; document.body.classList.add("single"); rebuildSinglePages(); renderPage(0)');
    await run('new Promise(r => setTimeout(r, 120))');
    const s7 = await run('({ pages: S.pages.length, start: S.pages[0].start, end: S.pages[0].end, text: els.content.textContent })');
    log(`单行模式: 页数=${s7.pages} 区间=[${s7.start},${s7.end}) 文本长度=${s7.text.length}`);
    if (s7.pages !== 1) errors.push('单行模式应只有 1 页');
    if (s7.end <= s7.start) errors.push('单行模式区间无效');

    // 9. 单行逐行前进
    const before9 = s7.start;
    await run('singleLineStep(1)');
    const s8 = await run('({ start: S.pages[0].start, end: S.pages[0].end })');
    log(`单行前进一行: [${s8.start},${s8.end})`);
    if (s8.start <= before9) errors.push('单行前进未生效');

    // 10. 单行逐行后退
    await run('singleLineStep(-1)');
    const s9 = await run('({ start: S.pages[0].start })');
    log(`单行后退一行: start=${s9.start}`);
    if (s9.start >= s8.start) errors.push('单行后退未生效');

    // 11. 滚轮事件在单行模式下应逐行
    await run(`(function(){
      wheelLock = 0;
      const ev = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      els.stage.dispatchEvent(ev);
    })()`);
    await run('new Promise(r => setTimeout(r, 120))');
    const s10 = await run('({ start: S.pages[0].start })');
    log(`滚轮(单行): start=${s10.start}`);
    if (s10.start === s9.start) errors.push('单行模式滚轮未生效');

    // 12. 滚轮在普通模式下应翻页
    await run('toggleSingleLine(false)');
    await run('new Promise(r => setTimeout(r, 500))');
    const beforeW = await run('S.page');
    await run(`(function(){
      wheelAcc = 0; wheelLock = 0;
      els.stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    })()`);
    await run('new Promise(r => setTimeout(r, 150))');
    const afterW = await run('S.page');
    log(`滚轮(普通): page ${beforeW} -> ${afterW}`);
    if (afterW === beforeW) errors.push('普通模式滚轮未翻页');

    // 13. 右键菜单上下文能否正常生成
    const ctxOk = await run(`(function(){
      try { const c = menuContext(); return typeof c.bgColor === 'string' && typeof c.toc.length === 'number'; }
      catch (e) { return 'ERR:' + e.message; }
    })()`);
    log(`右键上下文: ${ctxOk}`);
    if (ctxOk !== true) errors.push('menuContext 异常: ' + ctxOk);

    // 14. 目录列表渲染
    await run('openToc()');
    const tocN = await run('document.querySelectorAll(".toc-item").length');
    log(`目录项渲染: ${tocN}`);
    if (tocN !== 12) errors.push('目录项数不符: ' + tocN);
    await run('els.toc.classList.remove("show")');

    // 15. 跳转输入解析
    const j1 = await run('(function(){ S.page=0; doJump("3章"); return S.pages[S.page].chapterIndex; })()');
    const j2 = await run('(function(){ doJump("50%"); return Math.round((S.page+1)/S.pages.length*100); })()');
    const j3 = await run('(function(){ doJump("第2章 测试章节标题2"); return S.pages[S.page].chapterIndex; })()');
    log(`跳转解析: "3章"->ch${j1}  "50%"->${j2}%  标题文本->ch${j3}`);
    if (j1 !== 2) errors.push('「3章」解析错误');
    if (Math.abs(j2 - 50) > 6) errors.push('「50%」解析偏差: ' + j2);
    if (j3 !== 1) errors.push('标题文本跳转错误: ' + j3);

    // 16. 极小窗口
    win.setBounds({ width: 200, height: 60 });
    await run('new Promise(r => setTimeout(r, 400))');
    const s11 = await run('({ pages: S.pages.length, tiny: document.body.classList.contains("tiny") })');
    log(`极小窗口 200x60: 页数=${s11.pages} tiny=${s11.tiny}`);
    if (s11.pages < 1) errors.push('极小窗口分页失败');

    // 17. 极窄窗口
    win.setBounds({ width: 130, height: 300 });
    await run('new Promise(r => setTimeout(r, 400))');
    const s12 = await run('({ pages: S.pages.length })');
    log(`极窄窗口 130x300: 页数=${s12.pages}`);
    if (s12.pages < 1) errors.push('极窄窗口分页失败');

  } catch (err) {
    errors.push('测试执行异常: ' + (err && err.stack ? err.stack : err));
  }

  console.log('');
  if (errors.length) {
    console.log('=== 发现 ' + errors.length + ' 个问题 ===');
    errors.forEach((e) => console.log(' * ' + e));
  } else {
    console.log('=== 全部通过，无错误 ===');
  }
  app.exit(errors.length ? 1 : 0);
});

/* 把渲染层的 loadBook 源码抓出来，便于在测试里直接调用 */
function loadBookSource() {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const start = src.indexOf('function loadBook(');
  let i = src.indexOf('{', start);
  let depth = 0;
  let end = i;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}') {
      depth--;
      if (depth === 0) { end++; break; }
    }
  }
  return src.slice(start, end);
}
