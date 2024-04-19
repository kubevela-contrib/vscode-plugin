import * as vscode from 'vscode';
import { DiagnosticProvider } from './DiagnosticsProvider';
import { spawn } from 'child_process';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'crypto';

export class CueVetDiagnosticsProvider implements DiagnosticProvider {
    private collection: vscode.DiagnosticCollection

    private mockContext = `#Context: {
        appRevision:    string
        appRevisionNum: int
        appName:        string
        name:           string
        namespace:      string
        output:         _
    }
    context: #Context`;

    private tempDirectory: string | undefined;

    constructor(collection: vscode.DiagnosticCollection) {
        this.collection = collection;
    }

    activate(): void {
        const directory = mkdtempSync(join(tmpdir(), 'vela-vscode-extension-'));
        console.log(directory);
        this.tempDirectory = directory;
    }

    deactivate(): void {
        if (this.tempDirectory) {
            rmSync(this.tempDirectory, { recursive: true });
        }
    }

    getName(): string {
        return 'cue';
    }

    isApplicable(document: vscode.TextDocument): boolean {
        return document.languageId === 'cue';
    }

    // This is a temporary measure to supress certain messages until all of the data injected by Kubevela controller can be mocked.
    // So far only context has been mocked.
    private shouldTemporarilyIgnore(problem: string): boolean {
        const regexes = [
            // some instances are incomplete; use the -c flag to show errors or suppress this message
            /some instances are incomplete/
        ];

        for (const regex of regexes) {
            const match = problem.match(regex);
            if (match !== null) {
                console.debug(`excluding ${match}`)
                return true;
            }
        }

        return false;
    }

    getCollection(): vscode.DiagnosticCollection {
        return this.collection;
    }

    runCommand(document: vscode.TextDocument): Promise<string> {
        // This aims to replicate the technique suggested in https://kubevela-docs.oss-cn-beijing.aliyuncs.com/docs/v1.0/platform-engineers/debug-test-cue#debug-cue-template
        const tempFileContent = document.getText().concat('\n').concat(this.mockContext);

        const fileName = `${randomBytes(16).toString("hex")}.cue`;

        writeFileSync(`${this.tempDirectory}/${fileName}`, tempFileContent);

        const command = `cue vet ${this.tempDirectory}/${fileName}`;

        const process = spawn(command, { shell: true });

        return new Promise((resolve, reject) => {
            process.stdout.on('data', (data) => {
                resolve(data.toString());
            });

            process.stderr.on('data', (data) => {
                const problem = data.toString();
                if (this.shouldTemporarilyIgnore(problem)) {
                    resolve(problem);
                } else {
                    reject(problem);
                }
            });
        });
    }

    findRange(document: vscode.TextDocument, problem: string): vscode.Range {
        // template.parameter.foo: reference "boo" not found:
        // ./Users/kuba/personal_repos/vscode-plugin/validation/examples/dummy.cue:32:8
        const lineAndColumn = problem.match(/(.+)\:(\d+)\:(\d+)\n?$/)?.slice(2).map(val => parseInt(val, 10) - 1);

        if (lineAndColumn?.length == 2) {
            let [line, column] = lineAndColumn;

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
    }
}