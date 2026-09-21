import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

const DEFAULT_TOOLS = JSON.stringify(
	[
		{
			name: 'set_lights',
			description: "Turn a room's lights on or off and set brightness",
			parameters: {
				type: 'object',
				properties: {
					room: { type: 'string', description: 'which room to control, e.g. living room' },
					on: { type: 'boolean' },
					brightness: { type: 'integer', minimum: 0, maximum: 100 },
				},
				required: ['room', 'on'],
			},
		},
		{
			name: 'get_weather',
			description: 'Get the current weather for a city',
			parameters: {
				type: 'object',
				properties: { city: { type: 'string' } },
				required: ['city'],
			},
		},
	],
	null,
	2,
);

type NeedleResponse = {
	type?: string;
	success?: boolean;
	error?: string | null;
	error_code?: string | null;
	function_calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
	suppressed_calls?: unknown[];
	reasoning?: string | null;
	confidence?: number | null;
	[key: string]: unknown;
};

type CompleteOptions = {
	failOnEmpty?: boolean;
	minConfidence?: number;
	simplify?: boolean;
	splitCalls?: boolean;
	includeRaw?: boolean;
};

/** Throw a guided operational error (message = what happened, description = how to fix it). */
function fail(node: INode, message: string, description?: string): never {
	throw new NodeOperationError(node, message, description ? { description } : {});
}

function sanitizeTimeout(raw: unknown): number {
	const n = Number(raw);
	if (!Number.isFinite(n)) return 120000;
	return Math.min(600000, Math.max(2000, Math.round(n)));
}

function validateBaseUrl(node: INode, raw: unknown): string {
	const s = String(raw ?? '').trim();
	if (!s) {
		fail(
			node,
			'Base URL is empty',
			'Open the Cactus Needle API credential and set Base URL to your playground server, e.g. http://localhost:7860',
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(s);
	} catch {
		fail(
			node,
			`Invalid Base URL "${s}"`,
			'Use a full http(s) URL, e.g. http://localhost:7860 (Coolify in-stack: http://needle3:7860)',
		);
	}
	if (parsed!.protocol !== 'http:' && parsed!.protocol !== 'https:') {
		fail(node, `Invalid Base URL "${s}"`, 'Only http(s) URLs are supported');
	}
	return s.replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl}${path}`;
}

/**
 * HTTP via n8n helpers so proxies, custom CA certs and timeout handling
 * behave like every other n8n node (native fetch bypasses all of that).
 */
async function doRequest(
	ctx: IExecuteFunctions,
	node: INode,
	url: string,
	options: {
		method?: 'GET' | 'POST';
		body?: IDataObject | Buffer;
		headers?: IDataObject;
		isBinaryUpload?: boolean;
		timeoutMs?: number;
	},
): Promise<{ status: number; json: unknown }> {
	const timeout = sanitizeTimeout(options.timeoutMs);
	try {
		const res = (await ctx.helpers.httpRequest({
			method: options.method ?? 'GET',
			url,
			headers: options.headers ?? { 'Content-Type': 'application/json' },
			body: options.body as IDataObject,
			json: !options.isBinaryUpload,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout,
		})) as unknown;
		if (res && typeof res === 'object' && 'statusCode' in (res as Record<string, unknown>)) {
			const full = res as { statusCode: number; body: unknown };
			return { status: full.statusCode, json: normalizeBody(full.body) };
		}
		return { status: 200, json: normalizeBody(res) };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (/timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED/i.test(msg)) {
			fail(
				node,
				`Request to ${url} timed out after ${timeout}ms`,
				'The first request after a cold start can be slow. Raise ‘Request Timeout’ in the Cactus Needle API credential and try again',
			);
		}
		if (error instanceof NodeOperationError) {
			// Re-wrap (rather than bare `throw error`) so the n8n error-class lint passes;
			// message, description and item context are preserved.
			throw new NodeOperationError(node, error.message, {
				description: (error as unknown as { description?: string }).description,
			});
		}
		fail(
			node,
			`Request to ${url} failed: ${msg}`,
			'Check that the playground server is running and reachable from n8n (local dev: http://localhost:7860, Coolify in-stack: http://needle3:7860)',
		);
	}
}

function normalizeBody(body: unknown): unknown {
	if (typeof body === 'string') {
		if (!body) return {};
		try {
			return JSON.parse(body);
		} catch {
			return body;
		}
	}
	return body ?? {};
}

/** The playground server returns HTTP 200 with {"error": "..."} on failures — surface that on every endpoint. */
function assertNoServerError(node: INode, json: unknown, endpoint: string): asserts json is Record<string, unknown> {
	if (typeof json !== 'object' || json === null || Array.isArray(json)) {
		fail(
			node,
			`Needle ${endpoint} returned a non-JSON response`,
			`Make sure Base URL points at the playground server itself (e.g. http://localhost:7860), not a proxy or the UI page at /`,
		);
	}
	const body = json as Record<string, unknown>;
	if (typeof body.error === 'string' && body.error) {
		fail(node, `Needle ${endpoint} error: ${body.error}`);
	}
	if (body.success === false) {
		const detail = typeof body.error_code === 'string' && body.error_code ? ` (${body.error_code})` : '';
		fail(node, `Needle ${endpoint} reported success=false${detail}`);
	}
}

