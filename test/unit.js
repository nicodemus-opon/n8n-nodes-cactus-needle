// Mocked unit tests: no server required. Exercises validation + v2 output shape
// by stubbing ctx.helpers.httpRequest.
// Run: node ./test/unit.js
const assert = require('assert');
const path = require('path');

const NODE = path.join(__dirname, '..', 'dist', 'nodes', 'CactusNeedle', 'CactusNeedle.node.js');

function loadNode() {
	delete require.cache[require.resolve(NODE)];
	return require(NODE).CactusNeedle;
}

const COMPLETE_OK = {
	type: 'call',
	success: true,
	function_calls: [
		{ name: 'set_lights', arguments: { room: 'living room', on: true, brightness: 30 } },
		{ name: 'get_weather', arguments: { city: 'Lagos' } },
	],
	reasoning: 'matched lights tool',
	confidence: 0.92,
};

function mockRun(NodeClass, { params, creds, httpImpl, items }) {
	const node = new NodeClass();
	const ctx = {
		getInputData: () => items || [{ json: {} }],
		getNodeParameter: (name, _idx, fallback) => (name in params ? params[name] : fallback),
		getCredentials: async () => creds || { baseUrl: 'http://localhost:7860', timeoutMs: 120000 },
		getNode: () => ({ name: 'unit-test' }),
		continueOnFail: () => false,
		helpers: { httpRequest: httpImpl || (async () => ({ statusCode: 200, body: COMPLETE_OK, headers: {} })) },
	};
	return node.execute.call(ctx);
}

async function expectThrow(fn, match) {
	try {
		await fn();
	} catch (e) {
		if (match && !match.test(e.message)) throw new Error(`wrong error: ${e.message}`);
		return e.message;
	}
	throw new Error('expected throw, got success');
}

(async () => {
	const NodeClass = loadNode();

	// 1. default: single row, no _full, callCount
	{
		const [rows] = await mockRun(NodeClass, {
			params: { resource: 'toolCalling', operation: 'complete', query: 'dim lights', toolsJson: '[{"name":"set_lights"}]', completeOptions: {} },
		});
		assert.strictEqual(rows.length, 1, 'single row by default');
		assert.strictEqual(rows[0].json.name, 'set_lights');
		assert.strictEqual(rows[0].json.callCount, 2);
		assert.ok(!('_full' in rows[0].json), 'no _full by default');
		console.log('PASS default single-row output');
	}

	// 2. splitCalls legacy fan-out
	{
		const [rows] = await mockRun(NodeClass, {
			params: { resource: 'toolCalling', operation: 'complete', query: 'dim lights', toolsJson: '[{"name":"set_lights"}]', completeOptions: { splitCalls: true } },
		});
		assert.strictEqual(rows.length, 2, 'two rows with splitCalls');
		assert.strictEqual(rows[1].json.name, 'get_weather');
		console.log('PASS splitCalls fan-out');
	}

	// 3. includeRaw attaches _full
	{
		const [rows] = await mockRun(NodeClass, {
			params: { resource: 'toolCalling', operation: 'complete', query: 'dim lights', toolsJson: '[{"name":"set_lights"}]', completeOptions: { includeRaw: true } },
		});
		assert.ok(rows[0].json._full, '_full present when requested');
		console.log('PASS includeRaw');
	}

	// 4. empty refusal shape
	{
		const [rows] = await mockRun(NodeClass, {
			params: { resource: 'toolCalling', operation: 'complete', query: 'quantum?', toolsJson: '[{"name":"set_lights"}]', completeOptions: {} },
			httpImpl: async () => ({ statusCode: 200, body: { type: 'call', success: true, function_calls: [], reasoning: null, confidence: null }, headers: {} }),
		});
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].json.empty, true);
		assert.strictEqual(rows[0].json.callCount, 0);
		console.log('PASS empty refusal');
	}

	// 5. validation: bad confidence, bad samples, nameless tool, empty query
	{
		await expectThrow(
			() => mockRun(NodeClass, { params: { resource: 'toolCalling', operation: 'complete', query: 'hi', toolsJson: '[{"name":"x"}]', completeOptions: { minConfidence: 2 } } }),
			/between 0 and 1/i,
		);
		await expectThrow(
			() => mockRun(NodeClass, { params: { resource: 'training', operation: 'finetune', toolsJson: '[{"name":"x"}]', finetuneApiKey: 'sk-or-k', samples: 2.5 } }),
			/whole number/i,
		);
		await expectThrow(
			() => mockRun(NodeClass, { params: { resource: 'toolCalling', operation: 'complete', query: 'hi', toolsJson: '[{"nodesc":1}]', completeOptions: {} } }),
			/no "name"/i,
		);
		await expectThrow(
			() => mockRun(NodeClass, { params: { resource: 'toolCalling', operation: 'complete', query: '  ', toolsJson: '[{"name":"x"}]', completeOptions: {} } }),
			/must not be empty/i,
		);
		console.log('PASS validation rejects bad input');
	}

	// 6. finetune key from credential fallback
	{
		const [rows] = await mockRun(NodeClass, {
			params: { resource: 'training', operation: 'finetune', toolsJson: '[{"name":"x"}]', finetuneApiKey: '', samples: 10 },
			creds: { baseUrl: 'http://localhost:7860', timeoutMs: 5000, openRouterApiKey: 'sk-or-from-cred' },
			httpImpl: async (opts) => {
				assert.ok(String(opts.body.api_key).includes('from-cred'), 'credential key used');
				return { statusCode: 200, body: { ok: true }, headers: {} };
			},
		});
		assert.strictEqual(rows[0].json.ok, true);
		console.log('PASS credential api-key fallback');
	}

	// 7. model load uploads binary with X-Filename
	{
		const buf = Buffer.from('fake-cact-bytes');
		const [rows] = await mockRun(NodeClass, {
			params: { resource: 'model', operation: 'load', binaryPropertyName: 'data', fileName: '' },
			items: [{ json: {}, binary: { data: { data: buf.toString('base64'), fileName: 'tuned.cact' } } }],
			httpImpl: async (opts) => {
				assert.ok(opts.url.endsWith('/load-model'), 'hits /load-model');
				assert.strictEqual(opts.headers['X-Filename'], 'tuned.cact');
				assert.ok(Buffer.isBuffer(opts.body), 'raw buffer body');
				return { statusCode: 200, body: { name: 'tuned.cact' }, headers: {} };
			},
		});
		assert.strictEqual(rows[0].json.name, 'tuned.cact');
		console.log('PASS model load binary upload');
	}

	console.log('\nALL UNIT TESTS PASSED');
})().catch((e) => {
	console.error('\nUNIT TEST FAILED:', e && e.message ? e.message : e);
	process.exit(1);
});
