'use strict';

/* ------------------------------------------------------------------ *
 *  生成应用图标
 *
 *  用法： npm run icon          （生成 assets/icon.ico + assets/icon.png …）
 *
 *  为什么不用现成的位图缩放工具：
 *  图标要在 16px 下还能认出「一条字的方框」，靠一次性缩放高分辨率位图是做不到的
 *  —— 细描边会被抹平。所以这里对每个尺寸**单独渲染一次**（Chromium 自己光栅化），
 *  小尺寸还会切换成简化几何（见 assets/icon.html）。零外部依赖、零图像模型调用。
 *
 *  ICO 用「DIB（BMP）条目」而不是 PNG 条目：Windows 对 256 以下的 PNG-in-ICO
 *  支持不齐（旧版 shell 直接不显示），BMP 一路通吃。
 * ------------------------------------------------------------------ */

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const PAGE = path.join(ASSETS, 'icon.html');
const PNG_DIR = path.join(ASSETS, 'png');

/* 每个尺寸单独开一个窗口、截完就 destroy。销毁最后一个窗口时 Electron 默认会退出
   整个应用，下一个尺寸就再也开不出窗口了（报 ERR_FAILED）——必须拦住这个默认行为。 */
app.on('window-all-closed', () => {});

/* 隐藏的透明窗口偶尔会卡住不返回（本机实测过），
   没有看门狗的话这个脚本会无限挂着。走到这一步就明确报错退出。 */
const WATCHDOG_MS = 60000;
const watchdog = setTimeout(() => {
  console.error(`\n  ✗ 超时（${WATCHDOG_MS / 1000}s）：有窗口没渲染出来。重跑一次 npm run icon 即可。\n`);
  app.exit(2);
}, WATCHDOG_MS);

/* ------------------------------------------------------------------ *
 *  ICO 编码
 * ------------------------------------------------------------------ */