function toolEntryName(entry: unknown): string | null {
	if (typeof entry !== 'object' || entry === null) return null;
	const obj = entry as Record<string, unknown>;
	if (typeof obj.name === 'string' && obj.name.trim()) return obj.name;
	const fn = (obj.function ?? obj.func) as Record<string, unknown> | undefined;
	if (obj.type === 'function' && fn && typeof fn.name === 'string' && fn.name.trim()) return fn.name;
	return null;
}

function parseToolsInput(node: INode, raw: unknown): unknown[] | string {
	// n8n's `json` param type may hand us an already-parsed value.
	if (Array.isArray(raw)) return validateToolArray(node, raw);
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) return [];
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			fail(
				node,
				'Tools is not valid JSON',
				'Paste an array of tool schemas into ‘Tools (JSON)’, e.g. [{"name":"get_weather","parameters":{"city":"string"}}]',
			);
		}
		return validateToolsShape(node, parsed);
	}
	if (typeof raw === 'object' && raw !== null) {
		// A single tool object instead of an array is a common mistake — reject with a hint.
		fail(node, 'Tools must be an array of tool schemas (you passed a single object)', 'Wrap the tool in [...], e.g. [{"name":"get_weather",...}]');
	}
	fail(node, 'Tools must be an array of tool schemas, or a JSON-encoded string of one');
}

function validateToolsShape(node: INode, parsed: unknown): unknown[] | string {
	if (typeof parsed === 'string') {
		// JSON-encoded string form: verify the inner payload parses too, otherwise
		// the server silently treats it as "no tools" and returns an empty call.
		try {
			const inner: unknown = JSON.parse(parsed);
			if (Array.isArray(inner)) validateToolArray(node, inner);
		} catch (error) {
			if (error instanceof NodeOperationError) {
				throw new NodeOperationError(node, error.message, {
					description: (error as unknown as { description?: string }).description,
				});
			}
			fail(node, 'Tools string is not valid JSON inside', 'Pass an array directly, or a JSON-encoded string of an array');
		}
		return parsed;
	}
	if (Array.isArray(parsed)) return validateToolArray(node, parsed);
	fail(node, 'Tools must be an array of tool schemas (got a non-array JSON value)');
}

function validateToolArray(node: INode, tools: unknown[]): unknown[] {
	for (let idx = 0; idx < tools.length; idx++) {
		const name = toolEntryName(tools[idx]);
		if (!name) {
			fail(
				node,
				`Tool at index ${idx} has no "name" (or OpenAI-style function.name)`,
				'Each tool needs a name, e.g. {"name":"get_weather",...} or {"type":"function","function":{"name":"get_weather",...}}',
			);
		}
	}
	return tools;
}

