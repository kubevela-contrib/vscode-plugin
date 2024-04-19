import * as vscode from 'vscode';

export interface DiagnosticProvider {
    getName(): string

    getCollection(): vscode.DiagnosticCollection

    runCommand(document: vscode.TextDocument): Promise<string>

    findRange(document: vscode.TextDocument, problem: string): vscode.Range

    findCoreProblem(problem: string): string

    activate(): void

    deactivate(): void
}