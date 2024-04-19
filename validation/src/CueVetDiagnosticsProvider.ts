import * as vscode from 'vscode';
import { DiagnosticProvider } from './DiagnosticsProvider';

export class CueVetDiagnosticsProvider implements DiagnosticProvider {
    private collection: vscode.DiagnosticCollection

    constructor(collection: vscode.DiagnosticCollection) {
        this.collection = collection;
    }

    getCollection(): vscode.DiagnosticCollection {
        return this.collection;
    }

    resolveCommand(filepath: string): string {
        return `cue vet ${filepath}`;
    }

    findRange(document: vscode.TextDocument, problem: string): vscode.Range {
        // template.parameter.foo: reference "boo" not found:
        // ./Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue:32:8
        const lineAndColumn = problem.match(/(.+)\:(\d+)\:(\d+)\n?$/)?.slice(2).map(val => parseInt(val, 10) - 1);

        if (lineAndColumn?.length == 2) {
            const [line, column] = lineAndColumn;
            return new vscode.Range(
                new vscode.Position(line, column),
                document.positionAt(document.offsetAt(new vscode.Position(line + 1, 0)) - 1)
            );
        } else {
            return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(document.lineCount, 0));
        }
    }

    findCoreProblem(problem: string): string {
        // template.parameter.foo: reference "boo" not found:
        // ./Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue:32:8
        // into
        // template.parameter.foo: reference "boo" not found
        return problem.replace(/\:\n(.+)/, '');
        // return problem
    }
}