import rust from "@wasm-tool/rollup-plugin-rust";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import path from "path";
import process from "process";
import { minify } from "rollup-plugin-esbuild";
import typescript from "@rollup/plugin-typescript";

export default {
  input: {
    index: "src/index.ts",
  },
  output: {
    sourcemap: false,
    name: "taplo",
    format: "umd",
    dir: "dist",
  },
  plugins: [
    typescript(),
    rust({
      nodejs: true,
      inlineWasm: true,
      verbose: process.env["VERBOSE"] === "true",
      optimize: {
        release: process.env["RELEASE"] === "true",
        // Off, as the bundles have always shipped: under plugin 2, yarn left
        // binaryen's wasm-opt off the PATH and the attempt failed silently.
        // It also keeps binaryen an unprovided optional peer (js/.yarnrc.yml).
        wasmOpt: false,
      },
      extraArgs: {
        cargo: ["--frozen"],
      },
    }),
    commonjs(),
    resolve({
      jsnext: true,
      preferBuiltins: true,
      rootDir: path.join(process.cwd(), ".."),
    }),
    minify(),
  ],
};