function validateQuery(node: INode, raw: unknown): string {
	const q = String(raw ?? '');
	if (!q.trim()) {
		fail(
			node,
			'Query must not be empty',
			'Type what you want the model to do in ‘Query’, e.g. dim the living room to 30. Off-topic input returns an empty refusal anyway',
		);
	}
	return q;
}

function validateMinConfidence(node: INode, raw: unknown): number {
	if (raw === undefined || raw === null || raw === '') return 0;
	const n = Number(raw);
	if (!Number.isFinite(n)) {
		fail(node, 'Minimum Confidence must be a number', 'Set ‘Minimum Confidence’ between 0 and 1, or leave it at 0 to disable');
	}
	if (n < 0 || n > 1) {
		fail(node, `Minimum Confidence must be between 0 and 1 (got ${String(raw)})`, 'Set a threshold like 0.8, or 0 to disable the check');
	}
	return n;
}

function validateSamples(node: INode, raw: unknown): number {
	const n = Number(raw);
	if (!Number.isFinite(n)) fail(node, 'Samples must be a number', 'Set ‘Samples’ between 1 and 2000');
	if (!Number.isInteger(n)) fail(node, `Samples must be a whole number (got ${String(raw)})`, 'Set ‘Samples’ to an integer between 1 and 2000');
	if (n < 1 || n > 2000) fail(node, `Samples must be between 1 and 2000 (got ${String(raw)})`);
	return n;
}

async function getUploadBuffer(
	ctx: IExecuteFunctions,
	node: INode,
	itemIndex: number,
	propertyName: string,
): Promise<{ buffer: Buffer; fileName: string }> {
	const prop = propertyName.trim() || 'data';
	const items = ctx.getInputData();
	const binary = (items[itemIndex] as unknown as { binary?: Record<string, { data?: string; fileName?: string }> }).binary?.[prop];
	const helpers = ctx.helpers as unknown as {
		getBinaryDataBuffer?: (index: number, prop: string) => Promise<Buffer>;
	};
	try {
		if (typeof helpers.getBinaryDataBuffer === 'function') {
			const buffer = await helpers.getBinaryDataBuffer(itemIndex, prop);
			const fileName = binary?.fileName || 'model.cact';
			return { buffer, fileName };
		}
	} catch (error) {
		fail(node, `Could not read binary property "${prop}": ${(error as Error).message}`, 'Put a Read Binary File node before this node and set ‘Binary Property’ to its output name');
	}
	if (binary?.data) {
		return { buffer: Buffer.from(binary.data, 'base64'), fileName: binary.fileName || 'model.cact' };
	}
	fail(
		node,
		`Binary property "${prop}" not found on input item ${itemIndex}`,
		'Put a Read Binary File node (or any node producing binary data) before Model > Load and set ‘Binary Property’ to its name',
	);
}

