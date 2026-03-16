#!/usr/bin/env node

import { cpSync, mkdirSync } from "node:fs";
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
cpSync(
  "./node_modules/@pipelex/mthds-ui/dist/graph/react/graph-core.css",
  "./dist/pipelex/graph/webview/graph-core.css",
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
