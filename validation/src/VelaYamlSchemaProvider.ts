import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const SCHEMA_ID = 'vela-application';
const CACHE_FILENAME = 'vela-application-schema.json';

function getK8sContext(): string {
    try {
        return execSync('kubectl config current-context', { encoding: 'utf-8', timeout: 5_000 }).trim();
    } catch {
        return 'unknown';
    }
}

function buildSchemaUri(context: string): string {
    return `${SCHEMA_ID}://schema/KubeVela Application | Cluster ${context}`;
}

const OAM_API_VERSION = 'core.oam.dev/v1beta1';
const OAM_KIND = 'Application';

interface YamlExtensionApi {
    registerContributor(
        schema: string,
        requestSchema: (resource: string) => string | undefined,
        requestSchemaContent: (uri: string) => string | undefined,
        label?: string
    ): boolean;
}

function isVelaApplication(content: string): boolean {
    const lines = content.split('\n').slice(0, 10);
    let hasApiVersion = false;
    let hasKind = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) {
            continue;
        }
        if (trimmed === `apiVersion: ${OAM_API_VERSION}`) {
            hasApiVersion = true;
        }
        if (trimmed === `kind: ${OAM_KIND}`) {
            hasKind = true;
        }
    }

    return hasApiVersion && hasKind;
}

const KUBECTL_OPTS = { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 };

function kubectlSync(args: string): string {
    return execSync(`kubectl ${args}`, { encoding: 'utf-8', ...KUBECTL_OPTS });
}

async function kubectlAsync(args: string): Promise<string> {
    const { stdout } = await execAsync(`kubectl ${args}`, KUBECTL_OPTS);
    return stdout;
}

type JsonObject = Record<string, unknown>;

function parseApplicationSchema(crdJson: string): JsonObject {
    const crd = JSON.parse(crdJson);
    const versions = crd.spec.versions as Array<{ name: string; schema?: { openAPIV3Schema?: JsonObject } }>;
    const latest = versions[versions.length - 1];
    const openAPISchema = latest?.schema?.openAPIV3Schema;
    if (!openAPISchema) {
        throw new Error('No openAPIV3Schema found in CRD');
    }
    const props = (openAPISchema as any).properties;
    if (props) {
        delete props.status;
    }
    return openAPISchema;
}

function filterComponentConfigMapNames(nameListOutput: string): string[] {
    return nameListOutput.trim().split('\n')
        .map(n => n.replace('configmap/', ''))
        .filter(n => n.startsWith('component-schema-'))
        .filter(n => !/-v\d+$/.test(n));
}

function parseComponentSchema(name: string, cmJson: string): [string, JsonObject] | undefined {
    const cm = JSON.parse(cmJson);
    const componentType = name.replace('component-schema-', '');
    const data: Record<string, string> = cm.data ?? {};
    const schemaKey = Object.keys(data).find(k => k.endsWith('.json') || k === 'openapi-v3-json-schema');
    const schemaStr = schemaKey ? data[schemaKey] : Object.values(data)[0];
    if (schemaStr) {
        return [componentType, JSON.parse(schemaStr)];
    }
    return undefined;
}

function makeDefaultedFieldsOptional(schema: unknown): unknown {
    if (Array.isArray(schema)) {
        return schema.map(item => makeDefaultedFieldsOptional(item));
    }
    if (schema !== null && typeof schema === 'object') {
        const obj = schema as JsonObject;
        const result: JsonObject = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = makeDefaultedFieldsOptional(value);
        }
        const required = result['required'];
        const properties = result['properties'];
        if (Array.isArray(required) && properties && typeof properties === 'object') {
            const props = properties as JsonObject;
            result['required'] = required.filter(field => {
                const prop = props[field as string];
                return !(prop && typeof prop === 'object' && 'default' in (prop as JsonObject));
            });
            if ((result['required'] as unknown[]).length === 0) {
                delete result['required'];
            }
        }
        return result;
    }
    return schema;
}

function composeSchema(appSchema: JsonObject, componentSchemas: Map<string, JsonObject>): JsonObject {
    const spec = (appSchema as any).properties?.spec;
    const components = spec?.properties?.components;
    if (!components?.items) {
        return appSchema;
    }

    const allOf: JsonObject[] = [];
    for (const [componentType, schema] of componentSchemas) {
        allOf.push({
            if: {
                properties: { type: { const: componentType } },
                required: ['type'],
            },
            then: {
                properties: { properties: schema },
            },
        });
    }

    components.items = {
        ...components.items,
        allOf,
    };

    return appSchema;
}

