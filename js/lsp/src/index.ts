import loadPipelex from "../../../crates/pipelex-wasm/Cargo.toml";
import { convertEnv, Environment, Lsp, prepareEnv } from "@taplo/core";

export interface RpcMessage {
  jsonrpc: "2.0";
  method?: string;
  id?: string | number;
  params?: any;
  result?: any;
  error?: any;
}

export interface LspInterface {
  /**
   * Handler for RPC messages set from the LSP server.
   */
  onMessage: (message: RpcMessage) => void;
}

export class PipelexLsp {
  private static pipelex: any | undefined;
  private static initializing: boolean = false;

  private constructor(private env: Environment, private lspInner: any) {
    if (!PipelexLsp.initializing) {
      throw new Error(
        `an instance of PipelexLsp can only be created by calling the "initialize" static method`
      );
    }
  }

  public static async initialize(
    env: Environment,
    lspInterface: LspInterface
  ): Promise<PipelexLsp> {
    if (typeof PipelexLsp.pipelex === "undefined") {
      PipelexLsp.pipelex = await loadPipelex();
    }
    PipelexLsp.pipelex.initialize();

    prepareEnv(env);

    PipelexLsp.initializing = true;
    const t = new PipelexLsp(
      env,
      PipelexLsp.pipelex.create_lsp(convertEnv(env), {
        js_on_message: lspInterface.onMessage,
      })
    );
    PipelexLsp.initializing = false;

    return t;
  }

  public send(message: RpcMessage) {
    this.lspInner.send(message);
  }

  public dispose() {
    this.lspInner.free();
  }
}
