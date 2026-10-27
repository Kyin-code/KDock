import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // 别去监视 Rust 那边：cargo 写 target/ 时会锁住 .dll/.pdb，
    // Vite 的 watcher 一碰就 EBUSY 崩掉（顺带还会因为 target 抖动疯狂整页重载）
    watch: { ignored: ["**/target/**", "**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    outDir: "dist",
    emptyOutDir: true,
    // 启动画面是第二个页面，得让 Vite 一起产出 dist/splash.html
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        splash: resolve(__dirname, "splash.html"),
      },
    },
  },
});
