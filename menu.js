'use strict';

const { app } = require('electron');

/* ------------------------------------------------------------------ *
 *  右键菜单（全部功能入口都收敛在这里）
 * ------------------------------------------------------------------ */

const BG_PRESETS = [
  ['羊皮纸', '#f5ecd9'],
  ['纯白', '#ffffff'],
  ['护眼绿', '#cce8cf'],
  ['夜色', '#1e1e1e'],
  ['深灰', '#2b2b2b'],
  ['淡蓝', '#dce9f7'],
  ['米黄', '#faf3e0'],
];

const TEXT_PRESETS = [
  ['墨黑', '#1a1a1a'],
  ['灰黑', '#3a3a3a'],
  ['深灰', '#5c5c5c'],
  ['米白', '#e8e4dc'],
  ['暖白', '#f2efe9'],
  ['暗金', '#c9a227'],
];

const FONT_FAMILIES = [
  ['系统默认', 'system'],
  ['宋体', '"SimSun", "宋体", serif'],
  ['黑体', '"SimHei", "Microsoft YaHei", sans-serif'],
  ['微软雅黑', '"Microsoft YaHei", "微软雅黑", sans-serif'],
  ['楷体', '"KaiTi", "楷体", serif'],
  ['仿宋', '"FangSong", "仿宋", serif'],
  ['思源宋体', '"Source Han Serif SC", "Noto Serif SC", serif'],
];

const LINE_HEIGHTS = [
  ['紧凑 1.3', 1.3],
  ['标准 1.6', 1.6],
  ['舒适 1.9', 1.9],
  ['宽松 2.2', 2.2],
];

const WIN_PRESETS = [
  ['默认 400 × 200', { width: 400, height: 200 }],
  ['极小 240 × 80', { width: 240, height: 80 }],
  ['超小 320 × 120', { width: 320, height: 120 }],
  ['小窗 560 × 360', { width: 560, height: 360 }],
  ['中等 720 × 520', { width: 720, height: 520 }],
  ['大窗 960 × 700', { width: 960, height: 700 }],
];

const ALPHAS = [
  ['100% 不透明', 1],
  ['90%', 0.9],
  ['80%', 0.8],
  ['70%', 0.7],
  ['60%', 0.6],
  ['45%', 0.45],
  ['30%', 0.3],
  ['完全透明 0%', 0],
];

/** 生成一组 radio 菜单项 */
function radio(list, current, apply) {
  return list.map(([label, value]) => ({
    label,
    type: 'radio',
    checked: String(current) === String(value),
    click: () => apply(value),
  }));
}

/**
 * @param {object} ctx  渲染层传上来的当前状态
 * @param {object} act  动作表
 */
