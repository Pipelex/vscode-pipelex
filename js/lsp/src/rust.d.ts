// A crate's `Cargo.toml` imported with `?custom`, as @wasm-tool/rollup-plugin-rust 3
// compiles it. `module` is the crate's Wasm, inlined into the bundle as bytes
// (`inlineWasm: true`), and `init` instantiates it and resolves to the crate's
// wasm-bindgen exports. A plain `Cargo.toml` import would instantiate the Wasm with
// a top-level await, which the UMD and CommonJS bundles built here cannot carry, so
// every package loads its crate through `init`, lazily, on its first initialize.
declare module "*/Cargo.toml?custom" {
  export const module: Uint8Array;
  export function init(options: { module: Uint8Array }): Promise<any>;
}
