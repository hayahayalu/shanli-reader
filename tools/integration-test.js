'use strict';

/* 端到端集成测试：模拟真实使用流程
   导入书籍 -> 翻页 -> 单行阅读 -> 改底色/透明度 -> 窗口压缩 -> 跳转
*/

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const os = require('os');

const errors = [];
let win = null;

process.on('uncaughtException', (e) => errors.push('main uncaught: ' + e.stack));

app.whenReady().then(async () => {
  // 复刻主进程的窗口配置
  win = new BrowserWindow({
    width: 880, height: 660, show: false,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, lvl, msg, line, src) => {
    if (lvl >= 2) errors.push(`renderer[${lvl}] ${msg} (${path.basename(src)}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('renderer gone: ' + JSON.stringify(d)));

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const run = (c) => win.webContents.executeJavaScript(c, true);

  const ok = (name, cond, extra) => {
    if (cond) console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`);
    else { errors.push(name + (extra ? '  ' + extra : '')); console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`); }
  };

  const { parseBook } = require('../lib/book-parser');
  const dir = path.join(os.tmpdir(), 'shanli-reader-test');

  try {
    await run('new Promise(r=>setTimeout(r,400))');

    /* ---------- 0. 默认外观 ---------- */
    console.log('\n【0】默认外观（14px / 透明底 / 米白字 / 投影）');
    const dflt = JSON.parse(await run(`JSON.stringify({
      fs: S.fontSize, lineFs: S.lineFontSize, alpha: S.bgAlpha, fg: S.fg,
      shadow: S.shadow,
      cssFs: getComputedStyle(document.documentElement).getPropertyValue('--fs').trim(),
      cssAlpha: getComputedStyle(document.documentElement).getPropertyValue('--bg-alpha').trim(),
      cssShadow: getComputedStyle(els.content).textShadow,
      frameBg: getComputedStyle(els.frame, '::before').backgroundColor,
      frameOpacity: getComputedStyle(els.frame, '::before').opacity
    })`));
    ok('默认字号 14px', dflt.fs === 14 && dflt.cssFs === '14px', `${dflt.fs} / ${dflt.cssFs}`);
    ok('单行字号默认同为 14', dflt.lineFs === 14, String(dflt.lineFs));
    ok('默认底色完全透明', dflt.alpha === 0 && dflt.cssAlpha === '0' && dflt.frameOpacity === '0',
      `alpha=${dflt.cssAlpha} 方框层不透明度=${dflt.frameOpacity}`);
    ok('默认文字米白', dflt.fg.toLowerCase() === '#e8e4dc', dflt.fg);
    ok('默认开启文字投影', dflt.shadow === true && dflt.cssShadow !== 'none', dflt.cssShadow);

    // 底色默认全透明 → 方框描边必须独立于底色层，否则窗口边界彻底看不见
    const ring = JSON.parse(await run(`(function(){
      var cs = getComputedStyle(els.frame);
      return JSON.stringify({ w: cs.borderTopWidth, c: cs.borderTopColor, shadow: cs.boxShadow });
    })()`));
    ok('透明底下方框描边仍然可见', ring.w === '1px' && ring.c !== 'rgba(0, 0, 0, 0)',
      `${ring.w} ${ring.c}`);

    win.webContents.send('cmd:toggleFrame');
    await run('new Promise(r=>setTimeout(r,200))');
    const noRing = JSON.parse(await run(`(function(){
      var cs = getComputedStyle(els.frame);
      return JSON.stringify({ c: cs.borderTopColor, shadow: cs.boxShadow });
    })()`));
    ok('可一键关掉方框描边（真正隐形）', noRing.c === 'rgba(0, 0, 0, 0)' && noRing.shadow === 'none',
      `${noRing.c} / ${noRing.shadow}`);
    win.webContents.send('cmd:toggleFrame');
    await run('new Promise(r=>setTimeout(r,200))');

    /* ---------- 1. 导入 txt ---------- */
    console.log('\n【1】导入 txt');
    let book = parseBook(path.join(dir, 'utf8-book.txt'));
    await run('window.__b=' + JSON.stringify(JSON.stringify(book)) + '; loadBook(JSON.parse(window.__b));');
    await run('new Promise(r=>setTimeout(r,600))');
    let s = await run('JSON.stringify({pages:S.pages.length,ch:S.book.chapters.length,toc:S.toc.length,title:S.book.title})');
    s = JSON.parse(s);
    ok('txt 载入', s.ch === 12 && s.pages > 5, `${s.pages} 页 / ${s.ch} 章`);
    ok('空状态已隐藏', await run('els.empty.classList.contains("hide")'));

    /* ---------- 2. 导入 epub ---------- */
    console.log('\n【2】导入 epub');
    book = parseBook(path.join(dir, 'test-book.epub'));
    await run('window.__b=' + JSON.stringify(JSON.stringify(book)) + '; loadBook(JSON.parse(window.__b));');
    await run('new Promise(r=>setTimeout(r,600))');
    s = await run('JSON.stringify({pages:S.pages.length,ch:S.book.chapters.length,title:S.book.title,toc:S.toc.length})');
    s = JSON.parse(s);
    ok('epub 载入', s.ch === 6, `${s.pages} 页 / ${s.ch} 章`);
    ok('书名取元数据', s.title === '测试电子书·山梨', s.title);
    ok('目录可用', s.toc === 6, `${s.toc} 条`);

    /* ---------- 3. GBK 书籍不乱码 ---------- */
    console.log('\n【3】GBK 编码');
    book = parseBook(path.join(dir, 'gbk-book.txt'));
    await run('window.__b=' + JSON.stringify(JSON.stringify(book)) + '; loadBook(JSON.parse(window.__b));');
    await run('new Promise(r=>setTimeout(r,500))');
    const gbkOk = await run('S.book.chapters[0].text.includes("山梨阅读器GBK版") && !/\\uFFFD/.test(els.content.textContent)');
    ok('GBK 中文正常且渲染无乱码', gbkOk);

    /* ---------- 4. 翻页 ---------- */
    console.log('\n【4】翻页');
    await run('goToPage(0)');
    const p0 = await run('els.content.textContent');
    await run('go(1,1)');
    const p1 = await run('els.content.textContent');
    await run('go(-1,-1)');
    const p2 = await run('els.content.textContent');
    ok('下一页内容变化', p0 !== p1);
    ok('上一页能回到原处', p0 === p2);
    await run('goToPage(0)');
    const atFirst = await run('go(-1,-1); S.page');
    ok('首页再上一页被拦截', atFirst === 0);

    /* ---------- 5. 单行阅读 ---------- */
    console.log('\n【5】单行阅读');
    await run('goToPage(3)');
    const anchor = await run('S.pageCharStart');
    await run('toggleSingleLine(true)');
    await run('new Promise(r=>setTimeout(r,500))');
    s = await run('JSON.stringify({single:S.singleLine,body:document.body.classList.contains("single"),pages:S.pages.length,h:S.pages[0].end-S.pages[0].start})');
    s = JSON.parse(s);
    ok('进入单行模式', s.single === true && s.body === true);
    ok('单行每页只放一行', s.pages === 1 && s.h > 3 && s.h < 200, `每行 ${s.h} 字`);
    ok('位置被保留（未跳回开头）', await run('S.pageCharStart > 0'));

    const before = await run('S.pageCharStart');
    await run('singleLineStep(1)');
    const after = await run('S.pageCharStart');
    ok('滚轮/按键前进一行', after > before, `${before} -> ${after}`);

    // 翻页不能有任何过渡动画：单行每次只走一行，位移/淡入看起来就是「文字在抖」
    const anim = JSON.parse(await run(`(function(){
      var cs = getComputedStyle(els.content);
      var touched = [];
      // 连翻 5 行再原路退回，盯住每次渲染后挂在元素上的 class（位置要保持不变）
      for (var i = 0; i < 5; i++) { singleLineStep(1); touched.push(els.content.className); }
      for (var j = 0; j < 5; j++) { singleLineStep(-1); }
      var sheetHit = '';
      for (var s = 0; s < document.styleSheets.length; s++) {
        var rules = document.styleSheets[s].cssRules || [];
        for (var r = 0; r < rules.length; r++) {
          if (rules[r].selectorText && rules[r].selectorText.indexOf('anim-') >= 0) sheetHit = rules[r].selectorText;
        }
      }
      return JSON.stringify({
        prop: cs.transitionProperty, dur: cs.transitionDuration, cls: touched, sheetHit: sheetHit
      });
    })()`));
    ok('单行翻页没有过渡动画', anim.prop === 'none' || anim.dur === '0s',
      `transition=${anim.prop} ${anim.dur}`);
    ok('翻页不给内容挂动画 class',
      anim.cls.every((c) => !/anim-/.test(c)) && anim.sheetHit === '',
      anim.cls.join('|') || '（无 class）');

    await run('singleLineStep(-1)');
    const back = await run('S.pageCharStart');
    ok('后退能回到原位', back === before, `${after} -> ${back}（原 ${before}）`);

    // 连滚 30 次，确认不卡死且位置单调递增
    const scrollRes = await run(`(function(){
      var last = S.pageCharStart, mono = true, moves = 0;
      for (var i = 0; i < 30; i++) {
        singleLineStep(1);
        if (S.pageCharStart <= last) mono = false;
        last = S.pageCharStart; moves++;
      }
      return JSON.stringify({ mono: mono, moves: moves, pos: S.pageCharStart });
    })()`);
    const sr = JSON.parse(scrollRes);
    ok('连续滚 30 行单调前进', sr.mono === true, `到第 ${sr.pos} 字`);

    // 渲染内容确实是一行
    const oneLine = await run(`(function(){
      var cs = getComputedStyle(els.content);
      return JSON.stringify({ ws: cs.whiteSpace, h: els.content.scrollHeight, vh: els.viewport.clientHeight });
    })()`);
    const ol = JSON.parse(oneLine);
    // 不换行：nowrap 或 pre 都可以（pre 用于保留空格，避免测量与渲染宽度不一致）
    ok('单行模式文字不换行', ol.ws === 'nowrap' || ol.ws === 'pre', `white-space=${ol.ws}`);
    ok('单行内容高度约等于一行', ol.h <= ol.vh + 4, `内容 ${ol.h}px / 视口 ${ol.vh}px`);

    // 关键回归：每行渲染出来的文字必须「不溢出可视宽」，且相邻两行首尾相接。
    // 之前量行宽时按「窗口宽 - 24」硬算，而正文实际左右内边距是 26px，
    // 导致每行都超出 28px 被裁掉，读起来上一行与下一行接不上。
    const joinCheck = JSON.parse(await run(`(function(){
      var overflowRows = 0, maxOver = 0;
      var joined = '', covFrom = null, covTo = null;
      var prevEnd = null, gaps = 0;
      for (var i = 0; i < 60; i++) {
        var p = S.pages[0];
        var over = els.content.scrollWidth - els.content.clientWidth;
        if (over > 0) { overflowRows++; if (over > maxOver) maxOver = over; }
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
        overflowRows: overflowRows, maxOver: maxOver,
        gaps: gaps,
        joinedLen: norm(joined).length,
        rawLen: norm(raw).length,
        contiguous: norm(joined) === norm(raw)
      });
    })()`));
    ok('单行每行都不溢出可视宽', joinCheck.overflowRows === 0,
      joinCheck.overflowRows ? `有 ${joinCheck.overflowRows} 行溢出，最多 ${joinCheck.maxOver}px` : '60 行全部刚好放下');
    ok('单行行与行首尾相接（无空隙）', joinCheck.gaps === 0, `断点 ${joinCheck.gaps} 处`);
    ok('单行 60 行文字完整无丢失', joinCheck.contiguous && joinCheck.joinedLen === joinCheck.rawLen,
      `${joinCheck.joinedLen} / ${joinCheck.rawLen} 字`);

    // 单行字号调整（断言相对变化，不写死默认值）
    const lfsBefore = await run('S.lineFontSize');
    await run('lineFontStep(4)');
    await run('new Promise(r=>setTimeout(r,300))');
    const lfsAfter = await run('S.lineFontSize');
    ok('单行字号可调', lfsAfter === lfsBefore + 4, `${lfsBefore} -> ${lfsAfter}`);

    await run('toggleSingleLine(false)');
    await run('new Promise(r=>setTimeout(r,500))');
    const restore = JSON.parse(await run(`JSON.stringify({
      fs: S.fontSize, saved: S._fontBeforeSingle
    })`));
    ok('退出单行后还原正文原字号（而不是单行字号）', restore.fs === restore.saved,
      `正文 ${restore.fs} · 进入前 ${restore.saved} · 单行 ${lfsAfter}`);
    await run('new Promise(r=>setTimeout(r,500))');
    ok('退出单行模式', await run('!S.singleLine && !document.body.classList.contains("single")'));
    ok('退出后回到原书位置附近', await run('S.pageCharStart > 0'));

    /* ---------- 6. 底色 / 透明度 ---------- */
    console.log('\n【6】底色与透明度');
    for (const [color, alpha, label] of [['#1e1e1e', 1, '夜色'], ['#cce8cf', 1, '护眼绿'], ['#f5ecd9', 0, '透明']]) {
      await run(`(function(){ S.bg=${JSON.stringify(color)}; S.bgAlpha=${alpha}; applyTheme(); })()`);
      const st = await run(`JSON.stringify({
        bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
        a: getComputedStyle(document.documentElement).getPropertyValue('--bg-alpha').trim(),
        frameBg: getComputedStyle(els.frame, '::before').backgroundColor
      })`);
      const stt = JSON.parse(st);
      ok(`底色 ${label}`, stt.bg === color && stt.a === String(alpha), `${stt.bg} α=${stt.a}`);
    }

    // 完全透明时窗口底色应该是全透明（不影响文字）
    await run('S.bg="#f5ecd9"; S.bgAlpha=1; applyTheme()');

    // 默认「透明底 + 米白字」下点一个实色预设：必须能看见变化，并自动配上对比色
    await run('S.bg="#1e1e1e"; S.bgAlpha=0; S.fg="#e8e4dc"; applyTheme()');
    win.webContents.send('cmd:bg', '#ffffff');
    await run('new Promise(r=>setTimeout(r,250))');
    const auto = JSON.parse(await run(`JSON.stringify({ a: S.bgAlpha, fg: S.fg })`));
    ok('透明底选实色自动恢复不透明', auto.a === 1, `不透明度 ${auto.a * 100}%`);
    ok('白底自动配深色字（不会白底白字）', auto.fg === '#1a1a1a', auto.fg);

    // 文字投影开关
    win.webContents.send('cmd:toggleShadow');
    await run('new Promise(r=>setTimeout(r,200))');
    ok('文字投影可关闭', (await run('getComputedStyle(els.content).textShadow')) === 'none',
      await run('getComputedStyle(els.content).textShadow'));
    win.webContents.send('cmd:toggleShadow');
    await run('new Promise(r=>setTimeout(r,200))');
    ok('文字投影可再开启', (await run('getComputedStyle(els.content).textShadow')) !== 'none');

    /* ---------- 7. 文字颜色自动对比 ---------- */
    console.log('\n【7】文字自动对比');
    await run('S.bg="#1e1e1e"; autoTextColor()');
    const darkFg = await run('S.fg');
    await run('S.bg="#ffffff"; autoTextColor()');
    const lightFg = await run('S.fg');
    ok('深底色配浅字', darkFg === '#eae6de', darkFg);
    ok('浅底色配深字', lightFg === '#1a1a1a', lightFg);

    /* ---------- 8. 窗口尺寸可压到很小 ---------- */
    console.log('\n【8】窗口尺寸');
    for (const [w, h, label] of [[400, 200, '默认'], [320, 120, '超小'], [160, 60, '极小']]) {
      win.setBounds({ width: w, height: h });
      await run('new Promise(r=>setTimeout(r,500))');
      const st = await run(`JSON.stringify({ p: S.pages.length, vw: els.viewport.clientWidth, vh: els.viewport.clientHeight, per: S.pages.length? S.pages[0].end-S.pages[0].start : 0 })`);
      const stt = JSON.parse(st);
      ok(`${label} ${w}x${h} 能正常分页`, stt.p >= 1 && stt.per > 1, `每页 ${stt.per} 字 / 共 ${stt.p} 页`);
    }
    win.setBounds({ width: 880, height: 660 });
    await run('new Promise(r=>setTimeout(r,400))');

    /* ---------- 9. 跳转 ---------- */
    console.log('\n【9】跳转至');
    await run('goToPage(0)');
    await run('doJump("6章")');
    s = await run('S.pages[S.page].chapterIndex');
    ok('「6章」跳到第 6 章', s === 5, `chapterIndex=${s}`);

    await run('doJump("100%")');
    const lastPage = await run('JSON.stringify({page:S.page,pages:S.pages.length})');
    const lp = JSON.parse(lastPage);
    ok('「100%」跳到末页', lp.page === lp.pages - 1, `第 ${lp.page + 1}/${lp.pages} 页`);

    await run('openToc()');
    ok('目录面板可打开', await run('els.toc.classList.contains("show")'));
    ok('目录项数量正确', await run('document.querySelectorAll(".toc-item").length') === 12);
    await run('els.toc.classList.remove("show")');

    /* ---------- 10. 右键菜单能构建 ---------- */
    console.log('\n【10】右键菜单');
    const ctx = JSON.parse(await run('JSON.stringify(menuContext())'));
    const { buildContextMenu } = require('../menu');
    let menu = null;
    try {
      menu = buildContextMenu(ctx, {});
      ok('菜单构建成功', !!menu);
      const items = menu.items.map((i) => i.label);
      const need = ['导入书籍…', '跳转至…', '单行阅读', '底色', '文字颜色', '窗口尺寸', '窗口置顶', '关于山梨阅读器', '退出阅读器'];
      const missing = need.filter((n) => !items.includes(n));
      ok('必需菜单项齐全', missing.length === 0, missing.length ? '缺少: ' + missing.join(',') : `${items.length} 项`);
    } catch (e) {
      ok('菜单构建成功', false, e.message);
    }

    // 无书状态下的菜单也不能崩
    try {
      buildContextMenu({ hasBook: false, toc: [] }, {});
      ok('无书状态菜单可构建', true);
    } catch (e) {
      ok('无书状态菜单可构建', false, e.message);
    }

    /* ---------- 11. 不记录历史 ---------- */
    console.log('\n【11】无历史记录');
    const fs = require('fs');
    const appData = app.getPath('userData');
    const strayFiles = [];
    try {
      for (const f of fs.readdirSync(appData)) {
        if (/\.(json|db|sqlite|log)$/i.test(f) && !/^(Preferences|Local State|Network Persistent State|TransportSecurity|Trust Tokens|DIPS|SharedStorage|DeviceBoundSession)/.test(f)) {
          strayFiles.push(f);
        }
      }
    } catch { /* 目录可能不存在 */ }
    ok('未写入阅读进度/历史文件', strayFiles.length === 0, strayFiles.length ? strayFiles.join(',') : '干净');

  } catch (err) {
    errors.push('测试异常: ' + (err && err.stack ? err.stack : err));
  }

  console.log('');
  if (errors.length) {
    console.log(`=== 发现 ${errors.length} 个问题 ===`);
    errors.forEach((e) => console.log(' * ' + e));
  } else {
    console.log('=== 全部通过 ===');
  }
  app.exit(errors.length ? 1 : 0);
});
