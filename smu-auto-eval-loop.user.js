// ==UserScript==
// @name         南方医科大学 · 随堂评价 一键连评
// @namespace    https://fimmu.local/userscript/auto-eval-loop
// @version      2.0.2
// @description  全自动连续评教（适配 EasyUI）：右上角搜索进入「随堂评价」→ 点日历上标黄的今天 → 查询 → 循环点「进入评价」→ 弹窗内随机 1 题 5 星、其余 4 星 + 单选「否」（点完必核对 radio.checked，未选中就强制勾选）+ 提交（校验失败自动补答重试一次）→ 关掉「评价成功」→ 下一条
// @author       QIU
// @match        *://zhjw.smu.edu.cn/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* =========================================================================
 *  用法：打开教务系统任意页面 → 点右下角「一键连评」→ 之后全自动，按钮自动禁用。
 *
 *  改版了怎么修（全部集中在下面的 CFG 里 / 顶部几个文字常量）：
 *   · 搜索下拉里不叫「随堂评价」 → 改 CFG.KEYWORD
 *   · 按钮不叫「进入评价」       → 改 CFG.ENTER_TEXT（注意：必须完全相等才算命中）
 *   · 提交按钮不叫「提交」       → 改 CFG.SUBMIT_TEXT（按“包含”匹配）
 *   · 星星的 title 不一样        → 改 CFG.HIGH_TITLE / CFG.NORMAL_TITLE
 *   · 全部跑完但一条都没评上     → 打开控制台看 [一键连评] 日志，会打印每条定位结果
 *
 *  本站是 EasyUI，脚本已按它的结构适配（别乱改这几处）：
 *   · 搜索框 = div.right-search-box > span.combo > input.combo-text
 *     EasyUI 的 combobox 只在 keyup 里做过滤，所以脚本是「逐字输入 + 逐字 keyup」，
 *     只派发 input/change 是出不来下拉的（这就是之前搜不到的原因）。
 *   · 日期框 = span.combo.datebox > input.combo-text + span.combo-arrow（点箭头开日历）
 *     ★ 坑：EasyUI 的 class 叫 validatebox-text，字符串里含 "datebox"/"date"，
 *       所以判断日期控件必须按 class 词元比对，不能用 [class*=datebox]。
 *   · 弹窗 = .window / .messager-window，按钮 = .l-btn，弹窗按钮容器 = .messager-button
 *   · 日历面板 = .combo-panel > .calendar，今天/选中格 = calendar-selected / calendar-today
 *   · 单选「否」= <input type="radio" id="10002386"><label for="10002386">否</label>
 *     光点 label 不一定能把 radio 勾上（站点可能 preventDefault），所以脚本点完会核对
 *     radio.checked：没勾上就点 input 本身，再不行强制勾选 + 派发 change；
 *     提交前还会把仍然空着的单选组补上答案（优先含“否”的选项），并打印核对结果。
 * ========================================================================= */

