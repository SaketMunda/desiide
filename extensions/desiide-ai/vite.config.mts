import { defineConfig } from 'vite';

// One bundle serves both webview views; the host picks the view via `data-view` on #root.
export default defineConfig({
  root: 'webview',
  base: './',
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    cssCodeSplit: false,
    rolldownOptions: {
      input: 'webview/main.tsx',
      output: {
        entryFileNames: 'main.js',
        // Lazily loaded highlight.js grammars.
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (asset) =>
          asset.names.some((n) => n.endsWith('.css')) ? 'main.css' : '[name][extname]',
      },
    },
  },
});
