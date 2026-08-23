import { streamText, type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { Agent, fetch as undiciFetch } from 'undici'
import { settings, AppSettings } from './settings'

// Keep AI requests on Node's fetch (proven to work in every environment) but
// disable undici's default 300s idle timeouts: deep-reasoning models like
// GPT-5 can spend minutes before emitting the first token
const longRunDispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0
})

const longRunFetch = ((input: Parameters<typeof undiciFetch>[0], init?: RequestInit) =>
  undiciFetch(input, {
    ...init,
    dispatcher: longRunDispatcher
  } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch

function createClient() {
  return createOpenAI({
    baseURL: settings.apiBaseURL,
    apiKey: settings.apiKey,
    fetch: longRunFetch
  })
}

// The system prompt is fully managed by the renderer (prompt scenes in the
// settings store) and synced here via updateAppSettings on app startup
function getSystemPrompt(extra?: string) {
  return [settings.customPrompt, extra].filter(Boolean).join('\n\n') || undefined
}

function getModel(_settings: AppSettings) {
  const fallbackModel = settings.apiBaseURL.includes('siliconflow')
    ? 'Qwen/Qwen3-VL-32B-Instruct'
    : 'gpt-5-mini'
  return _settings.model || fallbackModel
}

export function getSolutionStream(messages: ModelMessage[], abortSignal?: AbortSignal) {
  const openai = createClient()

  const { textStream } = streamText({
    model: openai.chat(getModel(settings)),
    system: getSystemPrompt(),
    messages,
    abortSignal,
    onError: (err) => {
      throw err.error ?? err
    }
  })
  return textStream
}

export function getFollowUpStream(
  messages: ModelMessage[],
  userQuestion: string,
  abortSignal?: AbortSignal
) {
  const openai = createClient()

  // Add the user's follow-up question to the conversation
  const updatedMessages: ModelMessage[] = [
    ...messages,
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: userQuestion
        }
      ]
    }
  ]

  const { textStream } = streamText({
    model: openai.chat(getModel(settings)),
    system: getSystemPrompt(),
    messages: updatedMessages,
    abortSignal,
    onError: (err) => {
      throw err.error ?? err
    }
  })
  return textStream
}

export function getGeneralStream(messages: ModelMessage[], abortSignal?: AbortSignal) {
  const openai = createClient()

  const { textStream } = streamText({
    model: openai.chat(getModel(settings)),
    system: getSystemPrompt(
      '注意：如果有多张截图，请结合所有截图内容进行完整分析，不要遗漏任何部分。'
    ),
    messages,
    abortSignal,
    onError: (err) => {
      throw err.error ?? err
    }
  })
  return textStream
}
