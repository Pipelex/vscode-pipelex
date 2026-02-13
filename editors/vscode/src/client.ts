import * as vscode from "vscode";
import * as node from "vscode-languageclient/node";
import * as browser from "vscode-languageclient/browser";
import which from "which";
import { getOutput } from "./util";
import { BaseLanguageClient } from "vscode-languageclient";

export async function createClient(
  context: vscode.ExtensionContext
): Promise<BaseLanguageClient> {
  console.log(import.meta.env.BROWSER);

  if (import.meta.env.BROWSER) {
    return await createBrowserClient(context);
  } else {
    return await createNodeClient(context);
  }
}

// Ensure the client always advertises UTF-16 position encoding per LSP 3.17
class PipelexNodeLanguageClient extends node.LanguageClient {
  protected fillInitializeParams(params: any) {
    // Call base to populate defaults
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    // @ts-ignore - base signature is intentionally loose
    super.fillInitializeParams(params);
    params.capabilities ??= {};
    params.capabilities.general ??= {};
    // VS Code uses UTF-16 positions internally
    params.capabilities.general.positionEncodings = ["utf-16"];
  }

  protected handleInitializeResult(result: any): void {
    // Ensure capabilities exist and have positionEncoding
    if (!result.capabilities) {
      result.capabilities = {};
    }
    if (!result.capabilities.positionEncoding) {
      result.capabilities.positionEncoding = 'utf-16';
    }
    super.handleInitializeResult(result);
  }
}

class PipelexBrowserLanguageClient extends browser.LanguageClient {
  protected fillInitializeParams(params: any) {
    // @ts-ignore - base signature is intentionally loose
    super.fillInitializeParams(params);
    params.capabilities ??= {};
    params.capabilities.general ??= {};
    params.capabilities.general.positionEncodings = ["utf-16"];
  }

  protected handleInitializeResult(result: any): void {
    // Ensure capabilities exist and have positionEncoding
    if (!result.capabilities) {
      result.capabilities = {};
    }
    if (!result.capabilities.positionEncoding) {
      result.capabilities.positionEncoding = 'utf-16';
    }
    super.handleInitializeResult(result);
  }
}

async function createBrowserClient(context: vscode.ExtensionContext) {
  const serverMain = vscode.Uri.joinPath(
    context.extensionUri,
    "dist/server-worker.js"
  );
  const worker = new Worker(serverMain.toString(true));
  return new PipelexBrowserLanguageClient(
    "taplo-lsp",
    "Taplo LSP",
    await clientOpts(context),
    worker
  );
}

async function createNodeClient(context: vscode.ExtensionContext) {
  const out = getOutput();

  const bundled = !!vscode.workspace
    .getConfiguration()
    .get("pipelex.server.bundled");

  let serverOpts: node.ServerOptions;
  if (bundled) {
    const taploPath = vscode.Uri.joinPath(
      context.extensionUri,
      "dist/server.js"
    ).fsPath;

    const run: node.NodeModule = {
      module: taploPath,
      transport: node.TransportKind.ipc,
      options: {
        env:
          vscode.workspace
            .getConfiguration()
            .get("pipelex.server.environment") ?? undefined,
      },
    };

    serverOpts = {
      run,
      debug: run,
    };
  } else {
    const taploPath =
      vscode.workspace.getConfiguration().get("pipelex.server.path") ??
      which.sync("plxt", { nothrow: true }) ??
      which.sync("taplo", { nothrow: true });

    if (typeof taploPath !== "string") {
      out.appendLine("failed to locate language server");
      throw new Error("failed to locate language server");
    }

    let extraArgs = vscode.workspace
      .getConfiguration()
      .get("pipelex.server.extraArgs");

    if (!Array.isArray(extraArgs)) {
      extraArgs = [];
    }

    const args: string[] = (extraArgs as any[]).filter(
      a => typeof a === "string"
    );

    const run: node.Executable = {
      command: taploPath,
      args: ["lsp", "stdio", ...args],
      options: {
        env:
          vscode.workspace
            .getConfiguration()
            .get("pipelex.server.environment") ?? undefined,
      },
    };

    serverOpts = {
      run,
      debug: run,
    };
  }

  return new PipelexNodeLanguageClient(
    "pipelex",
    "Pipelex LSP",
    serverOpts,
    await clientOpts(context)
  );
}

async function clientOpts(context: vscode.ExtensionContext): Promise<any> {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  return {
    documentSelector: [
      { scheme: "file", language: "toml" },
      { scheme: "file", language: "mthds" },
      { scheme: "file", language: "cargoLock" },
    ],

    initializationOptions: {
      configurationSection: "pipelex",
      cachePath: context.globalStorageUri.fsPath,
    },

    synchronize: {
      // Synchronize the setting section 'pipelex' to the server
      configurationSection: 'pipelex',
      // Notify the server about file changes to '.toml' and '.mthds' files contained in the workspace
      fileEvents: [
        vscode.workspace.createFileSystemWatcher('**/*.toml'),
        vscode.workspace.createFileSystemWatcher('**/*.mthds')
      ]
    },
  };
}
