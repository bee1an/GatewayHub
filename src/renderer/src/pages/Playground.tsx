import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { usePolling } from '../hooks/usePolling'
import { Button } from '../components/ui/Button'
import { Select } from '../components/ui/Select'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { useToast } from '../components/ui/ToastContext'
import {
  type ChatMessage,
  makeId,
  prepareHistory,
  sliceBeforeMessage,
  flattenMessages
} from './playgroundUtils'

type ApiKeyEntry = {
  id: string
  key: string
  name: string
  createdAt: number
  lastUsedAt?: number
  expiresAt?: number
  scopes?: string[]
}

type ProviderStatus = {
  name: string
  providerType: string
  displayName?: string
  enabled: boolean
  configured: boolean
  status: string
  models: string[]
}

type GatewayStatus = {
  server: { running: boolean; url: string; host: string; port: number; apiKeys: ApiKeyEntry[] }
  providers: ProviderStatus[]
}

type ProviderModel = {
  id: string
  provider: string
  ownedBy?: string
  description?: string
}

export default function Playground(): React.JSX.Element {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [searchParams] = useSearchParams()
  const providerSlug = searchParams.get('provider') ?? null

  const { data: status } = usePolling<GatewayStatus>(() => window.api.gateway.status(), 5000, [
    'gateway',
    'status'
  ])
  const [models, setModels] = useState<ProviderModel[]>([])

  // Refetch models whenever the gateway running state flips. Same pattern as
  // the old Dashboard QuickTest had.
  useEffect(() => {
    window.api.gateway
      .listModels()
      .then((m: ProviderModel[]) => setModels(m ?? []))
      .catch(() => setModels([]))
  }, [status?.server.running])

  // eslint-disable-next-line react-hooks/purity
  const now = useMemo(() => Date.now(), [])
  const validKeys = (status?.server.apiKeys ?? []).filter((k) => !k.expiresAt || k.expiresAt > now)

  // User-selected model/key (null = fall back to derived default). We never
  // seed these via effects — the default is derived during render from the
  // current models list + ?provider= query.
  const [modelId, setModelId] = useState<string | null>(null)
  const [keyId, setKeyId] = useState<string | null>(null)

  const queryDefault = providerSlug ? models.find((m) => m.ownedBy === providerSlug) : undefined
  const effectiveModel =
    (modelId && models.find((m) => m.id === modelId)) || queryDefault || models[0]
  const effectiveKey = (keyId && validKeys.find((k) => k.id === keyId)) || validKeys[0]

  const [stream, setStream] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const running = status?.server.running ?? false
  const disabledReason: string | null = !running
    ? t('playground.startFirst')
    : validKeys.length === 0
      ? t('playground.noKey')
      : models.length === 0
        ? t('playground.noModel')
        : null

  const messagesRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = messagesRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  async function sendMessages(history: ChatMessage[]): Promise<void> {
    if (!effectiveKey || !effectiveModel || !status?.server.url) return
    setSending(true)
    // Insert a pending assistant placeholder so the user gets immediate
    // feedback (the typing dots) while the gateway processes the request.
    const placeholderId = makeId()
    setMessages([...history, { id: placeholderId, role: 'assistant', content: '', pending: true }])
    try {
      const result = await window.api.gateway.testRequest({
        url: status.server.url,
        apiKey: effectiveKey.key,
        model: effectiveModel.id,
        messages: flattenMessages(history),
        stream
      })
      if (!result.ok) {
        throw new Error(
          `${result.status} ${result.statusText}${result.body ? ` — ${result.body}` : ''}`
        )
      }
      const body = result.body || t('playground.responseEmpty')
      setMessages((prev) =>
        prev.map((m) => (m.id === placeholderId ? { ...m, content: body, pending: false } : m))
      )
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === placeholderId ? { ...m, content: '', pending: false, error: msg } : m
        )
      )
      toast(t('playground.requestFailed'), 'error')
    } finally {
      setSending(false)
    }
  }

  function handleSend(): void {
    const text = input.trim()
    if (!text || disabledReason || sending) return
    const newHistory = prepareHistory(messages, text)
    setInput('')
    void sendMessages(newHistory)
  }

  function handleRetry(failedId: string): void {
    // 丢弃失败的 assistant 回复及其之后的内容,保留之前的对话历史再重发。
    const history = sliceBeforeMessage(messages, failedId)
    setMessages(history)
    void sendMessages(history)
  }

  function handleClear(): void {
    setMessages([])
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // ⌘/Ctrl + Enter sends. Plain Enter inserts a newline (default behavior).
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  const keyOptions = validKeys.map((k) => ({ value: k.id, label: k.name || k.key.slice(0, 12) }))
  const modelOptions = models.map((m) => ({ value: m.id, label: m.id }))

  return (
    <div className="flex flex-col gap-4 animate-fade-in min-h-[calc(100vh-2.5rem-1.25rem)]">
      <div>
        <h1 className="text-[19px] font-[650] text-porcelain tracking-[-0.3px]">
          {t('playground.title')}
        </h1>
        <p className="mt-1 text-[11px] font-mono text-fog">{t('playground.desc')}</p>
      </div>

      {/* ── toolbar ───────────────────────────────────────── */}
      <div className="card px-4 py-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 min-w-[180px] flex-1">
          <span className="label">{t('playground.model')}</span>
          <Select
            value={effectiveModel?.id ?? ''}
            onValueChange={setModelId}
            options={modelOptions}
            placeholder={t('playground.noModel')}
            disabled={models.length === 0}
            mono
          />
        </div>
        <div className="flex flex-col gap-1 min-w-[180px] flex-1">
          <span className="label">{t('playground.apiKey')}</span>
          <Select
            value={effectiveKey?.id ?? ''}
            onValueChange={setKeyId}
            options={keyOptions}
            placeholder={t('playground.noKey')}
            disabled={validKeys.length === 0}
            mono
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="label">&nbsp;</span>
          <SegmentedControl
            value={stream ? 'on' : 'off'}
            onValueChange={(v) => setStream(v === 'on')}
            items={[
              { value: 'on', label: t('playground.stream') },
              { value: 'off', label: t('playground.noStream') }
            ]}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="label">&nbsp;</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            disabled={messages.length === 0}
            icon={<span className="i-ph-eraser text-[13px]" aria-hidden="true" />}
          >
            {t('playground.clear')}
          </Button>
        </div>
      </div>

      {/* ── messages ──────────────────────────────────────── */}
      <div
        ref={messagesRef}
        className="card flex-1 min-h-[320px] overflow-y-auto px-4 py-4 flex flex-col gap-3"
      >
        {messages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[12px] text-fog">{t('playground.emptyHint')}</p>
          </div>
        ) : (
          messages.map((m) => (
            <MessageBubble key={m.id} message={m} onRetry={() => handleRetry(m.id)} />
          ))
        )}
      </div>

      {/* ── input ─────────────────────────────────────────── */}
      <div className="card px-3 py-3 flex flex-col gap-2">
        {disabledReason && <span className="text-[11px] text-warning px-1">{disabledReason}</span>}
        <div className="relative">
          <textarea
            className="input-base w-full min-h-[80px] max-h-[200px] resize-none font-[400] pr-12 pb-2"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('playground.inputPlaceholder')}
            disabled={!!disabledReason}
          />
          <Button
            className="absolute bottom-2.5 right-2.5"
            variant="primary"
            size="sm"
            iconOnly
            loading={sending}
            disabled={!!disabledReason || !input.trim()}
            onClick={handleSend}
            icon={<span className="i-ph-paper-plane-tilt text-[14px]" aria-hidden="true" />}
            aria-label={sending ? t('playground.sending') : t('playground.send')}
          />
        </div>
        <span className="text-[10px] text-fog font-mono px-1">
          {effectiveModel?.id ?? '—'} · {stream ? 'stream' : 'non-stream'} ·{' '}
          {t('playground.sendHint')}
        </span>
      </div>
    </div>
  )
}

