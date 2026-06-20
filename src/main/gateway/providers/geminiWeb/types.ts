import type { GeminiWebAccountConfig, GeminiWebProviderSettings } from '../../types'

export interface GeminiWebRequestContext {
  account: GeminiWebAccountConfig
  settings: GeminiWebProviderSettings
  signal?: AbortSignal
}

export interface GeminiConversationInput {
  model: string
  prompt: string
  /** Threads multi-turn context: [cid, rid, rcid], all nullable. */
  metadata?: [string | null, string | null, string | null] | null
}

/**
 * The SNlM0e access token scraped from the Gemini /app HTML. Sent as the `at`
 * form field on StreamGenerate. Rotates per page load, so fetch fresh per turn.
 */
export type GeminiAccessToken = string

/**
 * Result of loading the Gemini /app page. `token` is the SNlM0e access token;
 * `email` is the signed-in account's email scraped from the WIZ global
 * (`oPEP7c`), when present.
 */
export interface GeminiWebSession {
  token: GeminiAccessToken
  email?: string
}

/**
 * Normalized generation event yielded by `streamGeminiConversation`. The
 * streaming parser converts Gemini's nested-array response into these.
 */
export type GeminiStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