export class VelaYamlSchemaProvider {
    private schemaContent: string | undefined;
    private refreshing = false;
    private cachePath: string;

    constructor(private storagePath: string) {
        this.cachePath = path.join(storagePath, CACHE_FILENAME);
        this.loadCache();
    }

    async register(): Promise<void> {
        const yamlExtension = vscode.extensions.getExtension<YamlExtensionApi>('redhat.vscode-yaml');
        if (!yamlExtension) {
            console.warn('YAML extension not found. Schema support disabled.');
            return;
        }

        const api = yamlExtension.isActive
            ? yamlExtension.exports
            : await yamlExtension.activate();

        if (!api || !api.registerContributor) {
            console.warn('YAML extension API not available.');
            return;
        }

        api.registerContributor(
            SCHEMA_ID,
            (resource) => this.requestSchema(resource),
            (uri) => this.requestSchemaContent(uri),
            'Vela Application'
        );
    }

    private loadCache(): void {
        try {
            if (fs.existsSync(this.cachePath)) {
                this.schemaContent = fs.readFileSync(this.cachePath, 'utf-8');
            }
        } catch (err) {
            console.warn('Failed to load schema cache:', err);
        }
    }

    private writeCache(content: string): void {
        try {
            fs.mkdirSync(this.storagePath, { recursive: true });
            fs.writeFileSync(this.cachePath, content, 'utf-8');
        } catch (err) {
            console.warn('Failed to write schema cache:', err);
        }
    }

    private fetchSchemaFromClusterSync(): void {
        const appSchema = parseApplicationSchema(kubectlSync('get crd applications.core.oam.dev -o json'));
        const cmNames = filterComponentConfigMapNames(kubectlSync('get configmaps -n vela-system -o name'));
        const componentSchemas = new Map<string, JsonObject>();
        for (const name of cmNames) {
            const entry = parseComponentSchema(name, kubectlSync(`get configmap ${name} -n vela-system -o json`));
            if (entry) {
                componentSchemas.set(...entry);
            }
        }
        const composed = makeDefaultedFieldsOptional(composeSchema(appSchema, componentSchemas)) as JsonObject;
        composed.title = `KubeVela Application | Cluster: ${getK8sContext()}`;
        this.schemaContent = JSON.stringify(composed);
        this.writeCache(this.schemaContent);
    }

    private refreshInBackground(): void {
        if (this.refreshing) {
            return;
        }
        this.refreshing = true;

        (async () => {
            try {
                const appSchema = parseApplicationSchema(await kubectlAsync('get crd applications.core.oam.dev -o json'));
                const cmNames = filterComponentConfigMapNames(await kubectlAsync('get configmaps -n vela-system -o name'));
                const componentSchemas = new Map<string, JsonObject>();
                for (const name of cmNames) {
                    const entry = parseComponentSchema(name, await kubectlAsync(`get configmap ${name} -n vela-system -o json`));
                    if (entry) {
                        componentSchemas.set(...entry);
                    }
                }
                const composed = makeDefaultedFieldsOptional(composeSchema(appSchema, componentSchemas)) as JsonObject;
                composed.title = `KubeVela Application | Cluster: ${getK8sContext()}`;
                this.schemaContent = JSON.stringify(composed);
                this.writeCache(this.schemaContent);
            } catch (err) {
                console.error('Failed to refresh schemas from cluster:', err);
            } finally {
                this.refreshing = false;
            }
        })();
    }

    private requestSchema(resource: string): string | undefined {
        const uri = vscode.Uri.parse(resource);
        if (uri.scheme !== 'file') {
            return undefined;
        }

        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === resource);
        const content = doc
            ? doc.getText()
            : fs.readFileSync(uri.fsPath, 'utf-8');

        if (isVelaApplication(content)) {
            return buildSchemaUri(getK8sContext());
        }

        return undefined;
    }

    private requestSchemaContent(uri: string): string | undefined {
        if (!uri.startsWith(`${SCHEMA_ID}://`)) {
            return undefined;
        }

        if (!this.schemaContent) {
            try {
                this.fetchSchemaFromClusterSync();
            } catch (err) {
                console.error('Failed to fetch schemas from cluster:', err);
                return undefined;
            }
        } else {
            this.refreshInBackground();
        }

        return this.schemaContent;
    }
}
