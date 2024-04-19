import { ExtensionContext, languages, Disposable, workspace, window } from 'vscode';
import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

import { DiagnosticProvider } from './DiagnosticsProvider';
import { CueVetDiagnosticsProvider } from './CueVetDiagnosticsProvider';
import { VelaVetDiagnosticsProvider } from './VelaVetDiagnosticsProvider';

let disposables: Disposable[] = [];

function runCommand(command: string): Promise<string> {
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

async function updateDiagnostics(document: vscode.TextDocument, diagnosticProvider: DiagnosticProvider): Promise<void> {
  if (document && path.basename(document.uri.fsPath).endsWith('.cue')) {
    try {
      await runCommand(diagnosticProvider.resolveCommand(document.fileName));
      diagnosticProvider.getCollection().clear();
    } catch (problem) {
      console.debug(problem);

      const coreProblem = diagnosticProvider.findCoreProblem(problem as string);
      const range = diagnosticProvider.findRange(document, problem as string);

      diagnosticProvider.getCollection().set(document.uri, [{
        message: coreProblem,
        range,
        severity: vscode.DiagnosticSeverity.Error,
        source: '',
        relatedInformation: [
          new vscode.DiagnosticRelatedInformation(new vscode.Location(document.uri, range), coreProblem)
        ]
      }]);
    }
  } else {
    diagnosticProvider.getCollection().clear();
  }
}

export function activate(context: ExtensionContext) {
  const diagnosticProviders: DiagnosticProvider[] = [
    new VelaVetDiagnosticsProvider(languages.createDiagnosticCollection('vela vet')),
    new CueVetDiagnosticsProvider(languages.createDiagnosticCollection('cue vet'))
  ];


  if (window.activeTextEditor) {
    for (const provider of diagnosticProviders) {
      updateDiagnostics(window.activeTextEditor.document, provider);
    }
  }

  context.subscriptions.push(workspace.onDidChangeTextDocument(documentEvent => {
    if (documentEvent) {
      for (const provider of diagnosticProviders) {
        updateDiagnostics(documentEvent.document, provider);
      }
    }
  }));

  context.subscriptions.push(window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      for (const provider of diagnosticProviders) {
        updateDiagnostics(editor.document, provider);
      }
    }
  }));
}

// this method is called when your extension is deactivated
export function deactivate() {
  if (disposables) {
    disposables.forEach(item => item.dispose());
  }
  disposables = [];
}