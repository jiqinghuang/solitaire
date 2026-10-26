"use strict";
/* 布局尺寸校验（零依赖，node dist/layout.js 直接跑）
   源码：src/layout.ts → 编译产物：dist/layout.js

   为什么单独测布局：
   牌宽从固定 px 改成了 clamp() 响应式，好处是窗口大时牌也大、接近满屏，
   但**代价是很容易算错**——只要预留的 chrome 少算几个像素，就会出现横向滚动条。
   这类 bug 在宽屏上完全看不出来，只有小屏或窄窗口才暴露，肉眼测试很难覆盖全。

   这里把 CSS 里的公式抽成纯函数，在几十个视口宽度上验证：
     1) 牌桌总宽 ≤ 视口宽（不出现横向滚动）
     2) 牌宽落在 [下限, 上限] 内（不会小到看不清、也不会大到溢出）
     3) 牌宽随视口单调不减（窗口变大牌不变小，不会跳变）
     4) 大屏能真的用上空间（不是永远卡在旧的最小尺寸）

   注意：这些数字必须与 style.css 的 :root 保持一致。改了 CSS 就要同步这里。 */
Object.defineProperty(exports, "__esModule", { value: true });
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
const clamp = (lo, v, hi) => Math.min(Math.max(v, lo), hi);
/* ---------- 与 style.css :root 保持一致的常量 ---------- */
/** --gap: clamp(4px, 100vw/120, 13px) */
const GAP_MIN = 4, GAP_MAX = 13, GAP_DIV = 120;
/** --card-w: clamp(30px, (100vw - 56 - gap*8 - 6)/7, 132px) */
const CARD_MIN = 30, CARD_MAX = 132, CHROME = 56, BORDER = 6, COLS = 7;
/**
 * 窗口外框的横向占用（不含牌桌本身）：
 *   .desktop padding 16 + .win padding 6 + .tablewrap padding 8
 *   + .tablewrap 左右 margin 12 + 牌桌边框 6 = 48
 * 与 CSS 里预留的 56 相比还留了 8px 安全余量。
 */
const OUTER = 48;
function gapFor(vw) { return clamp(GAP_MIN, vw / GAP_DIV, GAP_MAX); }
function cardWFor(vw) {
    const gap = gapFor(vw);
    return clamp(CARD_MIN, (vw - CHROME - gap * 8 - BORDER) / COLS, CARD_MAX);
}
/** .table 的 width（box-sizing: border-box，padding 已含在内） */
function tableWFor(vw) {
    const gap = gapFor(vw);
    return cardWFor(vw) * COLS + gap * 8 + BORDER;
}
/** 整扇窗口需要的横向像素 */
function neededFor(vw) { return tableWFor(vw) + OUTER; }
/** 覆盖从超宽屏到极窄手机的视口宽度 */
const VIEWPORTS = [2560, 2200, 1920, 1680, 1440, 1280, 1200, 1100, 1024, 960, 900, 860, 820, 768, 700, 640, 600, 540, 480, 430, 414, 390, 375, 360, 340, 320, 300];
section('L1 任何视口都不出现横向溢出', () => {
    // 找出最紧的视口（余量最小），而不是“最坏溢出”
    let tightest = { vw: VIEWPORTS[0], slack: Infinity };
    for (const vw of VIEWPORTS) {
        const slack = vw - neededFor(vw);
        if (slack < tightest.slack)
            tightest = { vw, slack };
    }
    ok(tightest.slack >= 0, `所有视口都装得下（最紧的是 ${tightest.vw}px，余量 ${tightest.slack.toFixed(0)}px）`);
    // 断言真的检查了东西：把牌宽人为放大 20%，必须能检测到溢出
    const inflated = (vw) => {
        const gap = gapFor(vw);
        const cw = cardWFor(vw) * 1.2;
        return cw * COLS + gap * 8 + BORDER + OUTER;
    };
    const detect = VIEWPORTS.some((vw) => inflated(vw) > vw);
    ok(detect, '断言确实有效：牌宽放大 20% 时能检测到溢出');
});
section('L2 牌宽落在合理区间', () => {
    const tooSmall = VIEWPORTS.filter((vw) => cardWFor(vw) < CARD_MIN - 0.01);
    const tooBig = VIEWPORTS.filter((vw) => cardWFor(vw) > CARD_MAX + 0.01);
    ok(tooSmall.length === 0, `没有视口让牌宽小于下限 ${CARD_MIN}px`);
    ok(tooBig.length === 0, `没有视口让牌宽超过上限 ${CARD_MAX}px`);
});
section('L3 牌宽随视口单调不减（窗口变大牌不变小）', () => {
    const sorted = VIEWPORTS.slice().sort((a, b) => a - b);
    let violation = '';
    for (let i = 1; i < sorted.length; i++) {
        const prev = cardWFor(sorted[i - 1]), cur = cardWFor(sorted[i]);
        if (cur < prev - 0.01) {
            violation = `${sorted[i - 1]}px→${prev.toFixed(1)} 但 ${sorted[i]}px→${cur.toFixed(1)}`;
            break;
        }
    }
    ok(violation === '', '牌宽随视口增大而单调不减' + (violation ? '（违反：' + violation + '）' : ''));
});
section('L4 大屏真的用上了空间（不是永远卡在旧尺寸）', () => {
    // 回归：旧版固定 96px，在 1920px 屏幕上只占 96*7+... ≈ 780px，浪费大量空间
    const oldFixedTable = 96 * 7 + 12 * 8 + 6;
    ok(tableWFor(1920) > oldFixedTable, `1920px 下牌桌 ${tableWFor(1920).toFixed(0)}px > 旧固定布局 ${oldFixedTable}px`);
    ok(cardWFor(1920) > 96, `1920px 下牌宽 ${cardWFor(1920).toFixed(1)}px > 旧的 96px`);
    // 但也不能无限拉伸
    ok(cardWFor(3840) === CARD_MAX, '超宽屏（3840px）牌宽被上限 132px 挡住，不会夸张放大');
});
section('L5 小屏仍然可玩（牌宽不过小）', () => {
    for (const vw of [375, 360, 320, 300]) {
        const cw = cardWFor(vw);
        ok(cw >= CARD_MIN - 0.01, `${vw}px 下牌宽 ${cw.toFixed(1)}px ≥ ${CARD_MIN}px（还能看清点数）`);
    }
});
section('L6 牌桌宽度公式自检', () => {
    // 牌桌宽必须等于「7 张牌 + 8 个间隙 + 边框」
    const vw = 1440;
    const cw = cardWFor(vw), gap = gapFor(vw);
    ok(Math.abs(tableWFor(vw) - (cw * 7 + gap * 8 + BORDER)) < 0.01, '牌桌宽 = 牌宽×7 + 间隙×8 + 边框');
    // 大屏时窗口占视口的比例应该很可观（接近满屏）
    const ratio = tableWFor(1920) / 1920;
    ok(ratio > 0.5, `1920px 下牌桌占视口 ${(ratio * 100).toFixed(0)}%（> 50%，视觉上接近满屏）`);
});
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
