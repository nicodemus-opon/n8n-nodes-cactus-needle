// Integration + build test for n8n-nodes-cactus-needle.
// Requires the cactus-needle-docker server on http://localhost:7860.
const assert = require('assert');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.env.CACTUS_BASE_URL || 'http://localhost:7860';
const ROOT = path.join(__dirname, '..');

function loadFixtureTools() {
	const vendored = path.join(ROOT, 'test', 'fixtures', 'tools.example.json');
	if (fs.existsSync(vendored)) return JSON.parse(fs.readFileSync(vendored, 'utf8'));
	const legacy = path.join(ROOT, '..', 'cactus-needle-docker', 'tools.example.json');
	return JSON.parse(fs.readFileSync(legacy, 'utf8'));
}

async function post(p, body) {
	const res = await fetch(`${BASE}${p}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	assert.ok(res.ok, `${p} HTTP ${res.status}`);
	return res.json();
}
async function get(p) {
	const res = await fetch(`${BASE}${p}`);
	assert.ok(res.ok, `${p} HTTP ${res.status}`);
	return res.json();
}

async function liveTests() {
	console.log(`[live] GET /model @ ${BASE}`);
	const model = await get('/model');
	console.log('  model =', JSON.stringify(model));
	assert.ok(typeof model.name === 'string', 'model.name string');

	console.log('[live] POST /complete (tools.example.json query)');
	const tools = loadFixtureTools();
	const out = await post('/complete', tools);
	console.log('  complete =', JSON.stringify(out).slice(0, 500));
	assert.ok(Array.isArray(out.function_calls), 'function_calls array');
	assert.ok(out.confidence === null || typeof out.confidence === 'number', 'confidence number or null');
	assert.ok('reasoning' in out, 'reasoning present');

	console.log('[live] POST /reset');
	const reset = await post('/reset', {});
	assert.strictEqual(reset.ok, true, 'reset ok');

	console.log('[live] POST /complete off-topic -> empty calls (refusal)');
	const refusal = await post('/complete', { tools: tools.tools, query: 'explain quantum entanglement in detail' });
	console.log('  refusal =', JSON.stringify(refusal).slice(0, 300));
	assert.ok(Array.isArray(refusal.function_calls), 'refusal function_calls array');
}

function buildCheck() {
	console.log('[build] npx tsc --noEmit');
	execSync('npx -y tsc --noEmit', { cwd: ROOT, stdio: 'inherit' });
	console.log('[build] tsc ok — running full build');
	execSync('npx -y tsc', { cwd: ROOT, stdio: 'inherit' });
	const nodeJs = path.join(ROOT, 'dist', 'nodes', 'CactusNeedle', 'CactusNeedle.node.js');
	const credJs = path.join(ROOT, 'dist', 'credentials', 'CactusNeedleApi.credentials.js');
	assert.ok(fs.existsSync(nodeJs), 'compiled node exists');
	assert.ok(fs.existsSync(credJs), 'compiled credential exists');
	console.log('[build] dist ok');
	return nodeJs;
}

function mockExecute(nodeModulePath, params) {
	const mod = require(nodeModulePath);
	const NodeClass = mod.CactusNeedle;
	const node = new NodeClass();
	const items = [{ json: {} }];
	const httpRequest = async (opts) => {
		const url = opts.url;
		const method = opts.method ?? 'GET';
		const res = await fetch(url, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		});
		const text = await res.text();
		let body;
		try {
			body = text ? JSON.parse(text) : {};
		} catch {
			body = text;
		}
		if (opts.returnFullResponse) return { statusCode: res.status, body, headers: {} };
		return body;
	};
	const ctx = {
		getInputData: () => items,
		getNodeParameter: (name, _idx, fallback) => (name in params ? params[name] : fallback),
		getCredentials: async () => ({ baseUrl: BASE, timeoutMs: 120000 }),
		getNode: () => ({ name: 'Cactus Needle test' }),
		continueOnFail: () => false,
		helpers: { httpRequest },
	};
	return node.execute.call(ctx);
}

async function nodeTests(nodeJs) {
	console.log('[node] compiled CactusNeedle.execute — complete');
	const tools = loadFixtureTools();
	const [rows] = await mockExecute(nodeJs, {
		resource: 'toolCalling',
		operation: 'complete',
		query: tools.query,
		toolsJson: JSON.stringify(tools.tools),
		completeOptions: { simplify: true },
	});
	console.log('  rows =', JSON.stringify(rows).slice(0, 500));
	assert.ok(rows.length >= 1, '>=1 row');
	assert.ok(rows[0].json.name, 'row has call name');

	console.log('[node] reset');
	const [resetRows] = await mockExecute(nodeJs, { resource: 'conversation', operation: 'reset' });
	assert.strictEqual(resetRows[0].json.ok, true);

	console.log('[node] get model');
	const [modelRows] = await mockExecute(nodeJs, { resource: 'model', operation: 'get' });
	assert.ok(typeof modelRows[0].json.name === 'string');

	console.log('[node] finetune status (no key needed)');
	const [ftRows] = await mockExecute(nodeJs, { resource: 'training', operation: 'finetuneStatus' });
	assert.ok('running' in ftRows[0].json, 'status has running');
	console.log('  finetune status =', JSON.stringify(ftRows[0].json).slice(0, 300));
}

(async () => {
	try {
		await liveTests();
		const nodeJs = buildCheck();
		await nodeTests(nodeJs);
		console.log('\nALL TESTS PASSED');
	} catch (e) {
		console.error('\nTEST FAILED:', e && e.message ? e.message : e);
		process.exit(1);
	}
})();
