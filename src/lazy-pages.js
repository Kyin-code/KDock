// Page-level lazy loaders. A failed load is evicted so the user can retry after
// a transient filesystem/IPC error; successful modules are shared by all callers.
const pending = new Map();

function once(key, importer) {
  let promise = pending.get(key);
  if (!promise) {
    promise = importer().catch((error) => {
      pending.delete(key);
      throw error;
    });
    pending.set(key, promise);
  }
  return promise;
}

export const loadHelpPage = () => once("help", () => import("./help-content.js"));
export const loadLogicPage = () => once("logic", () => import("./logic-analyzer.js"));
export const loadRuntimePage = () => once("runtime", () => import("./runtime-graph.js"));
export const loadToolsPage = () => once("tools", () => import("./tools-batch-calc.js"));

export function loadUPlot() {
  return once("uplot", async () => {
    const [module] = await Promise.all([
      import("uplot"),
      import("uplot/dist/uPlot.min.css"),
    ]);
    return module.default;
  });
}