function MessageBubble({
  message,
  onRetry
}: {
  message: ChatMessage
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation()

  if (message.role === 'user') {
    return (
      <div className="self-end max-w-[80%] bg-charcoal/60 text-porcelain rounded-[var(--radius-md)] px-3 py-2 text-[13px] whitespace-pre-wrap break-words">
        {message.content}
      </div>
    )
  }

  // Assistant bubble: pending → typing dots, error → red box + retry,
  // otherwise the markdown-rendered response.
  return (
    <div className="self-start max-w-[92%] card-nested text-[13px] text-porcelain/90">
      {message.pending ? (
        <TypingDots />
      ) : message.error ? (
        <div className="flex flex-col gap-2">
          <pre className="text-[11px] text-red font-mono whitespace-pre-wrap break-all">
            {message.error}
          </pre>
          <Button
            variant="ghost"
            size="xs"
            onClick={onRetry}
            icon={<span className="i-ph-arrow-clockwise text-[12px]" aria-hidden="true" />}
          >
            {t('playground.retry')}
          </Button>
        </div>
      ) : (
        <MarkdownView source={message.content} />
      )}
    </div>
  )
}

function TypingDots(): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 py-1" aria-label="thinking">
      <span className="w-1.5 h-1.5 rounded-full bg-storm animate-pulse [animation-delay:0ms]" />
      <span className="w-1.5 h-1.5 rounded-full bg-storm animate-pulse [animation-delay:150ms]" />
      <span className="w-1.5 h-1.5 rounded-full bg-storm animate-pulse [animation-delay:300ms]" />
    </div>
  )
}

function MarkdownView({ source }: { source: string }): React.JSX.Element {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-1.5 leading-[1.55]">{children}</p>,
          h1: ({ children }) => (
            <h1 className="my-2 text-[15px] font-[590] text-porcelain">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="my-2 text-[14px] font-[590] text-porcelain">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="my-1.5 text-[13px] font-[590] text-porcelain">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="my-1.5 text-[13px] font-[590] text-porcelain">{children}</h4>
          ),
          ul: ({ children }) => <ul className="my-1.5 pl-5 list-disc">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 pl-5 list-decimal">{children}</ol>,
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-aether underline hover:text-aether/80"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 pl-2.5 border-l-2 border-charcoal text-porcelain/75">
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            // 行内代码无 className(class 属性里不带 language-xxx),
            // 围栏代码块有 className(如 "language-ts")。据此区分两者。
            if (!className) {
              return (
                <code className="bg-charcoal/70 px-1 py-0.5 rounded text-[12px] font-mono">
                  {children}
                </code>
              )
            }
            return <code className={className}>{children}</code>
          },
          pre: ({ children }) => (
            <pre className="my-2 bg-pitch border border-charcoal rounded-[var(--radius-sm)] p-2.5 overflow-auto text-[12px] font-mono">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-auto">
              <table className="border-collapse border border-charcoal text-[12px]">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-charcoal px-2 py-1 bg-charcoal/40 text-left font-[590]">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-charcoal px-2 py-1 align-top">{children}</td>
          ),
          hr: () => <hr className="my-3 border-charcoal/60" />
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}
