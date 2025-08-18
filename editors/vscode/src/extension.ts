import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { createClient } from "./client";
import { syncExtensionSchemas } from "./tomlValidation";
import { getOutput, showMessage } from "./util";
import { PipelexSemanticTokensProvider } from "./semanticTokenProvider";

export async function activate(context: vscode.ExtensionContext) {
  const schemaIndicator = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    0
  );

  schemaIndicator.text = "no schema selected";
  schemaIndicator.tooltip = "PML Schema";
  schemaIndicator.command = "pipelexToml.selectSchema";

  const c = await createClient(context);
  await c.start();

  if (vscode.window.activeTextEditor?.document.languageId === "pml") {
    schemaIndicator.show();
  }

  registerCommands(context, c);
  syncExtensionSchemas(context, c);

  // Register semantic token provider
  const semanticTokensProvider = new PipelexSemanticTokensProvider();
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: 'pml' },
      semanticTokensProvider,
      semanticTokensProvider.getSemanticTokensLegend()
    )
  );

  context.subscriptions.push(
    getOutput(),
    schemaIndicator,
    c.onNotification("taplo/messageWithOutput", async params =>
      showMessage(params, c)
    ),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor?.document.languageId === "pml") {
        schemaIndicator.show();
      } else {
        schemaIndicator.hide();
      }
    }),
    c.onNotification(
      "taplo/didChangeSchemaAssociation",
      async (params: {
        documentUri: string;
        schemaUri?: string;
        meta?: Record<string, any>;
      }) => {
        const currentDocumentUrl =
          vscode.window.activeTextEditor?.document.uri.toString();

        if (!currentDocumentUrl) {
          return;
        }

        if (params.documentUri === currentDocumentUrl) {
          schemaIndicator.text =
            params.meta?.name ?? params.schemaUri ?? "no schema selected";
        }
      }
    )
  );
}
