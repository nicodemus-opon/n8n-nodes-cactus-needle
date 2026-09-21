import type {
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class CactusNeedleApi implements ICredentialType {
	name = 'cactusNeedleApi';
	displayName = 'Cactus Needle API';
	icon: Icon = { light: 'file:../icons/cactus.svg', dark: 'file:../icons/cactus.dark.svg' };
	documentationUrl = 'https://cactuscompute.com/blog/needle-python-docs';
	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://localhost:7860',
			placeholder: 'http://localhost:7860',
			description:
				'Base URL of your cactus-docker Needle playground server. Local dev: http://localhost:7860. In-stack on Coolify: http://needle3:7860',
		},
		{
			displayName: 'Request Timeout (ms)',
			name: 'timeoutMs',
			type: 'number',
			typeOptions: { minValue: 2000, maxValue: 600000 },
			default: 120000,
			description: 'How long to wait for /complete before failing. First request after a cold start can take a while',
		},
		{
			displayName: 'OpenRouter API Key',
			name: 'openRouterApiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Optional. Stored securely here instead of the workflow. Used to synthesize training data for Training > Start Fine-Tune (sk-or-…).',
		},
	];

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/model',
			method: 'GET',
		},
	};
}
