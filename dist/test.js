"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* 纸牌接龙引擎测试（源码 src/test.ts → 编译产物 dist/test.js）
   测试直接 require 同目录的 dist/engine.js 产物——测的就是浏览器实际加载的那份代码。
   随机发牌全部用种子 PRNG，牌局可复现；规则边界用 planted() 显式构造。 */
const SOL = require('./engine.js');
const EngineCtor = SOL.Solitaire;
const SUITS = SOL.SUITS;
const isRed = SOL.isRed;
const rankLabel = SOL.rankLabel;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
function section(name, fn) {
    console.log('\n[' + name + ']');
    try {
        fn();
    }
    catch (e) {
        fail++;
        console.log('  FAIL 段落异常 [' + name + ']：' + e.message);
    }
}
/** 种子 PRNG：mulberry32 的等价 LCG，种子相同则牌局完全一致 */
function lcg(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const CardOf = (suit, rank, faceUp = true) => ({ suit, rank, faceUp });
const STOCK = { kind: 'stock' };
const WASTE = { kind: 'waste' };
const FOUND = (suit) => ({ kind: 'foundation', suit });
const COL = (index) => ({ kind: 'tableau', index });
/** 完整 52 张牌（派发一致性检查用） */
function allCards(e) {
    const out = e.cardsAt(STOCK);
    for (const s of SUITS)
        out.push(...e.cardsAt(FOUND(s)));
    out.push(...e.cardsAt(WASTE));
    for (let i = 0; i < 7; i++)
        out.push(...e.cardsAt(COL(i)));
    return out;
}
/** 牌面清单（用于对拍/去重） */
function signature(c) { return c.suit + c.rank; }
/* ---------- [1] 发牌 ---------- */
section('1 发牌与初始布局', () => {
    const e = new EngineCtor(lcg(1), () => 0);
    const counts = [];
    for (let i = 0; i < 7; i++)
        counts.push(e.tableauCount(i));
    ok(counts.join(',') === '1,2,3,4,5,6,7', '牌阵列数依次为 1..7');
    ok(e.stockCount === 24 && e.wasteCount === 0, '牌库 24 张、废牌堆为空');
    ok(e.moves === 0 && e.phase === 'playing', '初始步数 0、状态 playing');
    ok(e.elapsed() === 0, '未操作时计时为 0');
    let faceUpOk = true;
    for (let i = 0; i < 7; i++) {
        const pile = e.cardsAt(COL(i));
        pile.forEach((c, idx) => { if (c.faceUp !== (idx === pile.length - 1))
            faceUpOk = false; });
    }
    ok(faceUpOk, '每列只有最上面一张是明牌');
    const cards = allCards(e);
    ok(cards.length === 52, '总共 52 张牌');
    ok(new Set(cards.map(signature)).size === 52, '没有重复牌');
    const perSuit = {};
    for (const c of cards)
        perSuit[c.suit] = (perSuit[c.suit] ?? 0) + 1;
    ok(SUITS.every((s) => perSuit[s] === 13), '每种花色 13 张');
});
/* ---------- [2] 核心叠放规则 ---------- */
section('2 牌阵/收牌区叠放规则', () => {
    // 空列只接 K；红黑交替；点数递减
    const e = EngineCtor.planted({
        tableau: [
            [['H', 13], ['S', 12], ['H', 11]],
            [['D', 10]],
            [],
        ],
    });
    ok(e.canMove(COL(0), 2, COL(1)) === false, '红 11 不能压红方 10（同色拒绝）');
    ok(e.canMove(COL(0), 1, COL(2)) === false, 'Q 不能移到空列（空列只接 K）');
    ok(e.canMove(COL(0), 1, COL(0)) === false, '不能移到自身（U 型回归）');
    const e2 = EngineCtor.planted({ tableau: [[['S', 7]], [['H', 8]], [], [['D', 13]]] });
    ok(e2.canMove(COL(0), 1, COL(1)) === true, '黑 7 可压红 8（红黑交替、递减）');
    ok(e2.canMove(COL(1), 1, COL(0)) === false, '红 8 不能压黑 7（递增拒绝）');
    ok(e2.canMove(COL(3), 1, COL(2)) === true, 'K 可以移入空列');
    const e3 = EngineCtor.planted({ tableau: [[['S', 5, true], ['H', 4, false]]] });
    ok(e3.canMove(COL(0), 2, COL(1)) === false, '含暗牌的牌组不能整组移动');
    ok(e3.canMove(COL(0), 1, COL(1)) === false, '暗牌不能单独移动');
    // 整组不仅要全明，组内也必须满足红黑交替、点数递减。
    const sequence = EngineCtor.planted({
        tableau: [
            [['S', 7], ['H', 6], ['S', 5]], [['D', 8]],
            [['S', 7], ['D', 5], ['S', 4]],
            [['S', 7], ['D', 6], ['D', 5]],
        ],
    });
    ok(sequence.canMove(COL(0), 3, COL(1)) === true, '合法明牌序列可以整组移动');
    ok(sequence.canMove(COL(2), 3, COL(1)) === false, '组内点数断层时拒绝整组移动');
    ok(sequence.canMove(COL(3), 3, COL(1)) === false, '组内颜色未交替时拒绝整组移动');
    ok(sequence.canMove(WASTE, 2, COL(1)) === false, '废牌堆不能一次移走多张');
    ok(sequence.canMove(FOUND('S'), 2, COL(1)) === false, '收牌区不能一次移走多张');
    // 收牌区：同花色、从 A 起递增、一次一张
    const e4 = EngineCtor.planted({
        foundations: { S: [['S', 1], ['S', 2]] },
        tableau: [[['S', 3]], [['H', 2]], [['S', 4], ['H', 2]]],
    });
    ok(e4.canMove(COL(0), 1, FOUND('S')) === true, '黑桃 3 可接到黑桃 2 上');
    ok(e4.canMove(COL(0), 1, FOUND('H')) === false, '花色不符不能进收牌区');
    ok(e4.canMove(COL(1), 1, FOUND('S')) === false, '点数不符不能进收牌区');
    ok(e4.canMove(COL(2), 2, FOUND('S')) === false, '收牌区不能一次收多张');
});
/* ---------- [3] 移动与自动翻牌 ---------- */
section('3 移动执行的副作用', () => {
    const e = EngineCtor.planted({
        tableau: [[['S', 9, false], ['H', 8, true]], [['C', 9, true]]],
    });
    ok(e.move(COL(0), 1, COL(1)).ok === true, '合法移动返回 ok');
    ok(e.cardsAt(COL(0))[0].faceUp === true, '移走顶部牌后新的顶牌自动翻开');
    ok(e.moves === 1, '移动计入步数');
    ok(e.tableauCount(0) === 1, '源列少了一张');
    const before = e.cardsAt(COL(1));
    ok(e.move(COL(0), 1, COL(1)).ok === false, '暗牌无法移动');
    ok(e.cardsAt(COL(1)).length === before.length, '非法移动不改变牌局');
    // canMove 是只读的
    const e2 = EngineCtor.planted({ tableau: [[['S', 7]], [['H', 8]]] });
    const n0 = e2.tableauCount(0), n1 = e2.tableauCount(1);
    e2.canMove(COL(0), 1, COL(1));
    ok(e2.tableauCount(0) === n0 && e2.tableauCount(1) === n1, 'canMove 不改变状态');
    // 牌库与废牌堆不能作为目标
    ok(e2.canMove(COL(0), 1, WASTE) === false && e2.canMove(COL(0), 1, STOCK) === false, '牌库/废牌堆不能叠牌');
    ok(e2.canMove(STOCK, 1, COL(1)) === false, '牌库的牌不能直接拖动');
    ok(e2.canMove(COL(0), 1, COL(0)) === false, '不能移到自身');
});
/* ---------- [4] 翻牌与回收 ---------- */
section('4 牌库翻牌与回收', () => {
    const e = EngineCtor.planted({
        stock: [['S', 1], ['S', 2], ['S', 3], ['S', 4]],
    }, () => 0, 1);
    ok(e.draw().drawn === 1, '翻 1 张模式每次取 1 张');
    ok(e.wasteCount === 1 && e.stockCount === 3, '废牌堆 +1、牌库 -1');
    ok(e.cardsAt(WASTE)[0].faceUp === true, '翻出的牌是明牌');
    const e3 = EngineCtor.planted({ stock: [['S', 1], ['S', 2], ['S', 3], ['S', 4]] }, () => 0, 3);
    ok(e3.draw().drawn === 3 && e3.stockCount === 1, '翻 3 张模式一次取 3 张');
    ok(e3.draw().drawn === 1, '余 1 张时只取到 1 张');
    // 回收顺序：废牌堆顶（最后翻出的）变成新牌库顶，翻牌顺序与原来一致
    const r = EngineCtor.planted({ stock: [['S', 1], ['S', 2], ['S', 3]] }, () => 0, 1);
    r.draw();
    r.draw();
    r.draw();
    const wasteOrder = r.cardsAt(WASTE).map(signature).join(',');
    ok(wasteOrder === 'S3,S2,S1', '三张依次翻出，废牌堆顶是 S3');
    const rec = r.draw();
    ok(rec.recycled === true && rec.drawn === 0, '牌库空时 draw() 触发回收');
    ok(r.stockCount === 3 && r.wasteCount === 0, '回收后废牌堆清空、牌库复原');
    r.draw();
    ok(signature(r.cardsAt(WASTE)[0]) === 'S3', '回收后先翻开的是废牌堆底部（整叠翻面，物理顺序不变）');
    const empty = EngineCtor.planted({});
    const nothing = empty.draw();
    ok(nothing.drawn === 0 && nothing.recycled === false, '无牌可翻时返回空结果');
});
/* ---------- [5] 撤销 ---------- */
section('5 撤销', () => {
    const e = EngineCtor.planted({
        stock: [['S', 1]], tableau: [[['H', 13, true]], [['S', 12, true]]],
    });
    ok(e.undo() === false, '无历史时撤销返回 false');
    e.move(COL(1), 1, COL(0));
    ok(e.tableauCount(0) === 2 && e.moves === 1, '移动生效');
    ok(e.undo() === true, '撤销成功');
    ok(e.tableauCount(0) === 1 && e.tableauCount(1) === 1 && e.moves === 0, '撤销恢复牌局与步数');
    // 自动翻牌也要一起撤回
    const f = EngineCtor.planted({ tableau: [[['S', 9, false], ['H', 8, true]], [['C', 9, true]]] });
    f.move(COL(0), 1, COL(1));
    ok(f.cardsAt(COL(0))[0].faceUp === true, '移动后翻开了暗牌');
    f.undo();
    ok(f.cardsAt(COL(0))[1].faceUp === true && f.cardsAt(COL(0))[0].faceUp === false, '撤销后暗牌重新盖回');
    // 翻牌也能撤销
    const g = EngineCtor.planted({ stock: [['S', 1], ['S', 2]] });
    g.draw();
    ok(g.wasteCount === 1, '翻牌后废牌堆 1 张');
    g.undo();
    ok(g.wasteCount === 0 && g.stockCount === 2, '撤销翻牌：牌回到牌库');
    // 撤销胜利状态
    const w = EngineCtor.planted({
        foundations: { S: Array.from({ length: 12 }, (_, i) => ['S', i + 1]), H: Array.from({ length: 13 }, (_, i) => ['H', i + 1]),
            D: Array.from({ length: 13 }, (_, i) => ['D', i + 1]), C: Array.from({ length: 13 }, (_, i) => ['C', i + 1]) },
        tableau: [[['S', 13]]],
    });
    w.move(COL(0), 1, FOUND('S'));
    ok(w.phase === 'won', '集齐 52 张即胜利');
    ok(w.undo() === true && w.phase === 'playing', '撤销可以从胜利状态退回');
});
/* ---------- [6] 双击送牌 ---------- */
section('6 双击自动收牌', () => {
    const e = EngineCtor.planted({
        foundations: { H: [['H', 1]] },
        tableau: [[['H', 2, true]], [['S', 5, true]], []],
        waste: [['H', 3, true]],
    });
    ok(e.autoMove(COL(0)) === 'H', '牌阵顶牌送入收牌区');
    ok(e.foundationCount('H') === 2, '收牌区计数增加');
    ok(e.autoMove(COL(1)) === null, '不满足条件时返回 null');
    ok(e.autoMove(WASTE) === 'H', '废牌堆顶牌也能双击收走');
    ok(e.autoMove(WASTE) === null, '废牌堆空后返回 null');
});
/* ---------- [7] 计时 ---------- */
section('7 计时', () => {
    let now = 1000;
    const e = new EngineCtor(lcg(7), () => now);
    ok(e.elapsed() === 0, '首次操作前为 0');
    e.draw();
    now += 5000;
    ok(e.elapsed() === 5, '首次操作后开始计时');
    now -= 3000; // 时钟回拨
    ok(e.elapsed() === 2, '时钟回拨不产生负秒（钳到 0 后仍是单调结果）');
    now = 0;
    ok(e.elapsed() >= 0, '时钟回到 0 也不出现负秒');
    // 回归：第一张可操作的牌就完成全局时，不能一直显示 0 秒。
    const fill = (suit, n) => Array.from({ length: n }, (_, i) => [suit, i + 1]);
    let clockCalls = 0;
    const immediateWin = EngineCtor.planted({
        foundations: { S: fill('S', 12), H: fill('H', 13), D: fill('D', 13), C: fill('C', 13) },
        tableau: [[['S', 13]]],
    }, () => 1000 + (clockCalls++) * 5000);
    immediateWin.move(COL(0), 1, FOUND('S'));
    ok(immediateWin.phase === 'won' && immediateWin.elapsed() === 5, '首次操作即获胜时建立计时起止点并正常冻结');
});
/* ---------- [8] 提示 ---------- */
section('8 提示', () => {
    const e = EngineCtor.planted({
        foundations: { S: [['S', 1], ['S', 2]] },
        tableau: [[['S', 3, true]], [['C', 4, false], ['H', 5, true]], []],
    });
    const h = e.hint();
    ok(h !== null, '存在合法走法时能给出提示');
    ok(h.to.kind === 'foundation', '优先推荐送进收牌区');
    ok(h.text.length > 0, '提示带可读文案');
    const none = EngineCtor.planted({ tableau: [[['S', 2, true]], [['H', 2, true]]] });
    ok(none.hint() === null, '无路可走时提示为 null');
    // 能翻出暗牌的走法优先于普通走法
    const reveal = EngineCtor.planted({
        tableau: [[['D', 9, false], ['S', 8, true]], [['H', 9, true]], [['D', 2, true]], []],
    });
    const hh = reveal.hint();
    ok(hh !== null && hh.from.kind === 'tableau', '推荐移动牌阵内的牌');
    ok(hh.text.includes('第 2 列'), '推荐能把暗牌翻出来的走法');
});
/* ---------- [9] 自动完成 ---------- */
section('9 自动完成', () => {
    const ready = EngineCtor.planted({
        // 四张 K 分放四列，才能逐张送进各自花色的收牌区
        tableau: [[['S', 13, true]], [['H', 13, true]], [['D', 13, true]], [['C', 13, true]]],
        foundations: {
            S: Array.from({ length: 12 }, (_, i) => ['S', i + 1]),
            H: Array.from({ length: 12 }, (_, i) => ['H', i + 1]),
            D: Array.from({ length: 12 }, (_, i) => ['D', i + 1]),
            C: Array.from({ length: 12 }, (_, i) => ['C', i + 1]),
        },
    });
    ok(ready.canAutoFinish() === true, '牌库清空且全明时可自动完成');
    let steps = 0;
    while (ready.autoFinishStep())
        steps++;
    ok(steps === 4 && ready.phase === 'won', '四张 K 依次收完后胜利');
    const busy = EngineCtor.planted({ stock: [['S', 1]], tableau: [[['H', 2, true]]] });
    ok(busy.canAutoFinish() === false, '牌库还有牌时不可自动完成');
});
/* ---------- [10] 随机整局对拍 ---------- */
section('10 随机对拍（200 局发牌 → 打乱 → 校验不变量）', () => {
    let dealtOk = true, moveOk = true, undoOk = true;
    for (let seed = 1; seed <= 200; seed++) {
        const rand = lcg(seed);
        const e = new EngineCtor(rand, () => 0);
        if (allCards(e).length !== 52 || new Set(allCards(e).map(signature)).size !== 52)
            dealtOk = false;
        if (e.stockCount !== 24)
            dealtOk = false;
        // 随机做 40 步操作（翻牌 / 移动 / 双击），每步检查牌数守恒
        const before = e.moves;
        for (let step = 0; step < 40; step++) {
            const roll = rand();
            if (roll < 0.4)
                e.draw();
            else if (roll < 0.7) {
                const from = Math.floor(rand() * 7);
                const to = Math.floor(rand() * 7);
                const cnt = 1 + Math.floor(rand() * 3);
                e.move(COL(from), cnt, COL(to));
            }
            else {
                e.autoMove(COL(Math.floor(rand() * 7)));
            }
            if (allCards(e).length !== 52)
                moveOk = false;
            if (new Set(allCards(e).map(signature)).size !== 52)
                moveOk = false;
        }
        // 全部撤销应回到初始状态
        let guard = 0;
        while (e.undo() && guard++ < 1000) { /* 撤销到底 */ }
        if (e.moves !== before)
            undoOk = false;
        const cards = allCards(e);
        if (cards.length !== 52 || cards.some((c) => c.faceUp && false))
            undoOk = false;
    }
    ok(dealtOk, '每局发牌都是 52 张不重复、牌库 24 张');
    ok(moveOk, '随机操作后牌数守恒、无重复');
    ok(undoOk, '撤销到底后步数归零、牌数守恒');
});
/* ---------- [11] 边界与非法输入 ---------- */
section('11 边界与参数校验', () => {
    let threw = false;
    try {
        new EngineCtor(lcg(1), () => 0, 2);
    }
    catch (e) {
        threw = true;
    }
    ok(threw, '非法的抽牌模式被拒绝');
    const e = EngineCtor.planted({ tableau: [[['S', 5, true]]] });
    ok(e.move(COL(0), 0, COL(1)).ok === false, '移动 0 张被拒绝');
    ok(e.move(COL(0), 2, COL(1)).ok === false, '移动超过牌数的张数被拒绝');
    ok(e.move(COL(99), 1, COL(0)).ok === false, '不存在的列被拒绝');
    ok(e.move(COL(0), 1, COL(99)).ok === false, '目标列不存在被拒绝');
    ok(e.topCard(COL(0)) !== null && e.topCard(COL(1)) === null, '空列 topCard 为 null');
    ok(e.cardsAt(COL(42)).length === 0, '越界列返回空数组');
    // 只读视图不能改内部状态
    const view = e.cardsAt(COL(0));
    view[0].rank = 13;
    ok(e.cardsAt(COL(0))[0].rank === 5, 'cardsAt 返回副本，外部修改不影响引擎');
});
/* ---------- [12] 工具函数 ---------- */
section('12 工具函数', () => {
    ok(isRed(CardOf('H', 1)) && isRed(CardOf('D', 1)), '红桃/方块是红色');
    ok(!isRed(CardOf('S', 1)) && !isRed(CardOf('C', 1)), '黑桃/梅花是黑色');
    ok(rankLabel(1) === 'A' && rankLabel(11) === 'J' && rankLabel(13) === 'K' && rankLabel(10) === '10', '点数标签');
    ok(SOL.suitLabel('S') === '黑桃' && SOL.suitLabel('D') === '方块', '花色标签');
    ok(SOL.sameLocation(COL(1), COL(1)) && !SOL.sameLocation(COL(1), COL(2)), '位置比较');
});
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
