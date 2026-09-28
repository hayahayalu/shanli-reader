'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, screen, shell, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { parseBook } = require('./lib/book-parser');
const { buildContextMenu, buildTrayMenu } = require('./menu');

/* 应用图标：Windows 用多尺寸 .ico（16px 那档单独画过，任务栏才不糊），
   其他平台用 256 的 PNG。文件不在（比如只拷了源码没跑 npm run icon）也不影响启动。 */
const ICON_ICO = path.join(__dirname, 'assets', 'icon.ico');
const ICON_PNG = path.join(__dirname, 'assets', 'icon.png');
function appIcon() {
  const want = process.platform === 'win32' ? ICON_ICO : ICON_PNG;
  if (fs.existsSync(want)) return want;
  return fs.existsSync(ICON_PNG) ? ICON_PNG : undefined;
}

/* 任务栏分组要用和打包配置一致的 AppID，否则图标会附在 electron.exe 上 */
app.setAppUserModelId('com.shanli.reader');

/* 单实例：第二次启动时聚焦已有窗口 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// 检查是否带 --dev 参数（方便调试）
const isDev = process.argv.includes('--dev');

/* 打包自检的输出路径，由 tools/verify-build.js 注入。
   正常双击启动时这个变量是空的，下面的自检分支完全不会走到。 */
const SELFCHECK_FILE = process.env.SHANLI_SELFCHECK || '';

app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar');

let win = null;
let tray = null;

/* ------------------------------------------------------------------ *
 *  应用状态（全部放在内存，不落盘 —— 按要求不记录历史）
 * ------------------------------------------------------------------ */

const state = {
  alwaysOnTop: false,
  // 单行模式
  singleLine: false,
  savedBounds: null, // 进入单行前记住的窗口尺寸
};

/* ------------------------------------------------------------------ *
 *  窗口
 * ------------------------------------------------------------------ */

const MIN_W = 120;
const MIN_H = 40;

/* 启动尺寸：一个不大的方框，浮在桌面上不挡事 */
const DEFAULT_W = 400;
const DEFAULT_H = 200;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(DEFAULT_W, workArea.width - 20);
  const height = Math.min(DEFAULT_H, workArea.height - 20);

  win = new BrowserWindow({
    width,
    height,
    minWidth: MIN_W,
    minHeight: MIN_H,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    skipTaskbar: false,
    show: false,
    autoHideMenuBar: true,
    title: '山梨阅读器',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
    if (SELFCHECK_FILE) runSelfCheck();
  });

  win.on('closed', () => {
    win = null;
  });

  // 双击标题栏区域最大化由渲染层处理；这里只处理外部链接
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------------------ *
 *  打包自检
 *
 *  打包出来的 exe 套不上 npm script 里的测试套件 —— 那些都是自己造窗口，
 *  验不到 asar 里的路径、preload 桥、图标、内置 GBK 表。所以留一个
 *  「启动即报告」的开关：窗口真正渲染出来之后，把关键状态写成 JSON 再退出。
 *  由 tools/verify-build.js 驱动。
 * ------------------------------------------------------------------ */

