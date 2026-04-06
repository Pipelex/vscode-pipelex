#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import esbuild from "esbuild";
import { exec, unlink } from "../../../scripts/utils.mjs";

// Resolve to the single local copy of React so mthds-ui (portal) doesn't
// pull in its own node_modules/react — avoids the dual-React hooks crash.
const require = createRequire(import.meta.url);
const reactDir = dirname(require.resolve("react/package.json"));
const reactDomDir = dirname(require.resolve("react-dom/package.json"));

unlink("./dist");
exec("yarn", ["build:syntax"]);
exec("yarn", ["build:node"]);

// Copy webview static assets (HTML + CSS only — JS is bundled below)
mkdirSync("./dist/pipelex/graph/webview", { recursive: true });
cpSync(
  "./src/pipelex/graph/webview/graph.html",
  "./dist/pipelex/graph/webview/graph.html",
);
cpSync(
  "./src/pipelex/graph/webview/graph.css",
  "./dist/pipelex/graph/webview/graph.css",
);
cpSync(
  "./node_modules/@xyflow/react/dist/style.css",
  "./dist/pipelex/graph/webview/xyflow.css",
);
// Strip bare-module @import that can't resolve in the webview context
// (xyflow styles are already loaded via a separate <link> tag)
writeFileSync(
  "./dist/pipelex/graph/webview/graph-core.css",
  readFileSync(
    "./node_modules/@pipelex/mthds-ui/dist/graph/react/graph-core.css",
    "utf-8",
  ).replace(/@import\s+["'][^"']*["'];?\s*\n?/g, ""),
);
cpSync(
  "./node_modules/@pipelex/mthds-ui/dist/graph/react/stuff/StuffViewer.css",
  "./dist/pipelex/graph/webview/stuff-viewer.css",
);
cpSync(
  "./node_modules/@pipelex/mthds-ui/dist/graph/react/detail/DetailPanel.css",
  "./dist/pipelex/graph/webview/detail-panel.css",
);

// Bundle webview TypeScript → single IIFE script
// React, ReactDOM, @xyflow/react v12, dagre, and mthds-ui are all bundled.
esbuild.buildSync({
  entryPoints: ["./src/pipelex/graph/webview/adapter.ts"],
  outfile: "./dist/pipelex/graph/webview/graph.js",
  bundle: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  // Treat CSS imports as no-ops — CSS is loaded via <link> tags in graph.html,
  // not bundled. Without this, esbuild emits a graph.css that overwrites the
  // manually-copied extension CSS (toolbar styles, theme vars, layout).
  loader: { ".css": "empty" },
  alias: {
    "react": reactDir,
    "react-dom": reactDomDir,
    "react/jsx-runtime": reactDir + "/jsx-runtime",
  },
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

exec("yarn", ["build:browser-extension"]);
exec("yarn", ["build:browser-server"]);
