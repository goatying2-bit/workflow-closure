import {
  createProviderHttpAdapter,
  normalizeOptionalText,
  resolveHeadersOption,
  resolveOptionalNumberOption,
  resolveOptionalObjectOption,
  resolvePromptBuilder,
  resolveRequiredTextOption,
  resolveSystemInstruction,
  resolveTimeoutOption,
  resolveUrlOption
} from './provider-http-adapter.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_PATH = '/v1/messages';
const DEFAULT_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

export function createAnthropicMessagesAdapter(options = {}) {
  return createProviderHttpAdapter({
    provider: 'anthropic-messages',
    buildRequest({ input }) {
      const model = resolveRequiredTextOption(
        options.model,
        input,
        'Anthropic Messages adapter model is required.',
        'ANTHROPIC_MODEL'
      );
      const apiKey = resolveRequiredTextOption(
        options.apiKey,
        input,
        'Anthropic Messages adapter apiKey is required.',
        'ANTHROPIC_API_KEY'
      );
      const prompt = resolvePromptBuilder(options, input);
      const systemInstruction = resolveSystemInstruction(options, input);
      const url = resolveUrlOption({
        url: options.url,
        baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
        defaultPath: DEFAULT_PATH
      }, input, 'Anthropic Messages adapter baseUrl or url is required.');
      const anthropicVersion = normalizeOptionalText(options.anthropicVersion) || DEFAULT_VERSION;
      const temperature = resolveOptionalNumberOption(
        options.temperature,
        input,
        'Anthropic Messages adapter temperature must be a number.'
      );
      const extraBody = resolveOptionalObjectOption(
        options.extraBody,
        input,
        'Anthropic Messages adapter extraBody must be an object.'
      ) || {};
      const extraHeaders = resolveHeadersOption(
        options.headers,
        input,
        'Anthropic Messages adapter headers must be an object.'
      );
      const timeoutMs = resolveTimeoutOption(options.timeoutMs, input);
      const maxTokens = Math.max(
        1,
        Math.floor(
          resolveOptionalNumberOption(
            options.maxTokens,
            input,
            'Anthropic Messages adapter maxTokens must be a number.'
          ) ?? DEFAULT_MAX_TOKENS
        )
      );

      return {
        url,
        model,
        timeoutMs,
        fetchImpl: options.fetchImpl,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': anthropicVersion,
          ...extraHeaders
        },
        body: {
          ...extraBody,
          model,
          max_tokens: maxTokens,
          system: systemInstruction,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          ...(temperature == null ? {} : { temperature })
        },
        requestMeta: {
          model,
          maxTokens,
          anthropicVersion,
          timeoutMs,
          promptChars: prompt.length,
          hasSystemInstruction: true
        }
      };
    },
    extractCompletionText(responseJson) {
      const content = responseJson?.content;
      if (!Array.isArray(content)) {
        throw new Error('Anthropic Messages response content must be an array.');
      }

      const text = content
        .filter((item) => item && typeof item === 'object' && item.type === 'text')
        .map((item) => normalizeOptionalText(item.text))
        .filter(Boolean)
        .join('\n');

      if (!text) {
        throw new Error('Anthropic Messages response did not include a text content block.');
      }

      return text;
    }
  });
}