function runSelfCheck() {
  const renderErrors = [];

  // level: 0 verbose / 1 info / 2 warning / 3 error
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) renderErrors.push(String(message).slice(0, 300));
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    renderErrors.push('render-process-gone: ' + ((details && details.reason) || '?'));
  });

  // 内置 GBK 映射表能不能从 asar 里读出来 —— 中文 txt 全靠它
  let gbkOk = false;
  try {
    const { decodeBuffer } = require('./lib/book-parser');
    gbkOk = decodeBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])) === '中文';
  } catch (e) {
    gbkOk = 'error: ' + ((e && e.message) || e);
  }

  const icon = appIcon();
  const img = icon ? nativeImage.createFromPath(icon) : null;

  const finish = (probe) => {
    const report = {
      pid: process.pid,
      packaged: app.isPackaged,
      version: app.getVersion(),
      title: win.getTitle(),
      bounds: win.getBounds(),
      visible: win.isVisible(),
      icon: icon ? path.basename(icon) : null,
      iconOk: !!(img && !img.isEmpty()),
      iconSize: img && !img.isEmpty() ? img.getSize() : null,
      gbkOk,
      probe,
      renderErrors,
    };
    try {
      fs.writeFileSync(SELFCHECK_FILE, JSON.stringify(report, null, 2));
    } catch {
      /* 写不出去就只能靠 verify-build 超时发现了 */
    }
    setTimeout(() => app.exit(0), 300);
  };

  win.webContents
    .executeJavaScript(
      `(function(){
        var c = document.getElementById('content');
        var cs = c ? getComputedStyle(c) : null;
        return {
          api: typeof window.api,
          docTitle: document.title,
          frame: !!document.getElementById('frame'),
          content: !!c,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          fontSize: cs && cs.fontSize,
          textShadow: cs && cs.textShadow
        };
      })()`,
      true
    )
    .then(finish)
    .catch((e) => finish({ error: String((e && e.message) || e) }));
}

/** 目前是否有可见窗口 */
const hasWin = () => win && !win.isDestroyed();

function currentBounds() {
  return hasWin() ? win.getBounds() : null;
}

/* ------------------------------------------------------------------ *
 *  单行模式
 * ------------------------------------------------------------------ */

/* 单行模式的窗口最小高度：一行文字的条子本来就很薄。
   普通模式要留 40px 的最小可抓取高度，进去单行就得放开，否则永远比一行厚一倍。 */
const SINGLE_MIN_H = 20;

function enterSingleLine() {
  if (!hasWin() || state.singleLine) return;
  state.savedBounds = win.getBounds();
  const b = state.savedBounds;

  // 高度 = 一行文字的高度，由渲染层算好回传，更精确
  const lineH = Math.max(SINGLE_MIN_H, Number(state.__lineHeight) || 30);
  const targetY = b.y;

  win.setResizable(true);
  win.setMinimumSize(MIN_W, SINGLE_MIN_H);
  win.setBounds({
    x: b.x,
    y: targetY,
    width: Math.max(b.width, 320),
    height: lineH,
  }, false);

  state.singleLine = true;
  send('mode:changed', { singleLine: true, lineHeight: lineH });
}

/** 单行模式下改字号：窗口高度必须跟着走，否则文字被 overflow:hidden 裁掉 */
function resizeSingleLineBar(lineHeight) {
  if (!hasWin() || !state.singleLine) return;
  const h = Math.max(SINGLE_MIN_H, Math.round(Number(lineHeight) || 0));
  const b = win.getBounds();
  if (b.height === h) return;
  win.setBounds({ ...b, height: h }, false);
}

function exitSingleLine() {
  if (!hasWin() || !state.singleLine) return;
  const b = win.getBounds();
  const saved = state.savedBounds || { width: DEFAULT_W, height: DEFAULT_H };
  const { workArea } = screen.getDisplayMatching(b);

  const width = saved.width || DEFAULT_W;
  const height = Math.max(saved.height || DEFAULT_H, 160);

  win.setMinimumSize(MIN_W, MIN_H);
  win.setBounds({
    x: b.x,
    y: Math.min(b.y, workArea.y + workArea.height - height),
    width,
    height,
  }, false);

  state.singleLine = false;
  state.savedBounds = null;
  send('mode:changed', { singleLine: false });
}

function toggleSingleLine(force) {
  const next = typeof force === 'boolean' ? force : !state.singleLine;
  if (next) enterSingleLine();
  else exitSingleLine();
  return state.singleLine;
}

/* ------------------------------------------------------------------ *
 *  渲染层通信助手
 * ------------------------------------------------------------------ */

function send(channel, payload) {
  if (hasWin()) {
    try {
      win.webContents.send(channel, payload);
    } catch {
      /* 窗口正在销毁，忽略 */
    }
  }
}

/* ------------------------------------------------------------------ *
 *  自绘取色器（独立的无边框小窗）
 * ------------------------------------------------------------------ */

