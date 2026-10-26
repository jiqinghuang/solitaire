"use strict";
/* 花色配色的色彩科学校验（零依赖，node dist/palette.js 直接跑）
   源码：src/palette.ts → 编译产物：dist/palette.js

   为什么要专门测配色：
   纸牌的核心规则是「红黑交替」，所以花色的**颜色本身**是游戏信息的一部分，
   不是纯装饰。旧配色有三个真实缺陷，肉眼不易察觉但能量化：

     1) 方块用 #e2551e（OKLCh 色相 39°）是朱橙，与红桃（21°）只差 18°。
        玩家可能把它当成「第三色」，从而误判红黑交替是否成立。
     2) 方块对牌面的对比度只有 3.78，低于 WCAG AA 的 4.5——
        小字号（角标 17px）在低端屏或视力不佳时偏淡。
     3) 黑桃是 H=265° 的藏青、梅花是 H=160° 的绿黑，
        两个「黑」色相相差 105°，不符合「黑就是黑」的直觉。

   本测试把这三条约束固化成断言，任何改动只要破坏它们就会失败。
   色彩转换用 OKLab/OKLCh（比 HSL 更接近人眼感知，明度也符合 CIE Lab 的 L*）。 */
Object.defineProperty(exports, "__esModule", { value: true });
const nodeFs = require('fs');
const nodePath = require('path');
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
/* ---------- 色彩空间转换 ---------- */
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const hexToRgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16) / 255);
const rgbToHex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
function rgbToOklab([r, g, b]) {
    const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}
function oklabToRgb([L, a, b]) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    return [
        linToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        linToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        linToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    ];
}
/** OKLCh：L 是感知明度（0–1），C 是彩度，H 是色相角（0–360） */
function oklch(hex) {
    const [L, a, b] = rgbToOklab(hexToRgb(hex));
    let H = (Math.atan2(b, a) * 180) / Math.PI;
    if (H < 0)
        H += 360;
    return { L, C: Math.hypot(a, b), H };
}
/** WCAG 相对亮度与对比度 */
const relLum = (hex) => {
    const [r, g, b] = hexToRgb(hex).map(srgbToLin);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
    const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
};
/* ---------- 从 style.css 读取真实配色（不重复维护一份常量） ---------- */
function readPalette() {
    const css = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'style.css'), 'utf8');
    const out = {};
    for (const m of css.matchAll(/--suit-([schd])\s*:\s*(#[0-9a-fA-F]{6})/g))
        out[m[1].toUpperCase()] = m[2];
    return out;
}
/** 牌面底色：.card.face-up 的渐变中位色。取中间那档 #fcfbf8 作代表。 */
const CARD_FACE = '#fcfbf8';
/** WCAG AA 对正文的要求 */
const AA = 4.5;
/** 纯红 #ff0000 的 OKLCh 色相约 29°；超过 36° 就开始明显偏橙 */
const MAX_RED_HUE = 36;
const P = readPalette();
section('P1 四个花色都从 style.css 读到了', () => {
    ok(Object.keys(P).length === 4, '解析出 4 个花色变量（实际：' + Object.keys(P).join(',') + '）');
    ok(['S', 'H', 'D', 'C'].every((k) => /^#[0-9a-fA-F]{6}$/.test(P[k] ?? '')), '每个都是合法 6 位十六进制');
});
section('P2 两个「红」必须真的在红色区（影响红黑交替判断）', () => {
    for (const [k, name] of [['H', '红桃'], ['D', '方块']]) {
        const c = oklch(P[k]);
        ok(c.H < MAX_RED_HUE, `${name}色相 ${c.H.toFixed(0)}° < ${MAX_RED_HUE}°（是红不是橙）`);
        ok(c.C > 0.10, `${name}彩度 ${c.C.toFixed(3)} > 0.10（足够饱和，不像褪色）`);
    }
    // 红桃与方块不能太像，否则两门红分不清
    const dh = Math.abs(oklch(P.H).H - oklch(P.D).H);
    const dl = Math.abs(oklch(P.H).L - oklch(P.D).L) * 100;
    ok(dh >= 2 || dl >= 4, `红桃与方块有可辨差异（ΔH=${dh.toFixed(0)}° ΔL*=${dl.toFixed(1)}）`);
});
section('P3 两个「黑」必须是同一种黑（色相接近，仅明度不同）', () => {
    const s = oklch(P.S), c = oklch(P.C);
    const dh = Math.abs(s.H - c.H);
    const dhWrapped = Math.min(dh, 360 - dh);
    ok(dhWrapped <= 20, `黑桃/梅花色相相差 ${dhWrapped.toFixed(0)}° ≤ 20°（不再是藏青 vs 绿黑）`);
    ok(s.C < 0.03 && c.C < 0.03, `两者彩度都很低（${s.C.toFixed(3)} / ${c.C.toFixed(3)}，接近中性黑）`);
    const dl = Math.abs(s.L - c.L) * 100;
    ok(dl >= 3, `靠明度区分：ΔL*=${dl.toFixed(1)} ≥ 3（不会糊成一团）`);
});
section('P4 所有花色对牌面的对比度都达到 WCAG AA', () => {
    for (const [k, name] of [['S', '黑桃'], ['H', '红桃'], ['D', '方块'], ['C', '梅花']]) {
        const ratio = contrast(P[k], CARD_FACE);
        ok(ratio >= AA, `${name}对比度 ${ratio.toFixed(2)} ≥ ${AA}`);
    }
    // 回归：旧版方块 #e2551e 只有 3.78，低于 AA
    ok(contrast('#e2551e', CARD_FACE) < AA, '旧方块 #e2551e 确实不达标（证明这条断言有意义）');
});
section('P5 红黑两族在明度上必须分得开', () => {
    const redL = (oklch(P.H).L + oklch(P.D).L) / 2;
    const blackL = (oklch(P.S).L + oklch(P.C).L) / 2;
    const gap = (redL - blackL) * 100;
    ok(gap > 20, `红族比黑族亮 ${gap.toFixed(1)} L*（> 20，扫一眼就能分族）`);
});
section('P6 颜色不重复（四个花色两两可辨）', () => {
    const keys = ['S', 'H', 'D', 'C'];
    let dup = 0;
    for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
            if (P[keys[i]].toLowerCase() === P[keys[j]].toLowerCase())
                dup++;
        }
    }
    ok(dup === 0, '四个花色没有完全相同的颜色');
});
section('P7 色彩转换自检（保证上面的度量可信）', () => {
    // 往返转换误差应极小
    const roundTrip = (hex) => {
        const [L, a, b] = rgbToOklab(hexToRgb(hex));
        return Math.max(...hexToRgb(rgbToHex(oklabToRgb([L, a, b]))).map((v, i) => Math.abs(v - hexToRgb(hex)[i])));
    };
    ok(roundTrip('#c53825') < 0.01, 'OKLab 往返转换误差 < 1%（度量可信）');
    // 已知参照：纯红 #ff0000 的色相约 29°，纯黑明度接近 0，纯白明度接近 1
    ok(Math.abs(oklch('#ff0000').H - 29.2) < 1, '纯红 #f00 的 OKLCh 色相 ≈ 29°（参照正确）');
    ok(oklch('#000000').L < 0.01 && oklch('#ffffff').L > 0.99, '黑/白的 L* 边界正确');
    // WCAG 参照：黑白对比度 = 21
    ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 0.1, '黑白对比度 = 21（WCAG 公式正确）');
});
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