(function () {
  'use strict';

  /* =========================================================================
   * 0) 配置
   * ========================================================================= */
  const CFG = {
    KEYWORD: '随堂评价',        // 右上角搜索框里要输入的词（也是下拉结果里要找的文字）
    ENTER_TEXT: '进入评价',     // 列表里可评价那一列的文字（精确等于才点）
    QUERY_TEXT: '查询',         // 查询按钮文字
    SUBMIT_TEXT: '提交',        // 提交按钮文字（包含即匹配）
    NO_TEXT: '否',              // 单选题要选的那个选项文字（精确等于才点）

    HIGH_TITLE: '非常满意',     // 第 5 颗星的 img title
    NORMAL_TITLE: '满意',       // 第 4 颗星的 img title

    WAIT_SEARCH: 1500,          // 输入搜索词后等下拉
    WAIT_LIST: 1500,            // 点击下拉 / 查询后等列表
    WAIT_MODAL: 2000,           // 点「进入评价」后等弹窗
    WAIT_STEP: 1500,            // 点提交 / 点确定后等状态更新
    WAIT_TICK: 250,             // 轮询粒度

    MODAL_TIMEOUT: 8000,        // 弹窗最多等多久（含 iframe 加载）
    SUCCESS_TIMEOUT: 8000,      // 提交后最多等多久去关「评价成功 / 确定」弹层
    LIST_UPDATE_TIMEOUT: 5000,  // 提交成功后等列表行变成「已评价」的时间
    MAX_ROUNDS: 200,            // 单次运行最多评多少条（防死循环兜底）
    MAX_OPEN_FAIL: 3,           // 连续几次打不开弹窗就停
  };

  /* =========================================================================
   * 1) 基础工具
   * ========================================================================= */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/[\s\u00a0\u3000]+/g, '');

  const log = (...a) => console.log('%c[一键连评]', 'color:#0aa678;font-weight:700', ...a);
  const warn = (...a) => console.warn('%c[一键连评]', 'color:#d9480f;font-weight:700', ...a);
  const err = (...a) => console.error('%c[一键连评]', 'color:#c92a2a;font-weight:700', ...a);

  function isVisible(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    let st = null;
    try { st = win.getComputedStyle(el); } catch (_) { return true; }
    if (!st) return true;
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    return true;
  }

  const domOrder = (a, b) =>
    a === b ? 0 : (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;

  /** 主文档 + 同源 iframe（评教弹窗有可能是 layui iframe 层） */
  function allDocs(depth, base, out) {
    depth = depth || 0;
    base = base || document;
    out = out || [];
    out.push(base);
    if (depth >= 2) return out;
    let frames = [];
    try { frames = Array.prototype.slice.call(base.querySelectorAll('iframe, frame')); } catch (_) { frames = []; }
    for (const f of frames) {
      let d = null;
      try { d = f.contentDocument; } catch (_) { d = null; }
      if (d && d.body) allDocs(depth + 1, d, out);
    }
    return out;
  }

  function queryAllDocs(sel) {
    const out = [];
    for (const doc of allDocs()) {
      let list = [];
      try { list = doc.querySelectorAll(sel); } catch (_) { continue; }
      for (const el of list) out.push(el);
    }
    return out;
  }

  /** 遍历文字节点，返回“自身文字满足条件”的父元素（自动排除脚本自己的 UI） */
  function textLeavesMatch(pred, root) {
    const out = [];
    const rootNode = root || document.body || document.documentElement;
    if (!rootNode) return out;
    const doc = rootNode.ownerDocument || document;
    let walker = null;
    try { walker = doc.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, null); } catch (_) { return out; }
    let node = walker.nextNode();
    while (node) {
      const t = norm(node.nodeValue);
      if (t && pred(t)) {
        const el = node.parentElement;
        if (el && el.closest && !el.closest('#smu-loop-ui') && isVisible(el)) out.push(el);
      }
      node = walker.nextNode();
    }
    return out;
  }

  /** 文字完全相等（空白会被去掉，所以「查 询」也能命中「查询」） */
  const textIs = (text, root) => textLeavesMatch((t) => t === text, root);

  function textIsAnywhere(text) {
    const out = [];
    for (const doc of allDocs()) {
      if (!doc.body) continue;
      const hits = textIs(text, doc.body);
      for (const el of hits) out.push(el);
    }
    return out;
  }

  const deepestOnly = (arr) => arr.filter((el) => !arr.some((o) => o !== el && el.contains(o)));

  /**
   * 精确文字查找（全文档）。
   * 正常走“文字节点”快路径；万一文字被拆成多个节点导致漏掉，
   * 再用整体 textContent 精确相等兜底 —— 依然不会命中「已评价」「评价时间未到」。
   */
  function elementsWithExactText(text) {
    const nodes = textIsAnywhere(text);
    if (nodes.length) return nodes;
    const tagSel = 'a, button, span, td, div, li, .layui-btn, .el-button, .ant-btn, .ivu-btn';
    for (const el of queryAllDocs(tagSel)) {
      if (!isVisible(el)) continue;
      if (norm(el.textContent) !== text) continue;
      let inner = false;
      try { inner = !!el.querySelector(tagSel); } catch (_) {}
      if (inner) continue;                     // 只保留最内层
      nodes.push(el);
    }
    return nodes;
  }

  /* =========================================================================
   * 2) 点击 / 赋值
   * ========================================================================= */
  const CLICKABLE_SEL = 'a, button, [role="button"], input[type="button"], input[type="submit"], .layui-btn, .el-button, .ant-btn, .ivu-btn, .btn, label';

  function clickableOf(el) {
    if (!el) return null;
    const hit = el.closest ? el.closest(CLICKABLE_SEL) : null;
    return hit || el;
  }

  /** 元素自己所属的 window（弹窗可能在 iframe 里，事件必须用那边的构造函数） */
  function winOf(node) {
    try {
      if (!node) return window;
      if (node.nodeType === 9) return node.defaultView || window;          // Document
      return (node.ownerDocument && node.ownerDocument.defaultView) || window;
    } catch (_) {
      return window;
    }
  }

  function makeEvent(node, name, type, init) {
    const w = winOf(node);
    const Ctor = (w && w[name]) || window[name];
    try { return new Ctor(type, init); } catch (_) { return null; }
  }

  function fireEvent(node, name, type, init) {
    const ev = makeEvent(node, name, type, init || { bubbles: true });
    if (!ev) return false;
    try { node.dispatchEvent(ev); return true; } catch (_) { return false; }
  }

  /**
   * 模拟一次真实点击。
   * pointEl：用哪个元素的坐标当点击点（raty 这类插件是按坐标算分数的，
   *          所以“点父元素”时也要把坐标取在星星身上，否则会算成别的星）。
   */
  async function realClick(el, pointEl) {
    if (!el) return false;
    const ref = pointEl || el;
    try { ref.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    let x = 0;
    let y = 0;
    try {
      const r = ref.getBoundingClientRect();
      x = Math.round(r.left + r.width / 2);
      y = Math.round(r.top + r.height / 2);
    } catch (_) {}
    const win = winOf(el);
    const base = { bubbles: true, cancelable: true, view: win, button: 0, clientX: x, clientY: y, screenX: x, screenY: y };
    for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const ev = makeEvent(el, 'MouseEvent', type, base);
      if (ev) { try { el.dispatchEvent(ev); } catch (_) {} }
    }
    try {
      el.click();
    } catch (_) {
      const ev = makeEvent(el, 'MouseEvent', 'click', base);
      if (ev) { try { el.dispatchEvent(ev); } catch (_) {} }
    }
    return true;
  }

  function setNativeValue(el, value) {
    try {
      const w = winOf(el);
      const Ctor = el.tagName === 'TEXTAREA'
        ? (w.HTMLTextAreaElement || HTMLTextAreaElement)
        : (w.HTMLInputElement || HTMLInputElement);
      const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch (_) {
      el.value = value;
    }
  }

  async function waitFor(fn, timeout, tick) {
    const end = Date.now() + (timeout || 5000);
    const step = tick || CFG.WAIT_TICK;
    while (Date.now() < end) {
      let v = null;
      try { v = fn(); } catch (_) { v = null; }
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  /** 行唯一标识：整行文字（用于“失败跳过”，避免在同一个坏行上死循环） */
  function rowKey(el) {
    let tr = null;
    try { tr = el.closest('tr'); } catch (_) {}
    const base = tr || (el && el.parentElement) || el;
    return norm(base && base.textContent).slice(0, 160);
  }

  /* =========================================================================
   * 3) 第 1 步：右上角搜索 → 点下拉里的「随堂评价」
   * ========================================================================= */
  /**
   * 是不是日期控件（自己或近几层容器）。
   * ★ 注意：EasyUI 的 class 是 `validatebox-text`，里面含有 "datebox" 字样，
   *   所以这里必须按 class 词元判断，绝对不能用 [class*="datebox"] 做子串匹配。
   */
  function isDateWidget(el) {
    const isDateToken = (t) => t === 'datebox' || t.indexOf('datebox') === 0 ||
      t.indexOf('datepicker') >= 0 || t.indexOf('date-picker') >= 0 || t.indexOf('calendar') >= 0;
    let n = el;
    for (let i = 0; i < 5 && n && n.nodeType === 1; i++, n = n.parentElement) {
      const c = typeof n.className === 'string' ? n.className : (n.getAttribute && n.getAttribute('class')) || '';
      for (const t of String(c).toLowerCase().split(/\s+/)) {
        if (t && isDateToken(t)) return n;
      }
    }
    return null;
  }

  function findSearchInput() {
    const inputs = queryAllDocs('input').filter((el) => {
      if (!isVisible(el)) return false;
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type !== 'text' && type !== 'search') return false;
      if (el.disabled || el.readOnly) return false;
      if (el.closest && el.closest('#smu-loop-ui')) return false;
      return true;
    });
    if (!inputs.length) return null;

    const vw = window.innerWidth;
    const topLimit = Math.min(220, window.innerHeight * 0.3);
    let best = null;
    let bestScore = -Infinity;

    for (const el of inputs) {
      const r = el.getBoundingClientRect();
      const clue = [
        el.placeholder, el.getAttribute('title'), el.getAttribute('aria-label'),
        el.getAttribute('name'), el.id, el.className,
      ].join(' ');
      let s = 0;
      if (/搜索|检索|search/i.test(clue)) s += 120;
      if (/日期|date-picker|datepicker/i.test(clue)) s -= 160;           // 日期框不是搜索框
      // 本站（EasyUI）的搜索框：div.right-search-box > span.combo > input.combo-text
      if (el.closest('[class*="right-search" i]')) s += 160;
      if (el.closest('[class*="search" i], [class*="header" i], header, [class*="top" i], [class*="nav" i], [class*="toolbar" i]')) s += 90;
      if (isDateWidget(el)) s -= 220;                                    // 日期框（按 class 词元判断，避开 validatebox）
      if (r.top < 120) s += 70;
      else if (r.top < topLimit) s += 20;
      if (r.left > vw * 0.45) s += 40;                                   // 右上角
      if (r.width >= 80 && r.width <= 520) s += 30;
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return bestScore >= 90 ? best : null;
  }

  function findSearchResult(input) {
    let ir;
    try { ir = input.getBoundingClientRect(); } catch (_) { ir = { top: 0, left: 0, bottom: 0, width: 0 }; }
    const cands = textIsAnywhere(CFG.KEYWORD).filter((el) => el !== input && !input.contains(el));
    if (!cands.length) return null;

    let best = null;
    let bestScore = -Infinity;
    for (const el of cands) {
      let r;
      try { r = el.getBoundingClientRect(); } catch (_) { continue; }
      const dy = r.top - ir.bottom;
      let s = 0;
      if (dy >= -40 && dy <= 600) s += 120 - Math.abs(dy) / 6;          // 下拉就贴在输入框下面
      if (Math.abs(r.left - ir.left) < 420) s += 30;
      if (el.closest('.combo-panel')) s += 300;                         // EasyUI 的下拉面板，最可靠
      if (el.closest('[class*="dropdown" i], [class*="popup" i], [class*="combobox" i], [class*="autocomplete" i]')) s += 90;
      if (el.closest('a, li, [class*="item" i], [class*="option" i], [class*="result" i], [class*="list" i]')) s += 25;
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return best;
  }

  async function goToListPage() {
    const input = findSearchInput();
    if (!input) {
      warn('没找到右上角搜索框');
      return false;
    }
    log('搜索框 →', input);

    try { input.focus(); } catch (_) {}
    await sleep(120);
    setNativeValue(input, '');
    fireEvent(input, 'Event', 'input');
    fireEvent(input, 'Event', 'change');
    await sleep(120);

    // 逐字“输入”：EasyUI 的 combobox 只在 keyup 里做过滤，光派发 input 是出不来下拉的
    const chars = Array.from(CFG.KEYWORD);
    for (let i = 0; i < chars.length; i++) {
      setNativeValue(input, chars.slice(0, i + 1).join(''));
      fireEvent(input, 'Event', 'input');
      fireEvent(input, 'KeyboardEvent', 'keydown', { key: chars[i], bubbles: true, keyCode: 0, which: 0 });
      fireEvent(input, 'KeyboardEvent', 'keyup', { key: chars[i], bubbles: true, keyCode: 0, which: 0 });
      await sleep(50);
    }
    // 再把完整的一次 input / change / keyup 补上（Vue 系框架靠这两个）
    fireEvent(input, 'Event', 'input');
    fireEvent(input, 'Event', 'change');
    fireEvent(input, 'KeyboardEvent', 'keyup', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true });
    log(`已输入「${CFG.KEYWORD}」（逐字 keyup + input/change），等待下拉 1.5s…`);
    await sleep(CFG.WAIT_SEARCH);

    let item = await waitFor(() => findSearchResult(input), 3000);
    if (!item) {
      // 有的控件要按回车才出候选
      for (const type of ['keydown', 'keyup']) {
        fireEvent(input, 'KeyboardEvent', type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
      }
      await sleep(1000);
      item = await waitFor(() => findSearchResult(input), 3000);
    }
    if (!item) {
      warn(`下拉里没找到「${CFG.KEYWORD}」`);
      return false;
    }

    log('点击下拉结果 →', item);
    await realClick(item);
    await sleep(CFG.WAIT_LIST);
    return !!(await waitFor(() => onListPage(), 10000));
  }

  function onListPage() {
    if (!findQueryButton()) return false;
    return !!(
      textIsAnywhere(CFG.ENTER_TEXT).length ||
      textIsAnywhere('已评价').length ||
      textIsAnywhere('评价时间未到').length ||
      textIsAnywhere('课程名称').length
    );
  }

  /* =========================================================================
   * 4) 第 2 步：日期选今天 + 点查询
   * ========================================================================= */
  function findDateInput() {
    const inputs = queryAllDocs('input').filter((el) => isVisible(el) && !(el.closest && el.closest('#smu-loop-ui')));
    if (!inputs.length) return null;

    // ① 自己或外层容器带日期线索（EasyUI 的日期框就是 span.combo.datebox）
    const byClue = inputs.find((el) => {
      const own = [el.className, el.id, el.getAttribute('name'), el.placeholder, el.getAttribute('title')].join(' ');
      if (/日期|date-picker|datepicker/i.test(own)) return true;
      return !!isDateWidget(el);
    });
    if (byClue) return byClue;

    // ② 找「日期」两个字，再找它旁边的 input
    const labels = textLeavesMatch((t) => t.indexOf('日期') === 0 && t.length <= 3);
    for (const lab of labels) {
      let box = lab.parentElement;
      for (let i = 0; i < 3 && box; i++, box = box.parentElement) {
        const inp = Array.prototype.filter.call(box.querySelectorAll('input'), isVisible)[0];
        if (inp) return inp;
      }
    }
    return null;
  }

  function findCalendarIcon(input) {
    const boxes = [input.parentElement, input.parentElement && input.parentElement.parentElement].filter(Boolean);
    for (const box of boxes) {
      let icons = [];
      try { icons = Array.prototype.slice.call(box.querySelectorAll('i, span, a, img, svg')); } catch (_) { icons = []; }
      const hit = icons.find((el) => {
        if (!isVisible(el) || el.contains(input)) return false;
        const clue = (el.getAttribute('class') || '') + ' ' + (el.getAttribute('id') || '');
        return /日历|icon-date|date|calendar|riqi/i.test(clue);
      });
      if (hit) return hit;
    }
    // 兜底：EasyUI 的 span.combo-arrow（点箭头就是打开日期面板）
    try {
      const combo = input.closest('.combo');
      if (combo) {
        const arrow = combo.querySelector('.combo-arrow, .textbox-icon, .textbox-addon');
        if (arrow && isVisible(arrow)) return arrow;
      }
    } catch (_) {}
    return null;
  }

  const PANEL_SEL = [
    '.laydate-main-list-0', '.laydate-content', '.laydate-box', '#layui-laydate',
    '.el-picker-panel', '.el-date-picker', '.el-date-range-picker',
    '.ant-picker-dropdown', '.ant-calendar', '.ant-calendar-picker-container',
    '.ivu-date-picker', '.ivu-picker-panel', '.ui-datepicker',
    '.datepicker', '.date-picker', '.calendar', '.daterangepicker',
    '[class*="laydate" i]', '[class*="datepicker" i]', '[class*="picker-panel" i]', '[class*="calendar" i]',
  ];

  /** 是不是“浮层”（日历面板一定是 absolute/fixed，页面里嵌的日历卡片不是） */
  function isFloating(el) {
    let n = el;
    for (let i = 0; i < 4 && n && n.nodeType === 1; i++, n = n.parentElement) {
      let st = null;
      try { st = (n.ownerDocument && n.ownerDocument.defaultView).getComputedStyle(n); } catch (_) { st = null; }
      if (!st) continue;
      const pos = st.position || '';
      if (pos === 'absolute' || pos === 'fixed') return true;
    }
    return false;
  }

  function findPickerPanel() {
    const cands = [];
    for (const doc of allDocs()) {
      for (const sel of PANEL_SEL) {
        let list = [];
        try { list = doc.querySelectorAll(sel); } catch (_) { continue; }
        for (const el of list) {
          if (!isVisible(el)) continue;
          if (!isFloating(el)) continue;                 // 排除页面里嵌着的日历卡片
          let dayCount = 0;
          try {
            for (const c of el.querySelectorAll('td, a, span, div, li')) {
              if (c.children.length) continue;
              if (/^\d{1,2}$/.test(norm(c.textContent))) dayCount++;
            }
          } catch (_) { dayCount = 0; }
          if (dayCount >= 15) cands.push(el);
        }
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length);  // 取最内层
    return cands[0];
  }

  function findHighlightedDay(panel) {
    let win = window;
    try { win = (panel.ownerDocument && panel.ownerDocument.defaultView) || window; } catch (_) {}
    const cells = [];
    try {
      for (const el of panel.querySelectorAll('td, a, span, div, li, button')) {
        if (el.children.length) continue;
        if (!isVisible(el)) continue;
        const t = norm(el.textContent);
        if (!/^\d{1,2}$/.test(t)) continue;
        const n = parseInt(t, 10);
        if (n >= 1 && n <= 31) cells.push(el);
      }
    } catch (_) {}
    if (!cells.length) return null;

    const hit = cells.find((el) => {
      const cls = (el.getAttribute('class') || '') + ' ' +
        ((el.parentElement && el.parentElement.getAttribute('class')) || '');
      if (/(^|[\s_-])(today|active|current|selected|now|cur|highlight)([\s_-]|$)/i.test(cls)) return true;
      if (el.getAttribute('aria-selected') === 'true') return true;
      if (el.getAttribute('aria-current')) return true;
      // 背景色兜底：被标黄的日期一定有主题色背景
      try {
        const bg = win.getComputedStyle(el).backgroundColor || '';
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          const r = +m[1], g = +m[2], b = +m[3];
          const notGray = Math.abs(r - g) > 25 || Math.abs(g - b) > 25 || Math.abs(r - b) > 25;
          const notWhite = !(r > 245 && g > 245 && b > 245);
          if (notGray && notWhite) return true;
        }
      } catch (_) {}
      return false;
    });

    if (hit) {
      log('高亮日期 =', norm(hit.textContent));
      return hit;
    }
    const today = new Date().getDate();
    const fallback = cells.find((el) => parseInt(norm(el.textContent), 10) === today);
    if (fallback) log(`没读到高亮样式，按今天 ${today} 号点击`);
    return fallback || null;
  }

  async function pickToday() {
    let panel = findPickerPanel();
    if (!panel) {
      const input = findDateInput();
      if (!input) { warn('没找到日期输入框，跳过选日期'); return false; }
      log('日期输入框 →', input);
      await realClick(input);
      await sleep(600);
      panel = findPickerPanel();
      if (!panel) {
        const icon = findCalendarIcon(input);
        if (icon) {
          log('点日历图标 →', icon.getAttribute('class') || icon.tagName);
          await realClick(icon);
          await sleep(600);
          panel = findPickerPanel();
        }
      }
    }
    if (!panel) { warn('日期面板没打开'); return false; }

    const cell = findHighlightedDay(panel);
    if (!cell) { warn('日期面板里没找到标黄的“今天”'); return false; }

    log('点击标黄日期 →', norm(cell.textContent));
    await realClick(cell);
    await sleep(500);

    // 有的日期面板还要再点一次「确定」
    const still = findPickerPanel();
    if (still) {
      let okBtn = null;
      try {
        for (const el of still.querySelectorAll('button, a, span, div')) {
          if (!isVisible(el)) continue;
          if (/^(确定|确认|应用|完成|OK)$/i.test(norm(el.textContent))) okBtn = el;
        }
      } catch (_) {}
      if (okBtn) {
        log('日期面板点确定 →', norm(okBtn.textContent));
        await realClick(okBtn);
        await sleep(400);
      }
    }
    return true;
  }

  function findQueryButton() {
    const leaves = elementsWithExactText(CFG.QUERY_TEXT);
    if (!leaves.length) return null;
    const cands = [];
    for (const el of leaves) {
      const c = clickableOf(el);
      if (c && c.isConnected && isVisible(c) && !c.disabled) cands.push(c);
    }
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];

    // 多个「查询」时，取离日期框最近的那个
    const dateInput = findDateInput();
    if (!dateInput) return cands[0];
    let dr;
    try { dr = dateInput.getBoundingClientRect(); } catch (_) { return cands[0]; }
    cands.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const sa = Math.abs(ra.left - dr.right) + Math.abs(ra.top - dr.top) * 2;
      const sb = Math.abs(rb.left - dr.right) + Math.abs(rb.top - dr.top) * 2;
      return sa - sb;
    });
    return cands[0];
  }

  async function pickTodayAndQuery() {
    setStatus('选当天日期…');
    const ok = await pickToday();
    if (!ok) warn('日期没选上，直接用当前条件查询');

    setStatus('点击查询…');
    const qb = findQueryButton();
    if (!qb) throw new Error(`没找到「${CFG.QUERY_TEXT}」按钮`);
    log('查询按钮 →', qb);
    await realClick(qb);
    await sleep(CFG.WAIT_LIST);

    // 再等一会儿 loading 遮罩消失，避免拿着旧表格开始点
    await waitFor(() => !isLoading(), 5000);
    await sleep(400);
    log('列表已刷新');
  }

  function isLoading() {
    const sel = '.layui-layer-loading, .el-loading-mask, .ant-spin-spinning, .ivu-spin-fix, .loading-mask, .loading,' +
      '.datagrid-mask, .datagrid-mask-msg, .window-mask, .panel-loading';
    for (const doc of allDocs()) {
      let list = [];
      try { list = doc.querySelectorAll(sel); } catch (_) { continue; }
      for (const el of list) if (isVisible(el)) return true;
    }
    return false;
  }

  /* =========================================================================
   * 5) 第 3 步：核心循环 —— 只认「进入评价」
   * ========================================================================= */
  function findEnterButton(failed) {
    const leaves = elementsWithExactText(CFG.ENTER_TEXT);
    const seen = new Set();
    const out = [];
    for (const el of leaves) {
      const c = clickableOf(el);
      if (!c || seen.has(c)) continue;
      if (!c.isConnected || !isVisible(c)) continue;
      if (c.disabled || c.getAttribute('aria-disabled') === 'true') continue;
      if (failed && failed.has(rowKey(c))) continue;
      seen.add(c);
      out.push(c);
    }
    if (!out.length) return null;
    try { out.sort(domOrder); } catch (_) {}
    return out[0];
  }

  async function waitRowUpdated(before, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (textIsAnywhere(CFG.ENTER_TEXT).length < before) return true;
      await sleep(300);
    }
    return false;
  }

  function debugRowTexts() {
    try {
      const set = new Set();
      for (const el of textLeavesMatch((t) => t.length <= 8 && /评价|未到/.test(t))) {
        set.add(norm(el.textContent));
        if (set.size >= 10) break;
      }
      log('页面上出现的状态文字样本：', Array.from(set));
    } catch (_) {}
  }

  async function loopEval() {
    const st = { total: 0, ok: 0, failed: new Set(), openFail: 0 };

    while (true) {
      if (st.total >= CFG.MAX_ROUNDS) {
        warn(`到达最大轮次 ${CFG.MAX_ROUNDS}，停止（防止意外死循环）`);
        break;
      }

      await ensureNoEvalModal();
      await dismissStrayDialog();

      const btn = findEnterButton(st.failed);
      if (!btn) {
        log('页面上已经没有可点的「进入评价」了');
        break;
      }

      st.total++;
      const key = rowKey(btn);
      const before = textIsAnywhere(CFG.ENTER_TEXT).length;
      setStatus(`正在评第 ${st.total} 条（已成功 ${st.ok} 条）`);
      log(`———— 第 ${st.total} 条 ————`, key.slice(0, 60));

      await realClick(btn);
      await sleep(CFG.WAIT_MODAL);

      const scope = await waitForEvalScope(CFG.MODAL_TIMEOUT);
      if (!scope) {
        st.openFail++;
        warn(`评价弹窗没加载出评分控件（连续失败 ${st.openFail}/${CFG.MAX_OPEN_FAIL}）`);
        st.failed.add(key);
        await closeTopModal();
        await sleep(CFG.WAIT_STEP);
        if (st.openFail >= CFG.MAX_OPEN_FAIL) {
          warn('连续多次打不开弹窗，停止运行');
          break;
        }
        continue;
      }
      st.openFail = 0;

      let success = false;
      try {
        patchNativeDialogs(scope.doc.defaultView);
        await fillRating(scope);

        // 评分 + 单选（校验失败时再补一次，最多两轮；成功就立刻退出，绝不重复提交）
        for (let attempt = 1; attempt <= 2 && !success; attempt++) {
          if (attempt === 2 && starsGone(scope)) { success = true; break; }
          await pickNo(scope);
          answerUncheckedRadios(evalRoot(scope));
          await sleep(400);
          await submitEval(scope);
          const r = await handleAfterSubmit(scope);
          const gone = starsGone(scope);
          success = r.sawSuccess || gone;
          log(`第 ${attempt} 次提交：弹层点击 ${r.clicks} 次，成功文案=${r.sawSuccess}，弹窗已消失=${gone}`);
          if (!success && attempt === 1) {
            warn('提交没通过（系统还停在弹窗上），重新核对选项后再提交一次');
            await sleep(800);
          }
        }
      } catch (e) {
        err('本条评教出错：', e);
      }

      if (success) {
        st.ok++;
        const decreased = await waitRowUpdated(before, CFG.LIST_UPDATE_TIMEOUT);
        if (!decreased) {
          warn('列表行没有变成「已评价」，为避免重复提交，跳过该行');
          st.failed.add(key);
        }
        if (!starsGone(scope)) await closeTopModal();
        log(`✔ 第 ${st.total} 条完成（累计成功 ${st.ok} 条）`);
      } else {
        warn('本条未确认成功，关闭弹窗后继续下一条');
        st.failed.add(key);
        await closeTopModal();
      }

      await sleep(CFG.WAIT_STEP);
    }

    debugRowTexts();
    return st;
  }

  /* =========================================================================
   * 6) 第 4 步：弹窗内评价（星星 + 否 + 提交）
   * ========================================================================= */
  const STAR_IMG_SEL = [
    'img[title="非常满意"]', 'img[title="满意"]', 'img[title="一般"]',
    'img[title="不满意"]', 'img[title="非常不满意"]',
    '.myraty img', '.raty img', 'img[src*="star" i]', 'img[src*="raty" i]',
  ].join(',');

  function starImgs(root) {
    if (!root) return [];
    let list = [];
    try { list = root.querySelectorAll(STAR_IMG_SEL); } catch (_) { return []; }
    const out = [];
    for (const img of list) if (isVisible(img)) out.push(img);
    return out;
  }

  /**
   * 把星星按“每 5 颗一题”分组：
   * 每颗星往上爬，找到“第一个装下 >=5 颗星”的祖先 = 这题的容器。
   * 万一所有星都塞在同一个容器里，再按每 5 颗切一刀。
   */
  function ratingGroups(root) {
    const imgs = starImgs(root);
    if (!imgs.length) return [];

    const boxOf = new Map();
    for (const img of imgs) {
      let node = img.parentElement;
      let box = null;
      while (node && node !== root) {
        let n = 0;
        for (const o of imgs) if (node.contains(o)) n++;
        if (n >= 5) { box = node; break; }
        node = node.parentElement;
      }
      boxOf.set(img, box || img.parentElement || root);
    }

    const map = new Map();
    for (const img of imgs) {
      const b = boxOf.get(img);
      if (!map.has(b)) map.set(b, []);
      map.get(b).push(img);
    }

    let groups = [];
    for (const g of map.values()) {
      if (g.length >= 4) groups.push(g.slice().sort(domOrder));
    }

    const fixed = [];
    for (const g of groups) {
      if (g.length > 5 && g.length % 5 === 0) {
        for (let i = 0; i < g.length; i += 5) fixed.push(g.slice(i, i + 5));
      } else {
        fixed.push(g);
      }
    }
    return fixed;
  }

  function findEvalScope() {
    for (const doc of allDocs()) {
      if (!doc.body) continue;
      const groups = ratingGroups(doc.body);
      if (groups.length) return { doc, groups };
    }
    return null;
  }

  async function waitForEvalScope(timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const s = findEvalScope();
      if (s) return s;
      await sleep(CFG.WAIT_TICK);
    }
    return null;
  }

  function starsGone(scope) {
    try {
      if (!scope || !scope.doc || !scope.doc.body) return true;
      return starImgs(scope.doc.body).length === 0;
    } catch (_) {
      return true;
    }
  }

  /** 星星是否被点亮（raty 会换成 star-on.png） */
  function starOn(img) {
    if (!img) return false;
    const src = img.getAttribute('src') || '';
    if (/star[-_ ]?on|full|active|selected|checked/i.test(src)) return true;
    const cls = typeof img.className === 'string' ? img.className : (img.getAttribute('class') || '');
    if (/(^|[\s_-])(on|active|selected|checked)([\s_-]|$)/i.test(cls)) return true;
    return img.getAttribute('aria-checked') === 'true';
  }

  async function fillRating(scope) {
    const groups = (scope.groups && scope.groups.length) ? scope.groups : ratingGroups(scope.doc.body);
    if (!groups.length) throw new Error('弹窗里没有找到评分星星（img[title="非常满意"]）');

    const hi = Math.floor(Math.random() * groups.length);
    log(`评分题共 ${groups.length} 组 → 第 ${hi + 1} 组给 5 星，其余 4 星`);

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const high = i === hi;
      const title = high ? CFG.HIGH_TITLE : CFG.NORMAL_TITLE;

      let star = g.find((img) => norm(img.getAttribute('title')) === title);
      if (!star) {
        const idx = high ? g.length - 1 : Math.max(0, g.length - 2);
        star = g[idx];
      }
      if (!star) { warn(`第 ${i + 1} 题没找到目标星`); continue; }

      log(`第 ${i + 1} 题 → ${high ? 5 : 4} 星（${title}）`, star);
      await realClick(star);
      await sleep(CFG.WAIT_TICK);

      if (!starOn(star)) {
        // 有些版本把点击事件绑在星星的父元素上：再带着星星的坐标点一次父元素
        log(`第 ${i + 1} 题未读到点亮状态 → 改点父元素`);
        await realClick(star.parentElement || star, star);
        await sleep(CFG.WAIT_TICK);
      }
      log(`第 ${i + 1} 题当前：${starOn(star) ? '已点亮' : '读不到选中样式（继续）'}`);
    }
  }

  /* ---------- 单选题：选「否」 ----------
   * 本校的结构是：<input type="radio" id="10002386" class="radio pjzb">
   *               <label for="10002386">否</label>
   * 光点 label 不一定能把 radio 勾上（站点的 click 处理可能 preventDefault），
   * 所以点完必须核对 input.checked，没勾上就点 input 本身，再不行就强制勾选 + 派发 change。
   */
  const attrVal = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  function labelFor(radio) {
    const id = radio && radio.id;
    if (!id) return null;
    const doc = radio.ownerDocument || document;
    try { return doc.querySelector('label[for="' + attrVal(id) + '"]'); } catch (_) { return null; }
  }

  /** 尽量凑出某个 radio 的“选项文字”：包裹 label / label[for] / value / title / 紧邻文字 */
  function optionTextOf(radio) {
    const parts = [];
    const wrap = radio.closest ? radio.closest('label') : null;
    if (wrap) parts.push(norm(wrap.textContent));
    const lab = labelFor(radio);
    if (lab) parts.push(norm(lab.textContent));
    parts.push(norm(radio.getAttribute('value')));
    parts.push(norm(radio.getAttribute('title')));
    let sib = radio.nextSibling;
    for (let i = 0; i < 2 && sib; i++, sib = sib.nextSibling) {
      if (sib.nodeType === 3) parts.push(norm(sib.nodeValue));
      else if (sib.nodeType === 1) parts.push(norm(sib.textContent));
    }
    const p = radio.parentElement;
    if (p) {
      const pt = norm(p.textContent);
      if (pt && pt.length <= 6) parts.push(pt);
    }
    return parts.filter(Boolean).join('');
  }

  const looksLikeNo = (t) => !!t && t.indexOf('否') >= 0 && t.indexOf('是否') !== 0 && t.length <= 6;

  /** 找出「否」选项对应的 radio：先找文字精确为“否”的，找不到再放宽 */
  function noRadioCandidates(root) {
    const out = [];
    if (!root) return out;
    let radios = [];
    try { radios = Array.prototype.slice.call(root.querySelectorAll('input[type="radio"]')); } catch (_) { return out; }
    const strong = [];
    const weak = [];
    for (const r of radios) {
      const wrap = r.closest ? r.closest('label') : null;
      const lab = labelFor(r);
      const own = (wrap ? norm(wrap.textContent) : '') + (lab ? norm(lab.textContent) : '');
      if (own && own.indexOf('否') === 0 && own.indexOf('是否') !== 0 && own.length <= 8) {
        strong.push({ radio: r, text: own });
      } else {
        const t = own || optionTextOf(r);
        if (looksLikeNo(t)) weak.push({ radio: r, text: t });
      }
    }
    return strong.length ? strong : weak;
  }

  /** 点完再核对：radio 必须真的是 checked 状态 */
  function ensureRadioChecked(radio) {
    if (!radio) return false;
    if (radio.checked) { log('  radio 已选中'); return true; }
    try { radio.click(); } catch (_) {}
    if (radio.checked) {
      fireEvent(radio, 'Event', 'change');
      log('  点 input 后已选中');
      return true;
    }
    radio.checked = true;
    fireEvent(radio, 'Event', 'input');
    fireEvent(radio, 'Event', 'change');
    log('  强制勾选 radio 并派发 change，checked =', radio.checked);
    return radio.checked;
  }

  async function pickNo(scope) {
    const doc = scope.doc;
    const root = evalRoot(scope);

    const seen = new Set();
    const cands = [];
    for (const c of noRadioCandidates(root).concat(noRadioCandidates(doc.body))) {
      if (seen.has(c.radio)) continue;
      seen.add(c.radio);
      cands.push(c);
    }

    if (cands.length) {
      log(`找到 ${cands.length} 个「否」选项（radio）`);
      for (const c of cands) {
        const box = labelFor(c.radio) || (c.radio.closest && c.radio.closest('label')) || c.radio.parentElement || c.radio;
        log(`点「否」→ 选项文字「${c.text}」`, box);
        await realClick(box);
        await sleep(200);
        ensureRadioChecked(c.radio);
        await sleep(CFG.WAIT_TICK);
      }
      return;
    }

    // 也有可能是原生 select
    let selHit = 0;
    try {
      for (const sel of root.querySelectorAll('select')) {
        if (!isVisible(sel)) continue;
        const opts = Array.prototype.slice.call(sel.options);
        const no = opts.find((o) => norm(o.textContent) === CFG.NO_TEXT) ||
          opts.find((o) => looksLikeNo(norm(o.textContent)));
        if (!no) continue;
        sel.value = no.value;
        fireEvent(sel, 'Event', 'input');
        fireEvent(sel, 'Event', 'change');
        selHit++;
        log('下拉框选「否」→', norm(no.textContent));
      }
    } catch (_) {}
    if (selHit) return;

    // 没有 radio：可能是自定义控件，退化为直接点文字
    let targets = deepestOnly(textIs(CFG.NO_TEXT, root));
    if (!targets.length) targets = deepestOnly(textIs(CFG.NO_TEXT, doc.body));
    if (!targets.length) {
      warn(`没找到「${CFG.NO_TEXT}」选项`);
      return;
    }
    log(`没找到 radio，按文字点 ${targets.length} 个「否」`);
    for (const el of targets) {
      await realClick(el);
      await sleep(CFG.WAIT_TICK);
    }
  }

  /** 兜底：把仍然没作答的 radio 组补一个答案（优先含“否”，否则选最后一个） */
  function answerUncheckedRadios(root) {
    if (!root) return 0;
    let radios = [];
    try { radios = Array.prototype.slice.call(root.querySelectorAll('input[type="radio"]')); } catch (_) { return 0; }
    const groups = new Map();
    for (const r of radios) {
      const box = (r.closest && (r.closest('label, td, tr, .form-group, .row') || r.parentElement)) || r.parentElement;
      if (!isVisible(box) && !isVisible(r.parentElement)) continue;
      const key = r.name ? 'n:' + r.name : r.parentElement;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    let filled = 0;
    for (const list of groups.values()) {
      if (list.length > 8) continue;                     // 选项太多，不像单选题
      if (list.some((r) => r.checked)) continue;
      const noOne = list.find((r) => looksLikeNo(optionTextOf(r)));
      const target = noOne || list[list.length - 1];
      target.checked = true;
      fireEvent(target, 'Event', 'input');
      fireEvent(target, 'Event', 'change');
      filled++;
      log('补选未作答的单选题 →', optionTextOf(target) || norm(target.id));
    }
    if (filled) log(`共补选 ${filled} 个未作答的单选题`);
    if (groups.size) {
      let checked = 0;
      for (const list of groups.values()) if (list.some((r) => r.checked)) checked++;
      log(`单选题核对：共 ${groups.size} 组，已作答 ${checked} 组`);
    }
    return filled;
  }

  /** 评教表单所在的容器（优先弹窗 / form），没有就用整个 body */
  function evalRoot(scope) {
    const img = scope.groups && scope.groups[0] && scope.groups[0][0];
    if (img) {
      let m = null;
      try {
        m = img.closest('.layui-layer, .el-dialog, .ant-modal, .ivu-modal, .modal, .window, [role="dialog"], form');
      } catch (_) {}
      if (m) return m;
    }
    return (scope.doc && scope.doc.body) || document.body;
  }

  async function submitEval(scope) {
    const doc = scope.doc;
    const root = evalRoot(scope);
    let leaves = textLeavesMatch((t) => t.indexOf(CFG.SUBMIT_TEXT) >= 0 && t.length <= 10, root);
    if (!leaves.length) leaves = textLeavesMatch((t) => t.indexOf(CFG.SUBMIT_TEXT) >= 0 && t.length <= 10, doc.body);
    if (!leaves.length) throw new Error(`没找到「${CFG.SUBMIT_TEXT}」按钮`);

    const cands = [];
    for (const el of leaves) {
      const c = clickableOf(el);
      if (!c || !c.isConnected || !isVisible(c)) continue;
      if (c.disabled || c.getAttribute('aria-disabled') === 'true') continue;
      const t = norm(c.textContent || c.value);
      if (/取消|关闭|返回|重置/.test(t)) continue;
      cands.push(c);
    }
    if (!cands.length) throw new Error('「提交」按钮不可点击');

    // 「提交评价」>「提交」
    const score = (el) => {
      const t = norm(el.textContent || el.value);
      let s = 0;
      if (/提交评价|提交评教|提交问卷/.test(t)) s += 2;
      if (t === CFG.SUBMIT_TEXT) s += 1;
      return s;
    };
    cands.sort((a, b) => score(b) - score(a));

    const btn = cands[0];
    log('提交按钮 →', norm(btn.textContent || btn.value), btn);
    await realClick(btn);
    await sleep(CFG.WAIT_STEP);
  }

  /* =========================================================================
   * 7) 第 5 步：处理「评价成功 / 确定」弹层
   * ========================================================================= */
  const DIALOG_SEL = [
    '.layui-layer-page', '.layui-layer-dialog', '.layui-layer-iframe', '.layui-layer',
    '.messager-window', '.messager-body', '.window',                 // EasyUI（本校用的就是它）
    '.el-dialog', '.el-message-box', '.el-message',
    '.ant-modal', '.ant-message', '.ant-message-notice',
    '.ivu-modal', '.ivu-message',
    '.modal', '.dialog', '[role="dialog"]', '[role="alertdialog"]',
  ];

  const PRIMARY_SEL = [
    '.layui-layer-btn0',
    '.messager-button a',                                            // EasyUI 消息框的按钮
    '.el-message-box__btns .el-button--primary',
    '.el-message-box__btns .el-button',
    '.el-button--primary',
    '.ant-modal-confirm-btns .ant-btn-primary',
    '.ant-btn-primary',
    '.ivu-btn-primary',
    '.btn-primary',
    '.layui-btn-normal',
    '.l-btn',
  ];

  /** 找最上层的“小弹层”（自动排除评教表单本身） */
  function findTopDialog() {
    const cands = [];
    for (const doc of allDocs()) {
      for (const sel of DIALOG_SEL) {
        let list = [];
        try { list = doc.querySelectorAll(sel); } catch (_) { continue; }
        for (const el of list) {
          if (!isVisible(el)) continue;
          const t = norm(el.textContent);
          if (!t || t.length > 160) continue;                       // 评教表单很长，排除
          if (el.querySelector('img[title]')) continue;             // 里面还有星星 → 就是评教表单
          if (el.querySelector('.myraty, .raty, [class*="raty" i]')) continue;
          if (/非常满意|非常不满意/.test(t)) continue;               // 评分用语 → 不是结果弹窗
          cands.push(el);
        }
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length);
    return cands[0];
  }

  function findPrimaryButton(dlg) {
    if (!dlg) return null;
    const usable = (el) => {
      if (!isVisible(el)) return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      if (/取消|关闭|返回|放弃/.test(norm(el.textContent || el.value))) return false;
      return true;
    };
    for (const sel of PRIMARY_SEL) {
      let hits = [];
      try { hits = Array.prototype.slice.call(dlg.querySelectorAll(sel)); } catch (_) { hits = []; }
      const ok = hits.filter(usable);
      if (ok.length) return ok[0];                                   // 蓝色主按钮通常在最前
    }
    // 文字兜底：确定 / 确认 / 好的
    let cands = [];
    try {
      cands = Array.prototype.slice.call(dlg.querySelectorAll('button, a, span, div, [role="button"]'));
    } catch (_) { cands = []; }
    const texts = cands.filter((el) => usable(el) && /^(确定|确认|好的|知道了|好|OK)$/i.test(norm(el.textContent || el.value)));
    if (!texts.length) return null;
    const inner = texts.filter((el) => !texts.some((o) => o !== el && el.contains(o)));
    return inner[0] || texts[0];
  }

  async function handleAfterSubmit(scope) {
    let dlg = null;
    const started = Date.now();
    while (Date.now() - started < 4000) {
      dlg = findTopDialog();
      if (dlg) break;
      // 弹窗已经自己关了，就别干等
      if (Date.now() - started > 1200 && starsGone(scope)) break;
      await sleep(CFG.WAIT_TICK);
    }
    if (!dlg) {
      log('提交后没有出现任何弹层（可能直接成功）');
      return { clicks: 0, sawSuccess: false };
    }

    let clicks = 0;
    let sawSuccess = false;
    const end = Date.now() + CFG.SUCCESS_TIMEOUT;

    while (dlg && Date.now() < end) {
      const text = norm(dlg.textContent);
      log(`弹层文字：「${text.slice(0, 40)}」`);
      if (/评价成功|提交成功|保存成功|评教成功|操作成功|成功/.test(text)) sawSuccess = true;

      const btn = findPrimaryButton(dlg);
      if (!btn) {
        warn('弹层里没找到确定按钮，交给下一轮判断');
        break;
      }

      log(`点弹层的「${norm(btn.textContent || btn.value)}」`);
      await realClick(btn);
      clicks++;
      await sleep(CFG.WAIT_STEP);
      dlg = findTopDialog();
    }
    return { clicks, sawSuccess };
  }

  async function dismissStrayDialog() {
    const dlg = findTopDialog();
    if (!dlg) return;
    const text = norm(dlg.textContent);
    const btn = findPrimaryButton(dlg);
    // 不是结果弹窗、也没有确定按钮的（比如 toast 提示）就别乱点
    if (!btn && !/成功|确定|确认|失败|错误/.test(text)) return;
    log(`发现残留弹层「${text.slice(0, 30)}」`);
    if (btn) {
      await realClick(btn);
      await sleep(CFG.WAIT_STEP);
      return;
    }
    await closeTopModal();
    await sleep(500);
  }

  async function ensureNoEvalModal() {
    for (const doc of allDocs()) {
      if (!doc.body) continue;
      if (starImgs(doc.body).length) {
        warn('还有评教弹窗没关掉，强制关闭');
        await closeTopModal();
        await sleep(600);
        return;
      }
    }
  }

  /** 出错时点右上角关闭按钮，把弹窗收掉，继续下一条 */
  async function closeTopModal() {
    for (const doc of allDocs()) {
      const layers = [];
      for (const sel of ['.layui-layer', '.messager-window', '.window', '.el-dialog', '.el-message-box', '.ant-modal', '.ivu-modal', '.modal', '[role="dialog"]']) {
        let list = [];
        try { list = doc.querySelectorAll(sel); } catch (_) { continue; }
        for (const el of list) {
          if (!isVisible(el)) continue;
          if (layers.indexOf(el) >= 0) continue;
          layers.push(el);
        }
      }
      // 后出现的弹层在 DOM 后面，也就是更上层
      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        let btn = null;
        try {
          btn = layer.querySelector('.layui-layer-close, .layui-layer-setwin a, .el-dialog__headerbtn, .el-message-box__headerbtn, .ant-modal-close, .ivu-modal-close, [class*="close" i], [class*="Close" i]');
        } catch (_) {}
        if (!btn || !isVisible(btn)) continue;
        log('关闭弹窗 →', btn.getAttribute('class') || btn.tagName);
        await realClick(btn);
        await sleep(700);
        return true;
      }
    }
    // ESC 兜底
    try {
      for (const doc of allDocs()) {
        for (const type of ['keydown', 'keyup']) {
          fireEvent(doc, 'KeyboardEvent', type, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
        }
      }
    } catch (_) {}
    await sleep(400);
    return false;
  }

  /** 接管原生 confirm / alert，避免提交时被浏览器弹窗卡住 */
  function patchNativeDialogs(win) {
    if (!win || win.__smuLoopPatched) return;
    try {
      win.confirm = function (msg) {
        log('自动确认 confirm：', msg);
        return true;
      };
      win.alert = function (msg) {
        log('页面 alert：', msg);
        toast(String(msg));
      };
      win.__smuLoopPatched = true;
    } catch (_) {
      warn('无法重写 confirm/alert');
    }
  }

  /* =========================================================================
   * 8) 主流程
   * ========================================================================= */
  const state = { running: false };

  async function runAll() {
    log('================ 一键连评 开始 ================');
    patchNativeDialogs(window);

    setStatus('检查当前页面…');
    if (!onListPage()) {
      setStatus('搜索并进入「随堂评价」…');
      const ok = await goToListPage();
      if (!ok) throw new Error(`没能进入「${CFG.KEYWORD}」列表页（可手动点开一次再点按钮）`);
      log('已进入随堂评价列表页');
    } else {
      log('已经在列表页，跳过搜索导航');
    }

    setStatus('选当天日期并查询…');
    await pickTodayAndQuery();

    setStatus('开始逐条评价…');
    const st = await loopEval();

    log('================ 结束 ================', st);
    if (!st.total) {
      toast('当前筛选下没有「进入评价」的条目（可能已全部评完）');
    } else {
      toast(`全部评价完毕：成功 ${st.ok} 条` + (st.failed.size ? `，失败 ${st.failed.size} 条` : ''));
    }
    return st;
  }

  /* =========================================================================
   * 9) 右下角悬浮按钮「一键连评」
   * ========================================================================= */
  function toast(msg) {
    if (!document.body) return;
    const box = document.createElement('div');
    box.textContent = msg;
    box.style.cssText = [
      'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483647',
      'padding:10px 16px;border-radius:10px;background:rgba(17,24,39,.92);color:#fff',
      'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:70vw',
    ].join(';');
    document.body.appendChild(box);
    setTimeout(() => { try { box.remove(); } catch (_) {} }, 4500);
  }

  function setStatus(msg) {
    const el = document.getElementById('smu-loop-status');
    if (el) {
      el.textContent = msg;
      el.classList.add('show');
    }
    log('状态：' + msg);
  }

  function mountUI() {
    if (!document.body) { setTimeout(mountUI, 300); return; }
    if (document.getElementById('smu-loop-ui')) return;

    if (!document.getElementById('smu-loop-style')) {
      const style = document.createElement('style');
      style.id = 'smu-loop-style';
      style.textContent = [
        '#smu-loop-ui{position:fixed;right:22px;bottom:86px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:8px;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}',
        '#smu-loop-status{display:none;max-width:300px;padding:8px 12px;border-radius:10px;background:rgba(17,24,39,.9);color:#fff;',
        'font-size:13px;line-height:1.5;box-shadow:0 8px 22px rgba(0,0,0,.22)}',
        '#smu-loop-status.show{display:block}',
        '#smu-loop-fab{padding:12px 20px;border:0;border-radius:999px;color:#fff;font-size:14px;font-weight:600;letter-spacing:.5px;',
        'cursor:pointer;background:linear-gradient(135deg,#14b8a6,#0e7490);',
        'box-shadow:0 10px 24px rgba(13,148,136,.35),0 2px 6px rgba(0,0,0,.18);transition:transform .15s ease,filter .15s ease}',
        '#smu-loop-fab:hover:not(:disabled){transform:translateY(-2px);filter:brightness(1.07)}',
        '#smu-loop-fab:disabled{cursor:not-allowed;opacity:.75;filter:grayscale(.2)}',
      ].join('');
      (document.head || document.documentElement).appendChild(style);
    }

    const wrap = document.createElement('div');
    wrap.id = 'smu-loop-ui';

    const status = document.createElement('div');
    status.id = 'smu-loop-status';

    const btn = document.createElement('button');
    btn.id = 'smu-loop-fab';
    btn.type = 'button';
    btn.textContent = state.running ? '连评中…' : '一键连评';
    btn.disabled = !!state.running;
    btn.title = '全自动：搜索 → 选当天日期 → 查询 → 逐条「进入评价」并提交';
    btn.addEventListener('click', onFabClick);

    wrap.appendChild(status);
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
    log('悬浮按钮「一键连评」已就位');
  }

  async function onFabClick(ev) {
    const btn = ev.currentTarget;
    if (state.running) { setStatus('正在运行，请勿重复点击'); return; }

    state.running = true;
    btn.disabled = true;                 // 点击后立刻禁用，防止重复触发
    btn.textContent = '连评中…';
    setStatus('开始运行…');

    try {
      const st = await runAll();
      btn.textContent = '已完成';
      setStatus(st.ok ? `已连续完成 ${st.ok} 条评价` : '已结束');
    } catch (e) {
      err('运行出错：', e);
      btn.textContent = '已停止';
      setStatus('出错：' + (e && e.message ? e.message : e));
      toast('出错：' + (e && e.message ? e.message : e));
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 10) 启动
   * ========================================================================= */
  function boot() {
    if (!document.body) { setTimeout(boot, 300); return; }
    mountUI();
    // 页面是 SPA，路由切走后按钮可能被清掉，定期补挂
    setInterval(() => {
      if (!document.getElementById('smu-loop-fab')) mountUI();
    }, 2000);
  }

  boot();
})();