let pickerWin = null;
let pickerResolve = null;

function openColorPicker(init) {
  if (pickerWin && !pickerWin.isDestroyed()) {
    pickerWin.focus();
    return Promise.resolve({ ok: false, canceled: true });
  }

  return new Promise((resolve) => {
    pickerResolve = resolve;

    const parentBounds = hasWin() ? win.getBounds() : { x: 200, y: 200, width: 600, height: 400 };
    const W = 320;
    const H = 470;

    pickerWin = new BrowserWindow({
      width: W,
      height: H,
      x: Math.round(parentBounds.x + (parentBounds.width - W) / 2),
      y: Math.round(parentBounds.y + 60),
      parent: hasWin() ? win : undefined,
      modal: false,
      frame: false,
      transparent: false,
      backgroundColor: '#f7f5f0',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      title: '取色',
      webPreferences: {
        preload: path.join(__dirname, 'renderer', 'color-picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    pickerWin.setMenu(null);
    pickerWin.loadFile(path.join(__dirname, 'renderer', 'color-picker.html'));

    pickerWin.once('ready-to-show', () => {
      pickerWin.show();
      pickerWin.webContents.send('colorpicker:init', init);
    });

    pickerWin.on('closed', () => {
      pickerWin = null;
      if (pickerResolve) {
        pickerResolve({ ok: false, canceled: true });
        pickerResolve = null;
      }
    });
  });
}

function finishColorPicker(result) {
  if (pickerResolve) {
    pickerResolve(result);
    pickerResolve = null;
  }
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
  pickerWin = null;
}

/* ------------------------------------------------------------------ *
 *  IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  // ---- 导入书籍 ----
  ipcMain.handle('book:import', async () => {
    const res = await dialog.showOpenDialog(hasWin() ? win : null, {
      title: '导入书籍',
      properties: ['openFile'],
      filters: [
        { name: '电子书', extensions: ['txt', 'epub'] },
        { name: '纯文本', extensions: ['txt'] },
        { name: 'EPUB', extensions: ['epub'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };

    const filePath = res.filePaths[0];
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 300 * 1024 * 1024) {
        return { ok: false, error: '文件超过 300MB，暂不支持' };
      }
      const book = parseBook(filePath);
      send('book:loaded', {
        ...book,
        filePath,
        fileName: path.basename(filePath),
        size: stat.size,
      });
      return { ok: true, title: book.title, chapters: book.chapters.length };
    } catch (err) {
      dialog.showMessageBox(hasWin() ? win : null, {
        type: 'error',
        title: '导入失败',
        message: '无法读取这本书',
        detail: String(err && err.message ? err.message : err),
      });
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  // ---- 主题 / 底色 ----
  ipcMain.on('theme:set', (_e, cfg) => send('theme:apply', cfg));

  /* ---- 取色器窗口 ---- */
  ipcMain.on('colorpicker:done', (_e, result) => {
    const hex = result && /^#[0-9a-f]{6}$/i.test(result.hex || '') ? result.hex : null;
    const alpha = result && typeof result.alpha === 'number'
      ? Math.min(1, Math.max(0, result.alpha))
      : 1;
    if (!hex) return finishColorPicker({ ok: false, canceled: true });
    finishColorPicker({ ok: true, color: hex, alpha });
  });
  ipcMain.on('colorpicker:cancel', () => finishColorPicker({ ok: false, canceled: true }));

  ipcMain.handle('theme:pick', async (_e, current) => {
    return await openColorPicker(current || {});
  });

  // ---- 字号 / 行高 ----
  ipcMain.on('font:set', (_e, cfg) => send('font:apply', cfg));

  // ---- 单行模式 ----
  ipcMain.on('singleline:set', (_e, cfg) => {
    if (cfg && typeof cfg.lineHeight === 'number') {
      const prev = state.__lineHeight;
      state.__lineHeight = cfg.lineHeight;
      // 只在「一行的高度」真的变了（改字号）时调窗口；
      // 同样的值再报一次说明用户自己在拖窗口大小，别跟他抢
      if (prev !== cfg.lineHeight) resizeSingleLineBar(cfg.lineHeight);
    }
    toggleSingleLine(cfg && typeof cfg.on === 'boolean' ? cfg.on : undefined);
  });
  ipcMain.handle('singleline:is', () => state.singleLine);

  // ---- 窗口操作 ----
  ipcMain.on('win:minimize', () => hasWin() && win.minimize());

  ipcMain.on('win:close', () => hasWin() && win.close());

  ipcMain.on('win:setBounds', (_e, b) => {
    if (!hasWin() || !b) return;
    const cur = win.getBounds();
    const next = {
      x: typeof b.x === 'number' ? Math.round(b.x) : cur.x,
      y: typeof b.y === 'number' ? Math.round(b.y) : cur.y,
      width: Math.max(MIN_W, Math.round(b.width ?? cur.width)),
      height: Math.max(MIN_H, Math.round(b.height ?? cur.height)),
    };
    win.setBounds(next, false);
  });

  ipcMain.on('win:resizeBy', (_e, d) => {
    if (!hasWin() || !d) return;
    const cur = win.getBounds();
    const next = {
      width: Math.max(MIN_W, Math.round(cur.width + (d.dw || 0))),
      height: Math.max(MIN_H, Math.round(cur.height + (d.dh || 0))),
    };
    win.setBounds({ ...cur, ...next }, false);
  });

  ipcMain.handle('win:getBounds', () => currentBounds());

  /* 窗口尺寸预设：只改尺寸，不动位置 */
  ipcMain.on('win:applySize', (_e, v) => {
    if (!hasWin() || !v) return;
    const cur = win.getBounds();
    const { workArea } = screen.getDisplayMatching(cur);
    const width = Math.max(MIN_W, Math.round(v.width || cur.width));
    const height = Math.max(MIN_H, Math.round(v.height || cur.height));
    // 保持右边缘/上边缘不动，避免贴边时飞出屏幕
    const x = Math.min(cur.x, workArea.x + workArea.width - width);
    const y = Math.min(cur.y, workArea.y + workArea.height - height);
    win.setBounds({ x: Math.max(workArea.x, x), y: Math.max(workArea.y, y), width, height }, false);
  });

  ipcMain.on('win:center', () => {
    if (!hasWin()) return;
    win.center();
  });

  ipcMain.on('win:snap', (_e, where) => snapWindow(where));

  ipcMain.on('win:alwaysOnTop', (_e, v) => {
    state.alwaysOnTop = typeof v === 'boolean' ? v : !state.alwaysOnTop;
    if (hasWin()) win.setAlwaysOnTop(state.alwaysOnTop, 'floating');
    send('state:alwaysOnTop', state.alwaysOnTop);
  });

  ipcMain.handle('win:isAlwaysOnTop', () => state.alwaysOnTop);

  // ---- 右键菜单 ----
  ipcMain.on('menu:show', (_e, ctx) => {
    if (!hasWin()) return;
    const menu = buildContextMenu(ctx || {}, actions);
    menu.popup({ window: win });
  });

  // ---- 剪贴板 ----
  ipcMain.on('clipboard:write', (_e, text) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });

  // ---- 跳转（由渲染层弹输入框，主进程只做兜底） ----
  ipcMain.on('nav:jump', (_e, target) => send('nav:doJump', target));

  // ---- 退出 ----
  ipcMain.on('app:quit', () => app.quit());

  // ---- 重新载入（调试） ----
  ipcMain.on('app:reload', () => hasWin() && win.webContents.reload());
}

/* ------------------------------------------------------------------ *
 *  窗口动作（菜单与 IPC 共用）
 * ------------------------------------------------------------------ */

const SNAP_GAP = 8;

/** 把窗口贴到屏幕边缘 / 居中（只动位置，不动尺寸） */
function snapWindow(where) {
  if (!hasWin()) return;
  const cur = win.getBounds();
  const { workArea } = screen.getDisplayMatching(cur);
  const pos = { x: cur.x, y: cur.y };
  switch (where) {
    case 'left':
      pos.x = workArea.x + SNAP_GAP;
      break;
    case 'right':
      pos.x = workArea.x + workArea.width - cur.width - SNAP_GAP;
      break;
    case 'top':
      pos.y = workArea.y + SNAP_GAP;
      break;
    case 'bottom':
      pos.y = workArea.y + workArea.height - cur.height - SNAP_GAP;
      break;
    case 'center':
      pos.x = Math.round(workArea.x + (workArea.width - cur.width) / 2);
      pos.y = Math.round(workArea.y + (workArea.height - cur.height) / 2);
      break;
    default:
      return;
  }
  win.setBounds({ ...cur, ...pos }, false);
}

/* ------------------------------------------------------------------ *
 *  菜单动作表
 * ------------------------------------------------------------------ */

const actions = {
  import: () => send('cmd:import'),
  toc: () => send('cmd:toc'),
  tocGoto: (i) => send('cmd:tocGoto', i),
  jump: () => send('cmd:jump'),
  jumpTo: (t) => send('cmd:jumpTo', t),
  chapterPrev: () => send('cmd:chapterPrev'),
  chapterNext: () => send('cmd:chapterNext'),
  pagePrev: () => send('cmd:pagePrev'),
  pageNext: () => send('cmd:pageNext'),
  openFolder: () => send('cmd:openFolder'),

  bg: (v) => send('cmd:bg', v),
  bgPick: () => send('cmd:bgPick'),
  bgAlpha: (v) => send('cmd:bgAlpha', v),
  textColor: (v) => send('cmd:textColor', v),
  textShadow: () => send('cmd:toggleShadow'),

  fontUp: () => send('cmd:fontStep', 1),
  fontDown: () => send('cmd:fontStep', -1),
  lineHeight: (v) => send('cmd:lineHeight', v),
  fontFamily: (v) => send('cmd:fontFamily', v),
  bold: () => send('cmd:toggleBold'),

  singleLine: () => send('cmd:singleLineToggle'),
  lineHeightOfLine: (delta) => send('cmd:lineFontStep', delta),

  winSize: (v) => send('win:applySize', v),
  widthDelta: (dw) => {
    if (hasWin()) win.setBounds({ ...win.getBounds(), width: Math.max(MIN_W, win.getBounds().width + dw) }, false);
  },
  heightDelta: (dh) => {
    if (hasWin()) win.setBounds({ ...win.getBounds(), height: Math.max(MIN_H, win.getBounds().height + dh) }, false);
  },
  frameToggle: () => send('cmd:toggleFrame'),
  alwaysOnTop: () => {
    state.alwaysOnTop = !state.alwaysOnTop;
    if (hasWin()) win.setAlwaysOnTop(state.alwaysOnTop, 'floating');
    send('state:alwaysOnTop', state.alwaysOnTop);
  },
  center: () => hasWin() && win.center(),
  snap: (where) => snapWindow(where),
  minimize: () => hasWin() && win.minimize(),
  close: () => hasWin() && win.close(),
  copySelection: () => send('cmd:copySelection'),
  reload: () => hasWin() && win.webContents.reload(),
  about: () => {
    const opts = {
      type: 'none',
      title: '关于山梨阅读器',
      message: '山梨阅读器',
      detail:
        `版本 ${app.getVersion()}　·　极简本地电子书阅读器\n` +
        '支持 txt / epub，右键菜单就是全部入口。\n' +
        '窗口尺寸、底色、字号、单行阅读都在右键菜单里。',
      icon: fs.existsSync(ICON_PNG) ? nativeImage.createFromPath(ICON_PNG) : undefined,
      buttons: ['好'],
      noLink: true,
    };
    if (hasWin()) dialog.showMessageBox(win, opts);
    else dialog.showMessageBox(opts);
  },
  exit: () => app.quit(),
};

/* ------------------------------------------------------------------ *
 *  启动
 * ------------------------------------------------------------------ */

app.on('second-instance', () => {
  if (hasWin()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  registerIpc();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

module.exports = { send };
