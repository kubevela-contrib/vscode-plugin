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

function filterConfigMapNames(nameListOutput: string, prefix: string): string[] {
    return nameListOutput.trim().split('\n')
        .map(n => n.replace('configmap/', ''))
        .filter(n => n.startsWith(prefix))
        .filter(n => !/-v\d+$/.test(n));
}

function parseConfigMapSchema(name: string, prefix: string, cmJson: string): [string, JsonObject] | undefined {
    const cm = JSON.parse(cmJson);
    const type = name.replace(prefix, '');
    const data: Record<string, string> = cm.data ?? {};
    const schemaKey = Object.keys(data).find(k => k.endsWith('.json') || k === 'openapi-v3-json-schema');
    const schemaStr = schemaKey ? data[schemaKey] : Object.values(data)[0];
    if (schemaStr) {
        return [type, JSON.parse(schemaStr)];
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

interface SchemasByKind {
    components: Map<string, JsonObject>;
    traits: Map<string, JsonObject>;
    policies: Map<string, JsonObject>;
}

function injectAllOf(itemsNode: JsonObject | undefined, schemas: Map<string, JsonObject>): void {
    if (!itemsNode || schemas.size === 0) {
        return;
    }
    const allOf: JsonObject[] = [];
    for (const [type, schema] of schemas) {
        allOf.push({
            if: {
                properties: { type: { const: type } },
                required: ['type'],
            },
            then: {
                properties: { properties: schema },
            },
        });
    }
    itemsNode.allOf = allOf;
}

function composeSchema(appSchema: JsonObject, schemas: SchemasByKind): JsonObject {
    const spec = (appSchema as any).properties?.spec;
    const componentItems = spec?.properties?.components?.items;

    injectAllOf(componentItems, schemas.components);
    injectAllOf(componentItems?.properties?.traits?.items, schemas.traits);
    injectAllOf(spec?.properties?.policies?.items, schemas.policies);

    console.log('composeSchema: components allOf count:', schemas.components.size);
    console.log('composeSchema: traits allOf count:', schemas.traits.size);
    console.log('composeSchema: policies allOf count:', schemas.policies.size);
    console.log('composeSchema: traits items node exists:', !!componentItems?.properties?.traits?.items);
    console.log('composeSchema: policies items node exists:', !!spec?.properties?.policies?.items);

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

    private fetchConfigMapSchemasSync(nameListOutput: string, prefix: string): Map<string, JsonObject> {
        const schemas = new Map<string, JsonObject>();
        for (const name of filterConfigMapNames(nameListOutput, prefix)) {
            const entry = parseConfigMapSchema(name, prefix, kubectlSync(`get configmap ${name} -n vela-system -o json`));
            if (entry) {
                schemas.set(...entry);
            }
        }
        return schemas;
    }

    private async fetchConfigMapSchemasAsync(nameListOutput: string, prefix: string): Promise<Map<string, JsonObject>> {
        const schemas = new Map<string, JsonObject>();
        for (const name of filterConfigMapNames(nameListOutput, prefix)) {
            const entry = parseConfigMapSchema(name, prefix, await kubectlAsync(`get configmap ${name} -n vela-system -o json`));
            if (entry) {
                schemas.set(...entry);
            }
        }
        return schemas;
    }

    private fetchSchemaFromClusterSync(): void {
        const appSchema = parseApplicationSchema(kubectlSync('get crd applications.core.oam.dev -o json'));
        const cmNameList = kubectlSync('get configmaps -n vela-system -o name');
        const schemas: SchemasByKind = {
            components: this.fetchConfigMapSchemasSync(cmNameList, 'component-schema-'),
            traits: this.fetchConfigMapSchemasSync(cmNameList, 'trait-schema-'),
            policies: this.fetchConfigMapSchemasSync(cmNameList, 'policy-schema-'),
        };
        const composed = makeDefaultedFieldsOptional(composeSchema(appSchema, schemas)) as JsonObject;
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
                const cmNameList = await kubectlAsync('get configmaps -n vela-system -o name');
                const schemas: SchemasByKind = {
                    components: await this.fetchConfigMapSchemasAsync(cmNameList, 'component-schema-'),
                    traits: await this.fetchConfigMapSchemasAsync(cmNameList, 'trait-schema-'),
                    policies: await this.fetchConfigMapSchemasAsync(cmNameList, 'policy-schema-'),
                };
                const composed = makeDefaultedFieldsOptional(composeSchema(appSchema, schemas)) as JsonObject;
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
