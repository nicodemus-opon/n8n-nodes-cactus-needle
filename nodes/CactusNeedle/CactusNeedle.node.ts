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

/** Throw a guided operational error (message = what happened, description = how to fix it). */
function fail(node: INode, message: string, description?: string): never {
	throw new NodeOperationError(node, message, description ? { description } : {});
}

async function doFetch(
	node: INode,
	url: string,
	options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<{ status: number; json: unknown }> {
	const timeoutMs = sanitizeTimeout(options.timeoutMs);
	let res: Response;
	try {
		res = await fetch(url, {
			method: options.method ?? 'GET',
			headers: options.headers,
			body: options.body,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
			fail(
				node,
				`Request to ${url} timed out after ${timeoutMs}ms`,
				'The first request after a cold start can be slow. Raise ‘Request Timeout’ in the Cactus Needle API credential and try again',
			);
		}
		const msg = error instanceof Error ? error.message : String(error);
		fail(
			node,
			`Request to ${url} failed: ${msg}`,
			'Check that the playground server is running and reachable from n8n (local dev: http://localhost:7860, Coolify in-stack: http://needle3:7860)',
		);
	}
	const text = await res.text();
	let json: unknown = text;
	try {
		json = text ? JSON.parse(text) : {};
	} catch {
		// keep raw text; shape validation below will reject it
	}
	return { status: res.status, json };
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

function parseToolsInput(node: INode, raw: unknown): unknown[] | string {
	// n8n's `json` param type may hand us an already-parsed value.
	if (Array.isArray(raw)) return raw;
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
			JSON.parse(parsed);
		} catch {
			fail(node, 'Tools string is not valid JSON inside', 'Pass an array directly, or a JSON-encoded string of an array');
		}
		return parsed;
	}
	if (Array.isArray(parsed)) return parsed;
	fail(node, 'Tools must be an array of tool schemas (got a non-array JSON value)');
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

function validateSamples(node: INode, raw: unknown): number {
	const n = Number(raw);
	if (!Number.isFinite(n)) fail(node, 'Samples must be a number', 'Set ‘Samples’ between 1 and 2000');
	const v = Math.floor(n);
	if (v < 1 || v > 2000) fail(node, `Samples must be between 1 and 2000 (got ${String(raw)})`);
	return v;
}

export class CactusNeedle implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Cactus Needle',
		name: 'cactusNeedle',
		icon: { light: 'file:../../icons/cactus.svg', dark: 'file:../../icons/cactus.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Call a Cactus Needle 3 tool-calling server (cactus-docker playground API)',
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
				options: [{ name: 'Get Active Model', value: 'get', description: 'Show the active weights name', action: 'Get active model' }],
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
						description: 'Whether to return a simplified version of the response instead of the raw data. On: one row per function call. Off: the raw /complete body.',
					},
				],
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
				required: true,
				displayOptions: { show: { resource: ['training'], operation: ['finetune'] } },
				default: '',
				description: 'OpenRouter key (sk-or-…) used to synthesize training data. Sent as api_key to POST /finetune.',
			},
			{
				displayName: 'Samples',
				name: 'samples',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 2000 },
				displayOptions: { show: { resource: ['training'], operation: ['finetune'] } },
				default: 200,
				description: 'How many synthetic samples to generate (1–2000)',
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

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'toolCalling' && operation === 'complete') {
					const query = validateQuery(node, this.getNodeParameter('query', i) as string);
					const toolsRaw = this.getNodeParameter('toolsJson', i);
					const opts = this.getNodeParameter('completeOptions', i, {}) as {
						failOnEmpty?: boolean;
						minConfidence?: number;
						simplify?: boolean;
					};
					const tools = parseToolsInput(node, toolsRaw);
					const { status, json } = await doFetch(node, joinUrl(baseUrl, '/complete'), {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ tools, query }),
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
					if (opts.minConfidence && typeof body.confidence === 'number' && body.confidence < opts.minConfidence) {
						throw new NodeOperationError(
							node,
							`Needle confidence ${body.confidence} is below the minimum of ${opts.minConfidence}`,
							{
								itemIndex: i,
								description: 'Lower ‘Minimum Confidence’, rephrase the query with more evidence for the arguments, or route low-confidence turns to a human / cloud fallback',
							},
						);
					}
					const simplify = opts.simplify !== false;
					if (!simplify) {
						returnData.push({ json: body as unknown as IDataObject, pairedItem: { item: i } });
					} else if (calls.length === 0) {
						returnData.push({
							json: {
								name: null,
								arguments: {},
								type: body.type ?? 'call',
								function_calls: [],
								reasoning: body.reasoning ?? null,
								confidence: body.confidence ?? null,
								success: body.success ?? true,
								empty: true,
								_full: body,
							} as unknown as IDataObject,
							pairedItem: { item: i },
						});
					} else {
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
									_full: body,
								} as unknown as IDataObject,
								pairedItem: { item: i },
							});
						}
					}
					continue;
				}

				if (resource === 'conversation' && operation === 'reset') {
					const { status, json } = await doFetch(node, joinUrl(baseUrl, '/reset'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeoutMs });
					if (status >= 400) throw new NodeOperationError(node, `Needle /reset failed with HTTP ${status}`, { itemIndex: i });
					assertNoServerError(node, json, '/reset');
					returnData.push({ json: json as IDataObject, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'model' && operation === 'get') {
					const { status, json } = await doFetch(node, joinUrl(baseUrl, '/model'), { method: 'GET', timeoutMs });
					if (status >= 400) throw new NodeOperationError(node, `Needle /model failed with HTTP ${status}`, { itemIndex: i });
					assertNoServerError(node, json, '/model');
					returnData.push({ json: json as IDataObject, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'training' && operation === 'finetuneStatus') {
					const { status, json } = await doFetch(node, joinUrl(baseUrl, '/finetune/status'), { method: 'GET', timeoutMs });
					if (status >= 400) throw new NodeOperationError(node, `Needle /finetune/status failed with HTTP ${status}`, { itemIndex: i });
					assertNoServerError(node, json, '/finetune/status');
					returnData.push({ json: json as IDataObject, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'training' && operation === 'finetune') {
					const toolsRaw = this.getNodeParameter('toolsJson', i);
					const apiKey = String((this.getNodeParameter('finetuneApiKey', i) as string) ?? '').trim();
					if (!apiKey) {
						throw new NodeOperationError(node, 'OpenRouter API key must not be empty (the server would reject it)', {
							itemIndex: i,
							description: 'Paste an OpenRouter key (sk-or-…) into the ‘OpenRouter API Key’ field. The key is only used to synthesize training data',
						});
					}
					const samples = validateSamples(node, this.getNodeParameter('samples', i, 200));
					const tools = parseToolsInput(node, toolsRaw);
					const { status, json } = await doFetch(node, joinUrl(baseUrl, '/finetune'), {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ tools, api_key: apiKey, samples }),
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
