#!/usr/bin/env node

import { cpSync, mkdirSync } from "node:fs";
import esbuild from "esbuild";
import { exec, unlink } from "../../../scripts/utils.mjs";

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

// Bundle webview TypeScript → single IIFE script
// CDN globals (React, ReactDOM, ReactFlow, dagre) are accessed via window.*
// and typed through globals.d.ts — no externals needed.
esbuild.buildSync({
  entryPoints: ["./src/pipelex/graph/webview/adapter.ts"],
  outfile: "./dist/pipelex/graph/webview/graph.js",
  bundle: true,
  format: "iife",
  target: "es2020",
});

exec("yarn", ["build:browser-extension"]);
exec("yarn", ["build:browser-server"]);
