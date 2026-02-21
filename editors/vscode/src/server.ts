import fs from "fs";
import fsPromise from "fs/promises";
import path from "path";
import { exit } from "process";
import { RpcMessage, PipelexLsp } from "@pipelex/lsp";
import fetch, { Headers, Request, Response } from "node-fetch";
import glob from "fast-glob";

let pipelex: PipelexLsp;

process.on("message", async (d: RpcMessage) => {
  if (d.method === "exit") {
    exit(0);
  }

  if (typeof pipelex === "undefined") {
    pipelex = await PipelexLsp.initialize(
      {
        cwd: () => process.cwd(),
        envVar: name => process.env[name],
        envVars: () => Object.entries(process.env),
        findConfigFile: from => {
          const projectNames = [".pipelex/plxt.toml", "plxt.toml"];
          const taploNames = [".taplo.toml", "taplo.toml"];

          // 1. Project-level pipelex configs
          for (const name of projectNames) {
            try {
              const fullPath = path.join(from, name);
              fs.accessSync(fullPath);
              return fullPath;
            } catch { }
          }

          // 2. User-level config at ~/.pipelex/plxt.toml
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home) {
            try {
              const homeCfg = path.join(home, ".pipelex", "plxt.toml");
              fs.accessSync(homeCfg);
              return homeCfg;
            } catch { }
          }

          // 3. Taplo fallback configs
          for (const name of taploNames) {
            try {
              const fullPath = path.join(from, name);
              fs.accessSync(fullPath);
              return fullPath;
            } catch { }
          }
        },
        glob: p => glob.sync(p),
        isAbsolute: p => path.isAbsolute(p),
        now: () => new Date(),
        readFile: path => fsPromise.readFile(path),
        writeFile: (path, content) => fsPromise.writeFile(path, content),
        stderr: process.stderr,
        stdErrAtty: () => process.stderr.isTTY,
        stdin: process.stdin,
        stdout: process.stdout,
        urlToFilePath: (url: string) => {
          const c = decodeURIComponent(url).slice("file://".length);

          if (process.platform === "win32" && c.startsWith("/")) {
            return c.slice(1);
          }

          return c;
        },
        fetch: {
          fetch,
          Headers,
          Request,
          Response,
        },
      },
      {
        onMessage(message) {
          process.send(message);
        },
      }
    );
  }

  pipelex.send(d);
});

// These are panics from Rust.
process.on("unhandledRejection", up => {
  throw up;
});
