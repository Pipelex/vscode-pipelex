import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { createClient } from "./client";
import { syncExtensionSchemas } from "./tomlValidation";
import { getOutput, showMessage } from "./util";
import { registerPipelexFeatures } from "./pipelex/pipelexExtension";

export async function activate(context: vscode.ExtensionContext) {
  const schemaIndicator = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    0
  );

  schemaIndicator.text = "no schema selected";
  schemaIndicator.tooltip = "TOML Schema";
  schemaIndicator.command = "pipelex.selectSchema";

  const c = await createClient(context);
  await c.start();

  // Send didOpen for already-open documents
  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === "toml" || document.languageId === "pml" || document.languageId === "cargoLock") {
      // Force the client to send didOpen notification
      await c.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: document.uri.toString(),
          languageId: document.languageId,
          version: document.version,
          text: document.getText()
        }
      });
    }
  }

  if (vscode.window.activeTextEditor?.document.languageId === "toml") {
    schemaIndicator.show();
  } else if (vscode.window.activeTextEditor?.document.languageId === "pml") {
    schemaIndicator.show();
  }

  registerCommands(context, c);
  syncExtensionSchemas(context, c);

  // Register Pipelex-specific features for PML
  registerPipelexFeatures(context);

  context.subscriptions.push(
    getOutput(),
    schemaIndicator,
    c.onNotification("taplo/messageWithOutput", async params =>
      showMessage(params, c)
    ),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor?.document.languageId === "toml" || editor?.document.languageId === "pml") {
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
