#!/usr/bin/env node

import { cpSync } from "node:fs";
import { exec, unlink } from "../../../scripts/utils.mjs";

unlink("./dist");
exec("yarn", ["build:syntax"]);
exec("yarn", ["build:node"]);

// Copy webview static assets to dist
cpSync(
  "./src/pipelex/graph/webview",
  "./dist/pipelex/graph/webview",
  { recursive: true },
);

exec("yarn", ["build:browser-extension"]);
exec("yarn", ["build:browser-server"]);
