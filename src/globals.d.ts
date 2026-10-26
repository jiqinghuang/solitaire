/* 全局环境声明（仅类型；tsc 不产出此文件）
   项目刻意不引入 @types/node，只声明用到的最小面。 */

/** dist 里的测试脚本以 CommonJS require 引入同目录产物 */
declare function require(id: string): any;
declare const __dirname: string;
declare var process: { exit(code?: number): never };

/** src/engine.ts 的 UMD 包装需要（浏览器里 module 为 undefined，运行时有 typeof 守卫） */
declare var module: { exports: any };

/** 浏览器端由 dist/engine.js 挂载到全局；src/ui.ts 据此获得运行时入口 */
declare var Solitaire: SolitaireAPI;
