import { randomUUID } from 'crypto'
import { GPT_WEB_CLIENT_VERSION, GPT_WEB_USER_AGENT, DEFAULT_GPT_WEB_BASE_URL } from './constants'

export interface ProofOfWorkChallenge {
  seed: string
  difficulty: string
}

const CLIENT_RELEASE = GPT_WEB_CLIENT_VERSION.replace(/^prod-/, '')

const SCRIPT_CANDIDATES = [
  `${DEFAULT_GPT_WEB_BASE_URL}/sentinel/sdk.js`,
  `https://chatgpt.com/c/${CLIENT_RELEASE}/_next/static/chunks/sentinel.js`
]
const DOCUMENT_KEYS = [
  'location',
  'cookie',
  'body',
  'head',
  'scripts',
  'documentElement',
  'querySelector',
  'createElement'
]
const WINDOW_KEYS = [
  'document',
  'navigator',
  'screen',
  'performance',
  'crypto',
  'location',
  'setTimeout',
  'clearTimeout',
  'TextEncoder',
  'btoa',
  'atob'
]
const SID = randomUUID()

export function buildRequirementsToken(): string {
  const startedAt = performance.now()
  const config = buildProofConfig(1, performance.now() - startedAt)
  return `gAAAAAC${encodeConfig(config)}`
}

export function solveProofOfWork(challenge: ProofOfWorkChallenge): string {
  const { seed, difficulty } = challenge
  const startedAt = performance.now()
  const config = buildProofConfig(0, 0)

  for (let nonce = 0; nonce < 500_000; nonce++) {
    config[3] = nonce
    config[9] = Math.round(performance.now() - startedAt)
    const answer = encodeConfig(config)
    if (hashChallenge(seed + answer).substring(0, difficulty.length) <= difficulty) {
      return `gAAAAAB${answer}~S`
    }
  }

  return buildGenerateFailToken()
}

function buildProofConfig(nonce: number, elapsedMs: number): unknown[] {
  return [
    2560,
    `${new Date()}`,
    4294705152,
    nonce,
    GPT_WEB_USER_AGENT,
    randomPick(SCRIPT_CANDIDATES),
    `c/${CLIENT_RELEASE}/_`,
    'en-US',
    'en-US,en',
    elapsedMs,
    'userAgentData∈[object NavigatorUAData]',
    randomPick(DOCUMENT_KEYS),
    randomPick(WINDOW_KEYS),
    performance.now(),
    SID,
    '',
    10,
    performance.timeOrigin,
    0,
    0,
    0,
    0,
    0,
    0,
    0
  ]
}

function randomPick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

function encodeConfig(config: unknown[]): string {
  return Buffer.from(JSON.stringify(config)).toString('base64')
}

function buildGenerateFailToken(): string {
  return `wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${Buffer.from('e').toString('base64')}`
}

function hashChallenge(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 2246822507) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, 3266489909) >>> 0
  hash ^= hash >>> 16
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function buildEmptyProofToken(): string {
  return `gAAAAAB${encodeConfig(buildProofConfig(0, 0))}~S`
}
