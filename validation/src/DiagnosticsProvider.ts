import * as vscode from 'vscode';

export interface DiagnosticProvider {
    getCollection(): vscode.DiagnosticCollection

    resolveCommand(filepath: string): string

    findRange(document: vscode.TextDocument, problem: string): vscode.Range

    findCoreProblem(problem: string): string
}