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

const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_PATH = '/v1/chat/completions';

export function createOpenAIChatCompletionsAdapter(options = {}) {
  return createProviderHttpAdapter({
    provider: 'openai-chat-completions',
    buildRequest({ input }) {
      const model = resolveRequiredTextOption(
        options.model,
        input,
        'OpenAI Chat Completions adapter model is required.',
        'OPENAI_MODEL'
      );
      const apiKey = resolveRequiredTextOption(
        options.apiKey,
        input,
        'OpenAI Chat Completions adapter apiKey is required.',
        'OPENAI_API_KEY'
      );
      const prompt = resolvePromptBuilder(options, input);
      const systemInstruction = resolveSystemInstruction(options, input);
      const url = resolveUrlOption({
        url: options.url,
        baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
        defaultPath: DEFAULT_PATH
      }, input, 'OpenAI Chat Completions adapter baseUrl or url is required.');
      const temperature = resolveOptionalNumberOption(
        options.temperature,
        input,
        'OpenAI Chat Completions adapter temperature must be a number.'
      );
      const maxTokens = resolveOptionalNumberOption(
        options.maxTokens,
        input,
        'OpenAI Chat Completions adapter maxTokens must be a number.'
      );
      const maxCompletionTokens = resolveOptionalNumberOption(
        options.maxCompletionTokens,
        input,
        'OpenAI Chat Completions adapter maxCompletionTokens must be a number.'
      );
      const extraBody = resolveOptionalObjectOption(
        options.extraBody,
        input,
        'OpenAI Chat Completions adapter extraBody must be an object.'
      ) || {};
      const extraHeaders = resolveHeadersOption(
        options.headers,
        input,
        'OpenAI Chat Completions adapter headers must be an object.'
      );
      const timeoutMs = resolveTimeoutOption(options.timeoutMs, input);

      return {
        url,
        model,
        timeoutMs,
        fetchImpl: options.fetchImpl,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...extraHeaders
        },
        body: {
          ...extraBody,
          model,
          messages: [
            {
              role: 'system',
              content: systemInstruction
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          ...(temperature == null ? {} : { temperature }),
          ...(maxCompletionTokens == null ? {} : { max_completion_tokens: Math.max(1, Math.floor(maxCompletionTokens)) }),
          ...(maxCompletionTokens != null || maxTokens == null ? {} : { max_tokens: Math.max(1, Math.floor(maxTokens)) })
        },
        requestMeta: {
          model,
          timeoutMs,
          promptChars: prompt.length,
          hasSystemInstruction: true,
          maxTokens: maxCompletionTokens == null ? (maxTokens == null ? null : Math.max(1, Math.floor(maxTokens))) : null,
          maxCompletionTokens: maxCompletionTokens == null ? null : Math.max(1, Math.floor(maxCompletionTokens))
        }
      };
    },
    extractCompletionText(responseJson) {
      const choice = Array.isArray(responseJson?.choices) ? responseJson.choices[0] : null;
      const content = choice?.message?.content ?? choice?.text ?? null;

      if (typeof content === 'string') {
        const text = normalizeOptionalText(content);
        if (!text) {
          throw new Error('OpenAI Chat Completions response content was empty.');
        }
        return text;
      }

      if (Array.isArray(content)) {
        const text = content
          .map((item) => {
            if (typeof item === 'string') {
              return normalizeOptionalText(item);
            }
            if (item && typeof item === 'object' && item.type === 'text') {
              return normalizeOptionalText(item.text);
            }
            return null;
          })
          .filter(Boolean)
          .join('\n');

        if (!text) {
          throw new Error('OpenAI Chat Completions response content array did not include text.');
        }

        return text;
      }

      throw new Error('OpenAI Chat Completions response choices[0].message.content was missing.');
    }
  });
}
