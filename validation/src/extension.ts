// // The module 'vscode' contains the VS Code extensibility API
// // Import the module and reference it with the alias vscode in your code below
// // const vscode = require('vscode');
// import { commands, window, ExtensionContext, Disposable } from 'vscode';
// import { spawn } from 'child_process';

// let disposables: Disposable[] = [];

// function activate(context: ExtensionContext) {
//   let disposable = commands.registerCommand("extensions.startVelaVet", () => {
//     const activeEditor = window.activeTextEditor;
//     if (activeEditor) {
//       const fileName = activeEditor.document.fileName;
//       const interval = 50000; // Interval in milliseconds (e.g., 50000 = 50 seconds)

//       runVelaVetPeriodically(fileName, interval);
//       window.showInformationMessage("Vela Vet started.");
//     } else {
//       window.showWarningMessage("No active editor found.");
//     }
//   });

//   context.subscriptions.push(disposable);
// }

// function runVelaVetCommand(fileName) {
//   const command = `vela def vet ${fileName}`;
//   const process = spawn(command, { shell: true });

//   process.stdout.on('data', (data) => {
//     console.log(data.toString());
//   });

//   process.stderr.on('data', (data) => {
//     console.error(data.toString());
//   });

//   process.on('close', (code) => {
//     console.log(`Child process exited with code ${code}`);
//   });
// }

// function runVelaVetPeriodically(fileName, interval) {
//   runVelaVetCommand(fileName);

//   setInterval(() => {
//     runVelaVetCommand(fileName);
//   }, interval);
// }

// // this method is called when your extension is deactivated
// export function deactivate() {
//   if (disposables) {
//     disposables.forEach(item => item.dispose());
//   }
//   disposables = [];
// }

// module.exports = {
//   activate,
//   deactivate
// };

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { ExtensionContext, languages, /*commands,*/ Disposable, workspace, window } from 'vscode';
// import { CodelensProvider } from './CodelensProvider';
import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed

let disposables: Disposable[] = [];

export function activate(context: ExtensionContext) {
  // const codelensProvider = new CodelensProvider();

  // languages.registerCodeLensProvider({ scheme: 'file', language: 'cue' }, codelensProvider);

  // commands.registerCommand("codelens-sample.enableCodeLens", () => {
  //   workspace.getConfiguration("codelens-sample").update("enableCodeLens", true, true);
  // });

  // commands.registerCommand("codelens-sample.disableCodeLens", () => {
  //   workspace.getConfiguration("codelens-sample").update("enableCodeLens", false, true);
  // });

  // commands.registerCommand("codelens-sample.codelensAction", (args: any) => {
  //   window.showInformationMessage(`CodeLens action clicked with args=${args}`);
  // });

  const collection = languages.createDiagnosticCollection('vela');
  if (window.activeTextEditor) {
    updateDiagnostics(window.activeTextEditor.document, collection);
  }

  context.subscriptions.push(workspace.onDidChangeTextDocument(documentEvent => {
    if (documentEvent) {
      updateDiagnostics(documentEvent.document, collection);
    }
  }));

  context.subscriptions.push(window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      updateDiagnostics(editor.document, collection);
    }
  }));
}

function runVelaVet(document: vscode.TextDocument): Promise<string> {
  const command = `vela def vet ${document.fileName}`;
  const process = spawn(command, { shell: true });

  return new Promise((resolve, reject) => {
    process.stdout.on('data', (data) => {
      resolve(data.toString());
    });

    process.stderr.on('data', (data) => {
      reject(data.toString());
    });
  });
}

function determineKeyword(problem: string): string | undefined {
  const regexes = [
    // Error: failed to parse CUE: /Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue: invalid type trit
    /invalid type (.+)/,
    // Error: failed to parse CUE: /Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue: invalid definition spec: json: cannot unmarshal number into Go struct field TraitDefinitionSpec.podDisruptive of type bool
    // Error: failed to parse CUE: /Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue: invalid definition spec: json: cannot unmarshal number into Go struct field WorkloadTypeDescriptor.workload.type of type string
    /field [\w\.]+\.+(\w+) of type/,
    // Error: failed to parse CUE: /Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue: test2.attributes.podDisruptive: reference "tru" not found
    /reference \"(.+)\" not found/,
    // Error: failed to parse CUE: /Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue: invalid definition spec: json: unknown field "podDisruptive"
    /unknown field "(.+)"/
  ];

  for (const regex of regexes) {
    const match = problem.match(regex);

    if (match && match.length > 0) {
      return match.slice(-1)[0];
    }
  }
}

function findRange(document: vscode.TextDocument, keyword: string | undefined): vscode.Range {
  if (!keyword) {
    return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(document.lineCount, 0));
  }

  const startOffset = document.getText().indexOf(keyword);
  const endOffset = startOffset + keyword.length;
  return new vscode.Range(
    document.positionAt(startOffset),
    document.positionAt(endOffset)
  );
}

function updateDiagnostics(document: vscode.TextDocument, collection: vscode.DiagnosticCollection): void {

  if (document && path.basename(document.uri.fsPath).endsWith('.cue')) {

    const velaPromise = runVelaVet(document);

    velaPromise.then((_good) => {
      collection.clear();
    }).catch((problem) => {

      console.debug(problem);

      const keyword = determineKeyword(problem);
      console.debug(keyword);

      const range = findRange(document, keyword);

      collection.set(document.uri, [{
        message: problem,
        range,
        severity: vscode.DiagnosticSeverity.Error,
        source: '',
        relatedInformation: [
          new vscode.DiagnosticRelatedInformation(new vscode.Location(document.uri, range), problem.split(':').slice(-1)[0])
        ]
      }]);
    });
  } else {
    collection.clear();
  }
}

// this method is called when your extension is deactivated
export function deactivate() {
  if (disposables) {
    disposables.forEach(item => item.dispose());
  }
  disposables = [];
}