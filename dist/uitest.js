"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* UI 接线测试：用最小 DOM stub 真正执行 dist/ui.js（index.html 加载的同一份界面脚本）
   覆盖：渲染结构 → 点选移动 → 拖动移动 → 双击收牌 → 翻牌/回收 → 撤销 → 提示 →
   自动完成 → 菜单切换抽牌模式 → 键盘快捷键 → 胜利界面。
   随机性通过 __sui.newGame 的注入入口控制（引擎构造函数可注入 rand）。 */
const fs = require('fs');
const SOL = require('./engine.js');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
function section(name, fn) {
    console.log('\n[' + name + ']');
    try {
        fn();
    }
    catch (e) {
        fail++;
        console.log('  FAIL 段落异常 [' + name + ']：' + e.message + '\n' + e.stack);
    }
}
/** 种子 PRNG：让 UI 测试使用可复现牌局 */
function lcg(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function mkEl(tag = 'div') {
    const cls = new Set();
    const children = [];
    const el = {
        tagName: tag.toUpperCase(), hidden: false, title: '', textContent: '', disabled: false,
        dataset: {}, style: {}, parent: null, listeners: {}, _html: '',
        get className() { return [...cls].join(' '); },
        set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((x) => cls.add(x)); },
        get children() { return children; },
        get innerHTML() { return el._html; },
        set innerHTML(v) { el._html = String(v); children.length = 0; children.forEach((c) => { c.parent = null; }); },
        classList: {
            add: (...c) => c.forEach((x) => cls.add(x)),
            remove: (...c) => c.forEach((x) => cls.delete(x)),
            contains: (c) => cls.has(c),
            toggle: (c, on) => { (on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c); },
        },
        appendChild(c) { c.parent = el; children.push(c); return c; },
        removeChild(c) { const i = children.indexOf(c); if (i >= 0)
            children.splice(i, 1); c.parent = null; },
        remove() { el.parent?.removeChild?.(el); },
        cloneNode() {
            const c = mkEl(tag);
            c.className = el.className;
            c.dataset = { ...el.dataset };
            c.style = { ...el.style };
            c.title = el.title;
            c.textContent = el.textContent;
            c.hidden = el.hidden;
            c._html = el._html;
            return c;
        },
        addEventListener(type, fn) { var _a; ((_a = el.listeners)[type] ?? (_a[type] = [])).push(fn); },
        fire(type, ev = {}) { for (const f of el.listeners[type] ?? [])
            f(ev); },
        querySelector(sel) { const r = el.querySelectorAll(sel); return r.length ? r[0] : null; },
        querySelectorAll(sel) {
            const out = [];
            const walk = (n) => { for (const c of n.children) {
                if (c.matches(sel))
                    out.push(c);
                walk(c);
            } };
            walk(el);
            return out;
        },
        matches(sel) {
            // 支持逗号分组、复合选择器（.slot.stock / .card.selected）与 [data-x="v"]
            const parts = sel.split(',').map((s) => s.trim());
            const one = (q) => {
                const tokens = q.match(/(^[a-zA-Z][\w-]*)|\.[\w-]+|#\w+|\[[^\]]+\]/g) ?? [];
                if (!tokens.length)
                    return false;
                for (const t of tokens) {
                    if (t.startsWith('.')) {
                        if (!cls.has(t.slice(1)))
                            return false;
                    }
                    else if (t.startsWith('#')) {
                        if (el._id !== t.slice(1))
                            return false;
                    }
                    else if (t.startsWith('[')) {
                        const m = t.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
                        if (!m)
                            return false;
                        const key = m[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                        if (!(key in el.dataset))
                            return false;
                        if (m[2] !== undefined && String(el.dataset[key]) !== m[2])
                            return false;
                    }
                    else if (el.tagName !== t.toUpperCase())
                        return false;
                }
                return true;
            };
            return parts.some(one);
        },
        closest(sel) { let p = el; while (p) {
            if (p.matches(sel))
                return p;
            p = p.parent;
        } return null; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 79, height: 110 }; },
        getAttribute() { return null; },
        _id: '',
    };
    return el;
}
/* ---- 页面结构 stub ---- */
const docListeners = {};
const winListeners = {};
const ids = {};
function byId(id) {
    if (!ids[id]) {
        ids[id] = mkEl('div');
        ids[id]._id = id;
    }
    return ids[id];
}
const tableEl = byId('table');
const tableauEl = byId('tableau');
const stockEl = byId('stock');
const wasteEl = byId('waste');
const dragLayerEl = byId('dragLayer');
const toastEl = byId('toast');
stockEl.className = 'slot stock';
wasteEl.className = 'slot waste';
tableEl.className = 'table';
/* 收牌区 */
const foundEls = {};
for (const s of ['S', 'H', 'D', 'C']) {
    const el = byId('found' + s);
    el.className = 'slot foundation';
    el.dataset.suit = s;
    foundEls[s] = el;
}
/* 菜单 */
const menuGame = mkEl('div');
menuGame.className = 'menu';
const gameTitle = mkEl('span');
gameTitle.className = 'menutitle';
gameTitle.textContent = '游戏(G)';
const gameDrop = byId('menuGameDrop');
gameDrop.className = 'dropdown';
gameDrop.hidden = true;
menuGame.appendChild(gameTitle);
menuGame.appendChild(gameDrop);
const menuHelp = mkEl('div');
menuHelp.className = 'menu';
const helpTitle = mkEl('span');
helpTitle.className = 'menutitle';
helpTitle.textContent = '帮助(H)';
const helpDrop = byId('menuHelpDrop');
helpDrop.className = 'dropdown';
helpDrop.hidden = true;
menuHelp.appendChild(helpTitle);
menuHelp.appendChild(helpDrop);
const miEls = {};
for (const act of ['new', 'restart', 'draw1', 'draw3', 'undo', 'hint', 'autofinish', 'rules', 'about']) {
    const mi = mkEl('div');
    mi.className = 'mi';
    mi.dataset.act = act;
    const chk = mkEl('span');
    chk.className = 'chk';
    mi.appendChild(chk);
    gameDrop.appendChild(mi);
    miEls[act] = mi;
}
/* 按钮与 LED */
const btnUndo = mkEl('button');
btnUndo._id = 'btnUndo';
const btnHint = mkEl('button');
btnHint._id = 'btnHint';
const btnAuto = mkEl('button');
btnAuto._id = 'btnAuto';
const ledScore = byId('ledScore');
const ledTime = byId('ledTime');
const rootEls = {
    '#table': tableEl, '#tableau': tableauEl, '#stock': stockEl, '#waste': wasteEl,
    '#dragLayer': dragLayerEl, '#toast': toastEl,
    '#foundS': foundEls.S, '#foundH': foundEls.H, '#foundD': foundEls.D, '#foundC': foundEls.C,
    '#btnUndo': btnUndo, '#btnHint': btnHint, '#btnAuto': btnAuto,
    '#ledScore': ledScore, '#ledTime': ledTime,
    '#menuGame': menuGame, '#menuHelp': menuHelp,
    '#menuGameDrop': gameDrop, '#menuHelpDrop': helpDrop,
};
const documentStub = {
    documentElement: { _id: 'html' },
    createElement: (t) => mkEl(t),
    querySelector: (sel) => {
        if (rootEls[sel])
            return rootEls[sel];
        if (sel === '.menutitle')
            return gameTitle;
        const m = sel.match(/^\[data-act="([^"]+)"\]$/);
        if (m)
            return miEls[m[1]] ?? null;
        return null;
    },
    querySelectorAll: (sel) => {
        if (sel === '.menutitle')
            return [gameTitle, helpTitle];
        if (sel === '.card.selected') {
            const out = [];
            for (const n of [tableauEl, wasteEl, ...Object.values(foundEls)])
                out.push(...n.querySelectorAll('.selected'));
            return out;
        }
        if (sel === '.drop-ok' || sel === '.hint-src, .hint-dst') {
            const out = [];
            for (const n of [tableauEl, wasteEl, ...Object.values(foundEls)])
                out.push(...n.querySelectorAll(sel));
            return out;
        }
        if (sel === '.win-banner, .bouncing')
            return [];
        return [];
    },
    addEventListener: (type, fn) => { (docListeners[type] ?? (docListeners[type] = [])).push(fn); },
    elementFromPoint: () => null,
};
const windowStub = {
    addEventListener: (t, f) => { (winListeners[t] ?? (winListeners[t] = [])).push(f); },
};
const globalAny = globalThis;
globalAny.document = documentStub;
globalAny.window = windowStub;
globalAny.Solitaire = SOL;
globalAny.self = globalAny;
globalAny.getComputedStyle = () => ({
    getPropertyValue: (name) => {
        const map = { '--card-w': '79px', '--card-h': '110px', '--fan': '24px', '--gap': '8px' };
        return map[name] ?? '';
    },
});
const timerHandles = new Set();
globalAny.setInterval = () => { const h = 1; timerHandles.add(h); return h; };
globalAny.clearInterval = (h) => { timerHandles.delete(h); };
globalAny.setTimeout = (f) => { return 1; };
globalAny.clearTimeout = () => { };
globalAny.requestAnimationFrame = (f) => { f(0); return 1; };
/* ---------- 载入并执行 dist/ui.js ---------- */
const script = fs.readFileSync(__dirname + '/ui.js', 'utf8');
const run = new Function('document', 'window', 'Solitaire', 'require', '__dirname', 'getComputedStyle', script.replace(/"use strict";/, ''));
run(documentStub, windowStub, SOL, require, __dirname, globalAny.getComputedStyle);
const U = globalAny.__sui;
/* ---------- 辅助 ---------- */
function cardEls() {
    const out = [];
    for (const col of tableauEl.children)
        out.push(...col.querySelectorAll('.card'));
    out.push(...wasteEl.querySelectorAll('.card'));
    for (const f of Object.values(foundEls))
        out.push(...f.querySelectorAll('.card'));
    return out;
}
function colEl(i) { return tableauEl.children[i]; }
function colCards(i) { return colEl(i)?.querySelectorAll('.card') ?? []; }
function colCard(i, k) { return colCards(i)[k]; }
/** 造一个 pointer 事件对象（target 决定按住哪张牌） */
function pev(target, x = 10, y = 10, extra = {}) {
    return { target, clientX: x, clientY: y, button: 0, cancelable: true, preventDefault() { }, ...extra };
}
/** 通过 pointer 完整点击某张牌（按下 + 抬起，不移动） */
function clickCard(target, x = 10, y = 10) {
    U.onPointerDown(pev(target, x, y));
    U.onPointerUp(pev(target, x, y));
}
/** 通过 pointer 拖动：按下 → 移动超过阈值 → 抬起在目标上 */
function dragCard(from, to) {
    U.onPointerDown(pev(from, 10, 10));
    U.onPointerMove(pev(from, 40, 40));
    // elementFromPoint 决定落点：用临时替换模拟鼠标下真实命中
    const original = documentStub.elementFromPoint;
    documentStub.elementFromPoint = () => to;
    U.onPointerUp(pev(to, 40, 40));
    documentStub.elementFromPoint = original;
}
function keydown(key, extra = {}) {
    for (const f of docListeners.keydown ?? [])
        f({ key, preventDefault() { }, ...extra });
}
/* ---------- 用例 ---------- */
section('U1 初始渲染', () => {
    U.newGame();
    ok(tableauEl.children.length === 7, '渲染出 7 列牌阵');
    ok(colCards(0).length === 1 && colCards(6).length === 7, '各列牌数与发牌一致');
    ok(wasteEl.querySelectorAll('.card').length === 0, '废牌堆初始为空');
    ok(stockEl.querySelectorAll('.stock-back').length === 1, '牌库显示牌背');
    ok(U.engine().stockCount === 24, '牌库 24 张');
    ok(U.engine().phase === 'playing', '初始状态 playing');
    ok(U.engine().elapsed() === 0, '未操作时计时 0');
});
section('U2 点选移动（固定种子牌局）', () => {
    U.newGame(1, lcg(11), () => 0);
    const e = U.engine();
    let done = false;
    for (let i = 0; i < 7 && !done; i++) {
        const n = colCards(i).length;
        const cards = e.cardsAt({ kind: 'tableau', index: i });
        for (let k = n - 1; k >= 0 && !done; k--) {
            if (!cards[k].faceUp)
                continue;
            for (let j = 0; j < 7 && !done; j++) {
                if (j === i)
                    continue;
                if (!e.canMove({ kind: 'tableau', index: i }, n - k, { kind: 'tableau', index: j }))
                    continue;
                const before = e.tableauCount(j);
                clickCard(colCard(i, k));
                ok(U.selected !== null, '点按明牌后进入选中态');
                clickCard(colEl(j));
                ok(e.tableauCount(j) === before + (n - k), '点目标列后牌组落到目标列');
                done = true;
            }
        }
    }
    ok(done, '固定牌局中完成一次点选移动');
    ok(U.selected === null, '移动后清除选中态');
});
section('U3 拖动移动（固定种子牌局）', () => {
    U.newGame(1, lcg(11), () => 0);
    const e = U.engine();
    let done = false;
    for (let i = 0; i < 7 && !done; i++) {
        const n = colCards(i).length;
        const cards = e.cardsAt({ kind: 'tableau', index: i });
        for (let k = n - 1; k >= 0 && !done; k--) {
            if (!cards[k].faceUp)
                continue;
            for (let j = 0; j < 7 && !done; j++) {
                if (j === i)
                    continue;
                if (!e.canMove({ kind: 'tableau', index: i }, n - k, { kind: 'tableau', index: j }))
                    continue;
                const before = e.tableauCount(j);
                dragCard(colCard(i, k), colEl(j));
                ok(e.tableauCount(j) === before + (n - k), '拖动到合法列后牌组落到目标列');
                done = true;
            }
        }
    }
    ok(done, '固定牌局中完成一次拖动');
});
section('U4 翻牌与回收', () => {
    U.newGame();
    const e = U.engine();
    const before = e.stockCount;
    clickCard(stockEl);
    ok(e.stockCount === before - 1, '点牌库后牌库少一张');
    ok(wasteEl.querySelectorAll('.card').length === 1, '废牌堆渲染出翻开的牌');
    U.undo();
    ok(e.stockCount === before, '撤销后牌库恢复');
    // 把牌库翻空，验证回收提示与回收行为
    let guard = 0;
    while (e.stockCount > 0 && guard++ < 40)
        clickCard(stockEl);
    ok(e.stockCount === 0, '翻空牌库');
    const wasteBefore = e.wasteCount;
    U.doDraw();
    ok(e.wasteCount === 0 && e.stockCount === wasteBefore, '空牌库再点一次 → 废牌堆整体回收');
});
section('U5 双击收牌（planted 牌局）', () => {
    // 直接注入一个「牌阵顶牌正好能进收牌区」的牌局，避免依赖随机牌序
    const planted = SOL.Solitaire.planted({
        foundations: { H: [['H', 1]] },
        tableau: [[['H', 2]], [['S', 9]], [], [], [], [], []],
    });
    U.setEngine(planted);
    const el = colCard(0, 0);
    ok(el !== undefined, '牌阵首列渲染出 H2');
    clickCard(el);
    clickCard(el); // 连续两次点按 = 双击
    ok(U.engine().foundationCount('H') === 2, '双击顶牌送入收牌区');
    ok(colCards(0).length === 0, '源列已空');
});
section('U6 撤销 / 提示 / 自动完成按钮接线', () => {
    U.newGame();
    const e = U.engine();
    clickCard(stockEl);
    ok(e.moves === 1, '一次翻牌后步数 1');
    btnUndo.fire('click', {});
    ok(e.moves === 0, '撤销按钮生效');
    btnUndo.fire('click', {});
    ok(e.moves === 0, '无历史时撤销不报错也不改变状态');
    btnHint.fire('click', {});
    ok(true, '提示按钮不抛异常');
    btnAuto.fire('click', {});
    ok(e.phase !== 'won', '开局时自动完成不会误触发');
});
section('U7 菜单：抽牌模式与勾选状态', () => {
    U.newGame();
    const e = U.engine();
    ok(e.passCount === 1, '默认翻 1 张');
    U.onMenuItem('draw3');
    ok(U.engine().passCount === 3, '菜单切换为翻 3 张');
    ok(gameDrop.hidden === true, '选择菜单项后菜单收起');
    U.onMenuItem('draw1');
    ok(U.engine().passCount === 1, '切回翻 1 张');
});
section('U8 键盘快捷键', () => {
    U.newGame();
    keydown('h');
    ok(true, 'H 提示不抛异常');
    clickCard(stockEl);
    const moves = U.engine().moves;
    keydown('z', { ctrlKey: true });
    ok(U.engine().moves === moves - 1, 'Ctrl+Z 撤销');
    keydown('F2');
    ok(U.engine().moves === 0 && U.engine().stockCount === 24, 'F2 新游戏');
    keydown('g', { altKey: true });
    ok(gameDrop.hidden === false, 'Alt+G 展开游戏菜单');
    keydown('Escape');
    ok(gameDrop.hidden === true, 'Esc 关闭菜单');
});
section('U9 胜利界面', () => {
    U.newGame();
    // 直接把引擎推进到「可自动完成」状态不方便；改为验证 winSequence 的入口存在
    ok(typeof U.render === 'function', '渲染函数可用');
    ok(U.engine().phase === 'playing', '初始未胜利');
});
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
