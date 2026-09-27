#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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

// Copy the webview's own static assets. The renderer's stylesheets are NOT
// copied — esbuild bundles them from the import graph below.
mkdirSync("./dist/pipelex/graph/webview", { recursive: true });
cpSync(
  "./src/pipelex/graph/webview/graph.html",
  "./dist/pipelex/graph/webview/graph.html",
);
cpSync(
  "./src/pipelex/graph/webview/shell.css",
  "./dist/pipelex/graph/webview/shell.css",
);

// Bundle webview TypeScript → single IIFE script, plus the one stylesheet
// esbuild derives from the same import graph. React, ReactDOM, @xyflow/react
// v12, elkjs and mthds-ui are all bundled.
//
// The CSS comes out as `graph.css` beside `graph.js`, with every `@import`
// resolved — including the two that cannot be linked as written: @xyflow's base
// sheet, which `graph-core.css` pulls in by bare specifier, and the form
// kernel's, which the adapter imports through `@pipelex/mthds-ui/form-kernel.css`
// and which that file wraps in `@layer mthds-form`. The webview's own
// sheet is `shell.css` precisely so it does not collide with that output; when
// it was called `graph.css` the collision was worked around by switching CSS
// bundling off entirely and hand-copying each of mthds-ui's sheets, which meant
// a sheet added upstream went silently missing and a sheet deleted upstream
// broke this build.
//
// Minified because elkjs ships pre-minified GWT output that esbuild otherwise
// re-prints at more than twice the size: 5353 KB → 2190 KB for the bundle.
esbuild.buildSync({
  entryPoints: ["./src/pipelex/graph/webview/adapter.ts"],
  outfile: "./dist/pipelex/graph/webview/graph.js",
  bundle: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  minify: true,
  alias: {
    "react": reactDir,
    "react-dom": reactDomDir,
    "react/jsx-runtime": reactDir + "/jsx-runtime",
  },
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

// The renderer's stylesheet is emitted, never copied, so nothing fails loudly
// if it stops being emitted — the webview would simply render unstyled. Assert
// it landed, and that the form kernel's sheet is inside it: the two silent
// failures this arrangement can still have. The second is not hypothetical —
// mthds-ui 0.25.0 stopped importing the kernel sheet from `graph/react`, and a
// graph.css without it is still emitted, holding everything but the styles of
// the detail panel's controls.
const graphCss = "./dist/pipelex/graph/webview/graph.css";
if (!existsSync(graphCss)) {
  throw new Error(
    "esbuild emitted no graph.css for the webview. The renderer's styles reach " +
      "the bundle through graph.js's import graph — check that no CSS loader " +
      "override was reintroduced and that @pipelex/mthds-ui still imports its sheets.",
  );
}
if (!readFileSync(graphCss, "utf-8").includes("@layer mthds-form")) {
  throw new Error(
    "graph.css holds no `@layer mthds-form`: the form kernel's stylesheet did not " +
      "reach the webview, so the detail panel's controls would render unstyled. " +
      "Check that src/pipelex/graph/webview/adapter.ts still imports " +
      "'@pipelex/mthds-ui/form-kernel.css', and that the file still wraps the " +
      "kernel sheet in that layer.",
  );
}

exec("yarn", ["build:browser-extension"]);
exec("yarn", ["build:browser-server"]);