/** 一个尺寸 → ICO 里的一个条目：BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码 */
function encodeIcoEntry(size, bgra, premultiplied) {
  const w = size;
  const h = size;
  const rowBytes = w * 4;
  const maskRow = Math.ceil(w / 8);
  const maskStride = (maskRow + 3) & ~3;          // AND 掩码每行要补齐到 4 字节
  const maskSize = maskStride * h;
  const pxSize = rowBytes * h;

  const buf = Buffer.alloc(40 + pxSize + maskSize);

  buf.writeUInt32LE(40, 0);                       // biSize
  buf.writeInt32LE(w, 4);                         // biWidth
  buf.writeInt32LE(h * 2, 8);                     // biHeight = 2×（DIB + 掩码）
  buf.writeUInt16LE(1, 12);                       // biPlanes
  buf.writeUInt16LE(32, 14);                      // biBitCount
  buf.writeUInt32LE(0, 16);                       // biCompression = BI_RGB
  buf.writeUInt32LE(pxSize + maskSize, 20);       // biSizeImage
  buf.writeInt32LE(0, 24);                        // biXPelsPerMeter
  buf.writeInt32LE(0, 28);                        // biYPelsPerMeter
  buf.writeUInt32LE(0, 32);                       // biClrUsed
  buf.writeUInt32LE(0, 36);                       // biClrImportant

  // DIB 的行序是从下往上
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * rowBytes;
    for (let x = 0; x < w; x++) {
      const si = src + x * 4;
      const di = 40 + y * rowBytes + x * 4;
      let b = bgra[si];
      let g = bgra[si + 1];
      let r = bgra[si + 2];
      const a = bgra[si + 3];
      // toBitmap() 给的是预乘 alpha 的字节：直接写进 ICO 会让半透明边缘发黑，
      // 这里还原成直通 alpha
      if (premultiplied && a > 0 && a < 255) {
        b = Math.min(255, Math.round((b * 255) / a));
        g = Math.min(255, Math.round((g * 255) / a));
        r = Math.min(255, Math.round((r * 255) / a));
      }
      buf[di] = b;
      buf[di + 1] = g;
      buf[di + 2] = r;
      buf[di + 3] = a;
    }
  }

  // AND 掩码：alpha < 128 的位置置 1（1bpp 的老接口回退用）
  const maskBase = 40 + pxSize;
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * rowBytes;
    const mrow = maskBase + y * maskStride;
    for (let x = 0; x < w; x++) {
      if (bgra[src + x * 4 + 3] < 128) {
        buf[mrow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return buf;
}

/** 多尺寸 ICO 容器 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);                     // reserved
  header.writeUInt16LE(1, 2);                     // type = icon
  header.writeUInt16LE(entries.length, 4);        // count

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach((e, i) => {
    const p = i * 16;
    dir[p] = e.size >= 256 ? 0 : e.size;          // 0 表示 256
    dir[p + 1] = e.size >= 256 ? 0 : e.size;
    dir[p + 2] = 0;                               // 调色板色数
    dir[p + 3] = 0;                               // reserved
    dir.writeUInt16LE(1, p + 4);                  // planes
    dir.writeUInt16LE(32, p + 6);                 // bitCount
    dir.writeUInt32LE(e.data.length, p + 8);      // bytesInRes
    dir.writeUInt32LE(offset, p + 12);            // imageOffset
    offset += e.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

/** 反向读一遍 ICO，确认目录和字节数都对得上（自检用） */
function parseIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error('ICO 头不合法');
  }
  const n = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = 6 + i * 16;
    const size = buf[p] === 0 ? 256 : buf[p];
    const bytes = buf.readUInt32LE(p + 8);
    const off = buf.readUInt32LE(p + 12);
    if (off + bytes > buf.length) throw new Error(`第 ${i} 个条目越界`);
    if (buf.readUInt32LE(off) !== 40) throw new Error(`第 ${i} 个条目不是 DIB`);
    if (buf.readInt32LE(off + 4) !== size) throw new Error(`第 ${i} 个条目宽度不符`);
    if (buf.readInt32LE(off + 8) !== size * 2) throw new Error(`第 ${i} 个条目高度不符`);
    out.push({ size, bytes, off });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  渲染
 * ------------------------------------------------------------------ */

/** 打开一次设计稿，后续每个尺寸只改页面里的绘制尺寸并按矩形截切 */
async function openSheet() {
  const win = new BrowserWindow({
    width: 320,
    height: 320,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      backgroundThrottling: false,
      offscreen: false,
      sandbox: false,
    },
  });
  await win.loadFile(PAGE);
  await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => setTimeout(r, 60)))');
  return win;
}

/**
 * 截取指定尺寸的图标。
 * 不重建窗口、也不改窗口大小：隐藏窗口的 setBounds 不重排（本项目的已知坑），
 * 所以改成「在页面里把图标画成 N×N，再按矩形裁切」，每个尺寸都是原生光栅化。
 */
async function renderAt(win, size) {
  const tier = await win.webContents.executeJavaScript(`setIconSize(${size})`, true);
  await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)))');

  let img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  const got = img.getSize();
  if (got.width !== size || got.height !== size) {
    img = img.resize({ width: size, height: size, quality: 'best' });
  }

  const bgra = img.toBitmap();
  return { bgra, png: img.toPNG(), tier };
}

/** 有多少比例的像素不是全透明（用来抓「截出一张空白图」这种事故） */
function coverage(bgra) {
  let n = 0;
  for (let i = 3; i < bgra.length; i += 4) if (bgra[i] > 8) n++;
  return n / (bgra.length / 4);
}

/** toBitmap 到底是预乘还是直通 alpha？用一块 50% 红做判定 */
async function probeAlpha() {
  const win = new BrowserWindow({ width: 8, height: 8, show: false, frame: false, transparent: true, backgroundColor: '#00000000' });
  await win.loadURL('data:text/html,<body style="margin:0;background:transparent"><div style="width:8px;height:8px;background:rgba(255,0,0,.5)"></div>');
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>setTimeout(r,60)))');
  const img = await win.webContents.capturePage();
  const b = img.toBitmap();
  const r = b[2];
  const a = b[3];
  win.destroy();
  // 预乘 → R≈128；直通 → R≈255
  const premultiplied = a > 100 && a < 200 && r < 200;
  console.log(`  探针       50% 红 → R=${r} A=${a}　判定：${premultiplied ? '预乘 alpha' : '直通 alpha'}`);
  return premultiplied;
}

