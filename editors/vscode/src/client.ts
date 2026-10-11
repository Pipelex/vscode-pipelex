import * as vscode from "vscode";
import * as node from "vscode-languageclient/node";
import * as browser from "vscode-languageclient/browser";
import which from "which";
import { getOutput } from "./util";
import { childProcessEnvOverrides } from "./pipelex/usageStats/childEnv";
import { recordFeatureUse } from "./pipelex/usageStats/recorder";
import { BaseLanguageClient, Middleware } from "vscode-languageclient";

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
}

class PipelexBrowserLanguageClient extends browser.LanguageClient {
  protected fillInitializeParams(params: any) {
    // @ts-ignore - base signature is intentionally loose
    super.fillInitializeParams(params);
    params.capabilities ??= {};
    params.capabilities.general ??= {};
    params.capabilities.general.positionEncodings = ["utf-16"];
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
        env: serverEnvironment(),
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
        env: serverEnvironment(),
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

/**
 * The language server's environment: `pipelex.server.environment` on top of the
 * extension host's (the language client merges it into `process.env`), with usage
 * statistics off like every process the extension starts
 * (`pipelex/usageStats/childEnv.ts`).
 */
export function serverEnvironment(): Record<string, string> {
  const configured = vscode.workspace
    .getConfiguration()
    .get("pipelex.server.environment");
  const base =
    configured && typeof configured === "object"
      ? (configured as Record<string, string>)
      : {};
  return childProcessEnvOverrides({ ...base });
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

    // Formatting is one of the features the extension counts in its usage statistics.
    middleware: {
      provideDocumentFormattingEdits: (document, options, token, next) => {
        recordFeatureUse("format");
        return next(document, options, token);
      },
      provideDocumentRangeFormattingEdits: (document, range, options, token, next) => {
        recordFeatureUse("format");
        return next(document, range, options, token);
      },
    } as Middleware,

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
