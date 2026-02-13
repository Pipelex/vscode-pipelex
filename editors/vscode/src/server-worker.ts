import {
  BrowserMessageReader,
  BrowserMessageWriter,
} from "vscode-languageserver-protocol/browser";

import { PipelexLsp, RpcMessage } from "@pipelex/lsp";

const worker: Worker = self as any;

const writer = new BrowserMessageWriter(worker);
const reader = new BrowserMessageReader(worker);

let pipelex: PipelexLsp;

reader.listen(async message => {
  if (!pipelex) {
    pipelex = await PipelexLsp.initialize(
      {
        cwd: () => "/",
        envVar: () => "",
        findConfigFile: () => undefined,
        glob: () => [],
        isAbsolute: () => true,
        now: () => new Date(),
        readFile: () => Promise.reject("not implemented"),
        writeFile: () => Promise.reject("not implemented"),
        stderr: async (bytes: Uint8Array) => {
          console.log(new TextDecoder().decode(bytes));
          return bytes.length;
        },
        stdErrAtty: () => false,
        stdin: () => Promise.reject("not implemented"),
        stdout: async (bytes: Uint8Array) => {
          console.log(new TextDecoder().decode(bytes));
          return bytes.length;
        },
        urlToFilePath: (url: string) => url.slice("file://".length),
      },
      {
        onMessage(message) {
          writer.write(message);
        },
      }
    );
  }

  pipelex.send(message as RpcMessage);
});
