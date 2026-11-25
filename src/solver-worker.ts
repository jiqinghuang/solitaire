/* 求解器 Web Worker：把完整搜索移出主线程，避免「分析局面」冻结界面。
   页面通过 new Worker('dist/solver-worker.js') 启动；worker 内加载同目录的 solver.js。
   若浏览器不支持 Worker / file:// 环境禁止 Worker，ui.ts 会自动回退到同步搜索。 */

const workerScope: any = self;
workerScope.importScripts('solver.js');

workerScope.onmessage = (e: MessageEvent): void => {
  const data: any = e.data ?? {};
  try {
    const opts: any = { ...(data.opts ?? {}) };
    if (Array.isArray(opts.avoidSuggestionStates)) {
      opts.avoidSuggestionStates = new Set(opts.avoidSuggestionStates);
    }
    const report = workerScope.SolitaireSolver.analyze(data.st, data.pass, opts);
    workerScope.postMessage({ id: data.id, report });
  } catch (err) {
    workerScope.postMessage({ id: data.id, error: String(err) });
  }
};