export class CactusNeedle implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Cactus Needle',
		name: 'cactusNeedle',
		icon: { light: 'file:../../icons/cactus.svg', dark: 'file:../../icons/cactus.dark.svg' },
		group: ['transform'],
		version: 2,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Query Cactus Needle models and manage training',
		defaults: { name: 'Cactus Needle' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'cactusNeedleApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Tool Calling', value: 'toolCalling' },
					{ name: 'Conversation', value: 'conversation' },
					{ name: 'Model', value: 'model' },
					{ name: 'Training', value: 'training' },
				],
				default: 'toolCalling',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['toolCalling'] } },
				options: [{ name: 'Complete', value: 'complete', description: 'Run a query against the tool-calling model', action: 'Complete tool call' }],
				default: 'complete',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['conversation'] } },
				options: [{ name: 'Reset', value: 'reset', description: 'Clear the server-side conversation state', action: 'Reset conversation' }],
				default: 'reset',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['model'] } },
				options: [
					{ name: 'Get Active Model', value: 'get', description: 'Show the active weights name', action: 'Get active model' },
					{ name: 'Load Weights File', value: 'load', description: 'Upload a .cact weights file and activate it', action: 'Load weights file' },
				],
				default: 'get',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['training'] } },
				options: [
					{ name: 'Start Fine-Tune', value: 'finetune', description: 'Start a fine-tuning run on a tool surface', action: 'Start fine tune' },
					{ name: 'Get Fine-Tune Status', value: 'finetuneStatus', description: 'Show the background fine-tuning progress', action: 'Get fine tune status' },
				],
				default: 'finetune',
			},
			// ---- complete ----
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				required: true,
				displayOptions: { show: { resource: ['toolCalling'], operation: ['complete'] } },
				default: '',
				placeholder: 'e.g. dim the living room to 30',
				description: 'Natural-language request. Off-topic input returns empty function_calls (a refusal, not free text).',
			},
			{
				displayName: 'Tools (JSON)',
				name: 'toolsJson',
				type: 'json',
				required: true,
				displayOptions: { show: { resource: ['toolCalling'], operation: ['complete'] } },
				default: DEFAULT_TOOLS,
				description:
					'Array of tool schemas. Accepts raw JSON-schema dicts, OpenAI-style {"type":"function","function":{...}} wrappers, or a JSON-encoded string. With 6+ tools only the top-5 are admitted per turn.',
			},
			{
				displayName: 'Options',
				name: 'completeOptions',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { resource: ['toolCalling'], operation: ['complete'] } },
				options: [
					{
						displayName: 'Fail on Empty Call (Refusal)',
						name: 'failOnEmpty',
						type: 'boolean',
						default: false,
						description: 'Whether to throw when function_calls is empty (off-topic input). Off by default so you can branch on it.',
					},
					{
						displayName: 'Include Raw Response',
						name: 'includeRaw',
						type: 'boolean',
						default: false,
						description: 'Whether to attach the raw /complete body as _full. Off by default to keep AI context small. Has no effect when Simplify is off.',
					},
					{
						displayName: 'Minimum Confidence',
						name: 'minConfidence',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
						default: 0,
						description: 'If set (> 0), throw when the returned confidence is below this threshold so you can escalate / re-ask',
					},
					{
						displayName: 'Simplify',
						name: 'simplify',
						type: 'boolean',
						default: true,
						description: 'Whether to return a simplified version of the response instead of the raw data. On: a single row (see Split Calls). Off: the raw /complete body.',
					},
					{
						displayName: 'Split One Row Per Call (Legacy)',
						name: 'splitCalls',
						type: 'boolean',
						default: false,
						description: 'Whether to emit one n8n item per function call (v1 behaviour). Off by default so AI Agents receive a single result. Has no effect when Simplify is off.',
					},
				],
			},
			// ---- model load ----
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				displayOptions: { show: { resource: ['model'], operation: ['load'] } },
				default: 'data',
				description: 'Name of the input binary property holding the .cact weights file (e.g. from Read Binary File)',
			},
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				displayOptions: { show: { resource: ['model'], operation: ['load'] } },
				default: '',
				placeholder: 'model.cact',
				description: 'Override the uploaded file name. Empty = keep the binary file name.',
			},
			// ---- training ----
			{
				displayName: 'Tools (JSON)',
				name: 'toolsJson',
				type: 'json',
				required: true,
				displayOptions: { show: { resource: ['training'], operation: ['finetune'] } },
				default: DEFAULT_TOOLS,
				description: 'Tool surface to fine-tune on',
			},
			{
				displayName: 'OpenRouter API Key',
				name: 'finetuneApiKey',
				type: 'string',
				typeOptions: { password: true },
				displayOptions: { show: { resource: ['training'], operation: ['finetune'] } },
				default: '',
				description:
					'Deprecated: prefer the credential’s OpenRouter API Key. Per-node value used only when the credential key is empty. Sent as api_key to POST /finetune.',
			},
			{
				displayName: 'Samples',
				name: 'samples',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 2000 },
				displayOptions: { show: { resource: ['training'], operation: ['finetune'] } },
				default: 200,
				description: 'How many synthetic samples to generate (1–2000, whole number)',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const node = this.getNode();
		const credentials = await this.getCredentials('cactusNeedleApi');
		const baseUrl = validateBaseUrl(node, credentials.baseUrl);
		const timeoutMs = sanitizeTimeout(credentials.timeoutMs);
		const credentialApiKey = String((credentials.openRouterApiKey as string | undefined) ?? '').trim();

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'toolCalling' && operation === 'complete') {
					const query = validateQuery(node, this.getNodeParameter('query', i) as string);
					const toolsRaw = this.getNodeParameter('toolsJson', i);
					const opts = this.getNodeParameter('completeOptions', i, {}) as CompleteOptions;
					const minConfidence = validateMinConfidence(node, opts.minConfidence);
					const tools = parseToolsInput(node, toolsRaw);
					const { status, json } = await doRequest(this, node, joinUrl(baseUrl, '/complete'), {
						method: 'POST',
						body: { tools, query } as unknown as IDataObject,
						timeoutMs,
					});
					if (status >= 400) {
						throw new NodeOperationError(node, `Needle /complete failed with HTTP ${status}: ${JSON.stringify(json)}`, { itemIndex: i });
					}
					assertNoServerError(node, json, '/complete');
					const body = json as NeedleResponse;
					const calls = body.function_calls ?? [];
					if (!Array.isArray(calls)) {
						throw new NodeOperationError(node, 'Needle /complete returned malformed function_calls (not an array)', { itemIndex: i });
					}
					for (const call of calls) {
						if (typeof call?.name !== 'string' || typeof call?.arguments !== 'object' || call?.arguments === null) {
							throw new NodeOperationError(node, `Needle /complete returned a malformed call: ${JSON.stringify(call)}`, { itemIndex: i });
						}
					}
					if (opts.failOnEmpty && calls.length === 0) {
						throw new NodeOperationError(node, 'Needle returned no function calls (off-topic input / refusal)', {
							itemIndex: i,
							description: 'The query did not match any tool. Adjust the query, add a matching tool, or turn off ‘Fail on Empty Call’ and branch on the empty output instead',
						});
					}
					if (minConfidence > 0 && typeof body.confidence === 'number' && body.confidence < minConfidence) {
						throw new NodeOperationError(
							node,
							`Needle confidence ${body.confidence} is below the minimum of ${minConfidence}`,
							{
								itemIndex: i,
								description: 'Lower ‘Minimum Confidence’, rephrase the query with more evidence for the arguments, or route low-confidence turns to a human / cloud fallback',
							},
						);
					}
					const simplify = opts.simplify !== false;
					const includeRaw = opts.includeRaw === true;
					if (!simplify) {
						returnData.push({ json: body as unknown as IDataObject, pairedItem: { item: i } });
					} else if (calls.length === 0) {
						returnData.push({
							json: {
								name: null,
								arguments: {},
								type: body.type ?? 'call',
								function_calls: [],
								callCount: 0,
								reasoning: body.reasoning ?? null,
								confidence: body.confidence ?? null,
								success: body.success ?? true,
								empty: true,
								...(includeRaw ? { _full: body } : {}),
							} as unknown as IDataObject,
							pairedItem: { item: i },
						});
					} else if (opts.splitCalls === true) {
						for (const call of calls) {
							returnData.push({
								json: {
									name: call.name,
									arguments: call.arguments,
									reasoning: body.reasoning ?? null,
									confidence: body.confidence ?? null,
									type: body.type ?? 'call',
									success: body.success ?? true,
									function_calls: calls,
									callCount: calls.length,
									empty: false,
									...(includeRaw ? { _full: body } : {}),
								} as unknown as IDataObject,
								pairedItem: { item: i },
							});
						}
					} else {
						const primary = calls[0];
						returnData.push({
							json: {
								name: primary.name,
								arguments: primary.arguments,
								reasoning: body.reasoning ?? null,
								confidence: body.confidence ?? null,
								type: body.type ?? 'call',
								success: body.success ?? true,
								function_calls: calls,
								callCount: calls.length,
								empty: false,
								...(includeRaw ? { _full: body } : {}),
							} as unknown as IDataObject,
							pairedItem: { item: i },
						});
					}
					continue;
				}

				if (resource === 'conversation' && operation === 'reset') {
					const { status, json } = await doRequest(this, node, joinUrl(baseUrl, '/reset'), {
						method: 'POST',
						body: {} as IDataObject,
						timeoutMs,
					});
					if (status >= 400) throw new NodeOperationError(node, `Needle /reset failed with HTTP ${status}`, { itemIndex: i });
					assertNoServerError(node, json, '/reset');
					returnData.push({ json: json as IDataObject, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'model' && operation === 'get') {
					const { status, json } = await doRequest(this, node, joinUrl(baseUrl, '/model'), { method: 'GET', timeoutMs });
					if (status >= 400) throw new NodeOperationError(node, `Needle /model failed with HTTP ${status}`, { itemIndex: i });
					assertNoServerError(node, json, '/model');
					returnData.push({ json: json as IDataObject, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'model' && operation === 'load') {
					const binaryPropertyName = String(this.getNodeParameter('binaryPropertyName', i, 'data') ?? 'data');
					const fileNameOverride = String(this.getNodeParameter('fileName', i, '') ?? '').trim();
					const { buffer, fileName } = await getUploadBuffer(this, node, i, binaryPropertyName);
					const uploadName = fileNameOverride || fileName;
					const { status, json } = await doRequest(this, node, joinUrl(baseUrl, '/load-model'), {
						method: 'POST',
						body: buffer,
						headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': uploadName } as unknown as IDataObject,
						isBinaryUpload: true,
						timeoutMs,
					});
					if (status >= 400) throw new NodeOperationError(node, `Needle /load-model failed with HTTP ${status}`, { itemIndex: i });
					assertNoServerError(node, json, '/load-model');
					returnData.push({ json: json as IDataObject, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'training' && operation === 'finetuneStatus') {
					const { status, json } = await doRequest(this, node, joinUrl(baseUrl, '/finetune/status'), { method: 'GET', timeoutMs });
					if (status >= 400) throw new NodeOperationError(node, `Needle /finetune/status failed with HTTP ${status}`, { itemIndex: i });
					assertNoServerError(node, json, '/finetune/status');
					returnData.push({ json: json as IDataObject, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'training' && operation === 'finetune') {
					const toolsRaw = this.getNodeParameter('toolsJson', i);
					const nodeKey = String((this.getNodeParameter('finetuneApiKey', i, '') as string) ?? '').trim();
					const apiKey = nodeKey || credentialApiKey;
					if (!apiKey) {
						throw new NodeOperationError(node, 'OpenRouter API key must not be empty (the server would reject it)', {
							itemIndex: i,
							description: 'Store the key in the Cactus Needle API credential (preferred) or paste an OpenRouter key (sk-or-…) into the ‘OpenRouter API Key’ field',
						});
					}
					const samples = validateSamples(node, this.getNodeParameter('samples', i, 200));
					const tools = parseToolsInput(node, toolsRaw);
					const { status, json } = await doRequest(this, node, joinUrl(baseUrl, '/finetune'), {
						method: 'POST',
						body: { tools, api_key: apiKey, samples } as unknown as IDataObject,
						timeoutMs,
					});
					if (status >= 400) throw new NodeOperationError(node, `Needle /finetune failed with HTTP ${status}`, { itemIndex: i });
					assertNoServerError(node, json, '/finetune');
					returnData.push({ json: json as IDataObject, pairedItem: { item: i } });
					continue;
				}

				throw new NodeOperationError(node, `Unsupported resource/operation: ${resource}/${operation}`, { itemIndex: i });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { ...items[i].json, error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof NodeOperationError) {
					// Re-wrap (rather than bare `throw error`) so the n8n error-class lint passes;
					// message, description and item context are preserved.
					throw new NodeOperationError(node, error.message, {
						itemIndex: i,
						description: (error as unknown as { description?: string }).description,
					});
				}
				throw new NodeOperationError(node, error instanceof Error ? error.message : String(error), { itemIndex: i });
			}
		}

		return [returnData];
	}
}