/* ------------------------------------------------------------------ *
 *  主流程
 * ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  fs.mkdirSync(PNG_DIR, { recursive: true });
  console.log('\n生成图标');

  // toBitmap() 给的是**预乘 alpha** 的字节（实测 50% 红 → R=128 A=128），
  // 每次生成都重新探一遍，免得哪天 Electron 改了行为之后悄悄输出一圈黑边
  const premultiplied = await probeAlpha();

  const entries = [];
  let bad = 0;
  const win = await openSheet();
  for (const size of SIZES) {
    const { bgra, png, tier } = await renderAt(win, size);

    const cornerA = bgra[3];           // 左上角必须真的透明，否则窗口底没透出来
    const cover = coverage(bgra);      // 也不能整张空白
    fs.writeFileSync(path.join(PNG_DIR, `icon-${size}.png`), png);

    entries.push({ size, data: encodeIcoEntry(size, bgra, premultiplied) });

    const ok = cornerA < 16 && cover > 0.5;
    if (!ok) bad++;
    console.log(
      `  ${String(size).padStart(3)}×${size}  ${tier.padEnd(5)} 覆盖 ${(cover * 100).toFixed(0).padStart(3)}%` +
      `  角落 alpha=${String(cornerA).padStart(3)}  ${String(png.length).padStart(6)} B  ${ok ? '✓' : '✗'}`
    );
  }
  win.destroy();

  const ico = buildIco(entries);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico);

  // 256 的 PNG 留一份：非 Windows 平台 / 网页 / 说明文档都用它
  fs.copyFileSync(path.join(PNG_DIR, 'icon-256.png'), path.join(ASSETS, 'icon.png'));

  const dir = parseIco(fs.readFileSync(path.join(ASSETS, 'icon.ico')));
  console.log('\n  assets/icon.ico');
  console.log('    ' + dir.map((d) => `${d.size}px/${(d.bytes / 1024).toFixed(1)}KB`).join('  '));
  console.log(`    合计 ${(ico.length / 1024).toFixed(1)} KB · ${dir.length} 个尺寸`);

  // 让 Electron 自己读一遍，确认是真能用的图标文件
  const check = nativeImage.createFromPath(path.join(ASSETS, 'icon.ico'));
  if (check.isEmpty()) {
    console.error('\n  ✗ Electron 读不出这个 ICO');
    clearTimeout(watchdog);
    app.exit(1);
    return;
  }
  console.log(`    Electron 读回：${check.getSize().width}×${check.getSize().height}　✓`);

  // 尺寸对照图：浅底看 1:1、深底看 4× 放大，用来判断小尺寸还剩多少信息
  const sheetWin = new BrowserWindow({
    width: 960, height: 430, show: false, frame: false, resizable: false, skipTaskbar: true,
    backgroundColor: '#ffffff',
    webPreferences: { backgroundThrottling: false, sandbox: false },
  });
  await sheetWin.loadFile(path.join(ASSETS, 'icon-sheet.html'));
  await sheetWin.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => setTimeout(r, 250)))');
  const sheet = await sheetWin.webContents.capturePage();
  fs.mkdirSync(path.join(ROOT, 'preview'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'preview', 'icon-sizes.png'), sheet.toPNG());
  sheetWin.destroy();
  console.log('  preview/icon-sizes.png');

  if (bad) {
    console.error(`\n  ✗ 有 ${bad} 个尺寸不正常（透明或空白），图标不要用\n`);
    clearTimeout(watchdog);
    app.exit(1);
    return;
  }
  console.log('\n完成。窗口图标见 main.js，打包图标见 package.json 的 build.win.icon\n');

  clearTimeout(watchdog);
  app.exit(0);
}).catch((err) => {
  console.error(`\n  ✗ 生成失败：${(err && err.message) || err}\n`);
  clearTimeout(watchdog);
  app.exit(1);
});