function buildContextMenu(ctx, act) {
  const {
    hasBook = false,
    title = '',
    chapterTitle = '',
    percent = 0,
    page = 0,
    pages = 0,
    bgColor = '#ffffff',
    bgAlpha = 1,
    textColor = '#1a1a1a',
    fontSize = 14,
    lineHeight = 1.6,
    fontFamily = 'system',
    bold = false,
    shadow = true,
    singleLine = false,
    alwaysOnTop = false,
    frameOn = true,
    hasSelection = false,
    toc = [],
    chapterIndex = 0,
  } = ctx;

  const template = [];

  /* ---------- 顶部信息 ---------- */
  template.push({
    label: hasBook
      ? `《${truncate(title, 22)}》 ${chapterTitle ? '· ' + truncate(chapterTitle, 14) : ''}`
      : '未加载书籍',
    enabled: false,
  });
  template.push({
    label: `进度 ${(percent * 100).toFixed(1)}%　第 ${page + 1} / ${Math.max(pages, 1)} 页`,
    enabled: false,
  });
  template.push({ type: 'separator' });

  /* ---------- 书籍 / 阅读 ---------- */
  template.push({
    label: '导入书籍…',
    accelerator: 'Ctrl+O',
    click: () => act.import(),
  });
  template.push({
    label: '打开所在文件夹',
    enabled: hasBook,
    click: () => act.openFolder(),
  });
  template.push({ type: 'separator' });

  template.push({
    label: '目录',
    enabled: hasBook && toc.length > 0,
    submenu: toc.length
      ? toc.slice(0, 150).map((t, i) => ({
          label: `${i + 1}. ${truncate(t.title || '(无标题)', 30)}`,
          type: 'radio',
          checked: i === chapterIndex,
          click: () => act.tocGoto(i),
        }))
      : [{ label: '（本书无目录信息）', enabled: false }],
  });

  template.push({
    label: '上一章',
    accelerator: 'Ctrl+Left',
    enabled: hasBook,
    click: () => act.chapterPrev(),
  });
  template.push({
    label: '下一章',
    accelerator: 'Ctrl+Right',
    enabled: hasBook,
    click: () => act.chapterNext(),
  });
  template.push({
    label: '跳转至…',
    accelerator: 'Ctrl+G',
    enabled: hasBook,
    submenu: [
      { label: '输入章节 / 页码 / 百分比…', click: () => act.jump() },
      { label: '跳到 25%', click: () => act.jumpTo('25%') },
      { label: '跳到 50%', click: () => act.jumpTo('50%') },
      { label: '跳到 75%', click: () => act.jumpTo('75%') },
      { type: 'separator' },
      { label: '回到第一页', click: () => act.jumpTo('1') },
    ],
  });
  template.push({ type: 'separator' });

  template.push({
    label: '上一页',
    accelerator: 'Left',
    enabled: hasBook,
    click: () => act.pagePrev(),
  });
  template.push({
    label: '下一页',
    accelerator: 'Right',
    enabled: hasBook,
    click: () => act.pageNext(),
  });
  template.push({ type: 'separator' });

  /* ---------- 单行阅读 ---------- */
  template.push({
    label: singleLine ? '退出单行阅读' : '单行阅读',
    accelerator: 'Ctrl+L',
    enabled: hasBook,
    click: () => act.singleLine(),
  });
  if (singleLine) {
    template.push({
      label: '单行字号',
      submenu: [
        { label: '放大一行', accelerator: 'Ctrl+=', click: () => act.lineHeightOfLine(1) },
        { label: '缩小一行', accelerator: 'Ctrl+-', click: () => act.lineHeightOfLine(-1) },
      ],
    });
  }
  template.push({ type: 'separator' });

  /* ---------- 外观 ---------- */
  template.push({
    label: '底色',
    submenu: [
      // 默认是全透明的：此时高亮任何一个色值都会误导，先说明清楚
      ...(bgAlpha === 0
        ? [
            { label: '当前：完全透明（文字浮在桌面上）', enabled: false },
            { type: 'separator' },
          ]
        : []),
      ...radio(BG_PRESETS.map(([l, v]) => [l, v]), bgColor.toLowerCase(), (v) =>
        act.bg(v)
      ),
      { type: 'separator' },
      { label: '自定取色…', click: () => act.bgPick() },
      { type: 'separator' },
      { label: `不透明度（当前 ${Math.round(bgAlpha * 100)}%）`, enabled: false },
      ...radio(ALPHAS, bgAlpha, (v) => act.bgAlpha(v)),
    ],
  });

  template.push({
    label: '文字颜色',
    submenu: [
      ...radio(TEXT_PRESETS.map(([l, v]) => [l, v]), textColor.toLowerCase(), (v) =>
        act.textColor(v)
      ),
      { type: 'separator' },
      { label: '深色文字（跟随底色反转）', click: () => act.textColor('auto') },
      { type: 'separator' },
      {
        label: '文字投影（透明底更清晰）',
        type: 'checkbox',
        checked: !!shadow,
        click: () => act.textShadow(),
      },
    ],
  });

  template.push({ type: 'separator' });

  /* ---------- 排版 ---------- */
  template.push({
    label: `字号（当前 ${fontSize}）`,
    submenu: [
      { label: '增大字号', accelerator: 'Ctrl+=', click: () => act.fontUp() },
      { label: '减小字号', accelerator: 'Ctrl+-', click: () => act.fontDown() },
      { type: 'separator' },
      {
        label: '行距',
        submenu: radio(
          LINE_HEIGHTS.map(([l, v]) => [l, v]),
          lineHeight,
          (v) => act.lineHeight(v)
        ),
      },
      { type: 'separator' },
      {
        label: '字体',
        submenu: FONT_FAMILIES.map(([label, stack]) => ({
          label,
          type: 'radio',
          checked: String(fontFamily) === String(stack),
          click: () => act.fontFamily(stack),
        })),
      },
      {
        label: '加粗',
        type: 'checkbox',
        checked: !!bold,
        click: () => act.bold(),
      },
    ],
  });

  template.push({ type: 'separator' });

  /* ---------- 窗口 ---------- */
  template.push({
    label: '窗口尺寸',
    submenu: [
      ...WIN_PRESETS.map(([label, v]) => ({
        label,
        click: () => act.winSize(v),
      })),
      { type: 'separator' },
      { label: '加宽 40px', click: () => act.widthDelta(40) },
      { label: '收窄 40px', click: () => act.widthDelta(-40) },
      { label: '加高 40px', click: () => act.heightDelta(40) },
      { label: '降低 40px', click: () => act.heightDelta(-40) },
    ],
  });

  template.push({
    label: '方框边框',
    type: 'checkbox',
    checked: !!frameOn,
    click: () => act.frameToggle(),
  });

  template.push({
    label: '窗口置顶',
    type: 'checkbox',
    checked: !!alwaysOnTop,
    click: () => act.alwaysOnTop(),
  });

  template.push({
    label: '贴边 / 居中',
    submenu: [
      { label: '居中', click: () => act.center() },
      { type: 'separator' },
      { label: '贴左边', click: () => act.snap('left') },
      { label: '贴右边', click: () => act.snap('right') },
      { label: '贴顶边', click: () => act.snap('top') },
      { label: '贴底边', click: () => act.snap('bottom') },
    ],
  });

  template.push({ type: 'separator' });

  template.push({
    label: '复制选中文字',
    enabled: hasSelection,
    click: () => act.copySelection(),
  });

  template.push({ type: 'separator' });

  template.push({ label: '最小化', click: () => act.minimize() });
  template.push({
    label: '关于山梨阅读器',
    click: () => act.about(),
  });
  template.push({
    label: '退出阅读器',
    accelerator: 'Ctrl+Q',
    click: () => act.exit(),
  });

  return require('electron').Menu.buildFromTemplate(template);
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { buildContextMenu, BG_PRESETS, TEXT_PRESETS };
