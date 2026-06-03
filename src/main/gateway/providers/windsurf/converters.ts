import { extractText } from '../kiro/converters'
import type { WindsurfImageAttachment, WindsurfPromptPayload } from './cascade'

export function openAiToWindsurfPrompt(body: any): WindsurfPromptPayload {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const lines: string[] = []
  const images: WindsurfImageAttachment[] = []
  for (const msg of messages) {
    const role = msg?.role
    const text = extractText(msg?.content)
    images.push(...extractOpenAiImages(msg?.content))
    if (role === 'system' || role === 'developer') {
      if (text) lines.push(`System: ${text}`)
    } else if (role === 'assistant') {
      if (text) lines.push(`Assistant: ${text}`)
      appendOpenAiToolCalls(lines, msg)
    } else if (role === 'tool') {
      lines.push(`Tool result${msg.tool_call_id ? ` ${msg.tool_call_id}` : ''}: ${text}`)
    } else if (text) {
      lines.push(`User: ${text}`)
    }
  }
  appendImageNotes(lines, images)
  return { prompt: lines.join('\n\n'), images }
}

export function anthropicToWindsurfPrompt(body: any): WindsurfPromptPayload {
  const system = typeof body.system === 'string' ? body.system : extractText(body.system)
  const messages = Array.isArray(body.messages) ? body.messages : []
  const lines = system ? [`System: ${system}`] : []
  const images: WindsurfImageAttachment[] = []
  for (const msg of messages) {
    const role = msg?.role === 'assistant' ? 'Assistant' : 'User'
    const blocks = Array.isArray(msg?.content) ? msg.content : undefined
    if (!blocks) {
      const text = extractText(msg?.content)
      if (text) lines.push(`${role}: ${text}`)
      continue
    }
    images.push(...extractAnthropicImages(blocks))
    appendAnthropicBlocks(lines, role, blocks)
  }
  appendImageNotes(lines, images)
  return { prompt: lines.join('\n\n'), images }
}

function appendOpenAiToolCalls(lines: string[], msg: any): void {
  const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : []
  for (const call of toolCalls) {
    const name = call?.function?.name || call?.name || 'tool'
    const args = call?.function?.arguments || call?.arguments || '{}'
    lines.push(`Assistant tool call ${name}: ${args}`)
  }
}

function appendAnthropicBlocks(lines: string[], role: string, blocks: any[]): void {
  for (const block of blocks) {
    if (block?.type === 'text' && block.text) {
      lines.push(`${role}: ${block.text}`)
    } else if (block?.type === 'tool_use') {
      lines.push(
        `Assistant tool call ${block.name || 'tool'}: ${JSON.stringify(block.input || {})}`
      )
    } else if (block?.type === 'tool_result') {
      const content = typeof block.content === 'string' ? block.content : extractText(block.content)
      lines.push(`Tool result ${block.tool_use_id || ''}: ${content}`)
    }
  }
}

function extractOpenAiImages(content: any): WindsurfImageAttachment[] {
  if (!Array.isArray(content)) return []
  const images: WindsurfImageAttachment[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'image_url') {
      const url =
        typeof part.image_url === 'string'
          ? part.image_url
          : typeof part.image_url?.url === 'string'
            ? part.image_url.url
            : ''
      const parsed = dataUrlToImage(url)
      if (parsed) {
        images.push({ ...parsed, caption: imageCaption(part.detail, part.image_url?.detail) })
      } else if (url) {
        images.push({
          sourceUrl: url,
          caption: imageCaption(part.detail, part.image_url?.detail)
        })
      }
    } else if (part.type === 'input_image' || part.type === 'image') {
      const data = part.image_base64 || part.data || part.base64 || part.base64Data
      if (typeof data === 'string' && data.trim()) {
        images.push({
          base64Data: stripDataUrlPrefix(data),
          mimeType: part.mime_type || part.mimeType || 'image/png',
          caption: imageCaption(part.detail)
        })
      }
    }
  }
  return images
}

function extractAnthropicImages(blocks: any[]): WindsurfImageAttachment[] {
  const images: WindsurfImageAttachment[] = []
  for (const block of blocks) {
    if (block?.type !== 'image') continue
    const source = block.source || {}
    if (source.type === 'base64' && typeof source.data === 'string') {
      images.push({
        base64Data: stripDataUrlPrefix(source.data),
        mimeType: source.media_type || source.mediaType || 'image/png'
      })
    } else if (typeof source.url === 'string') {
      images.push({ sourceUrl: source.url })
    }
  }
  return images
}

function appendImageNotes(lines: string[], images: WindsurfImageAttachment[]): void {
  if (!images.length) return
  const nativeCount = images.filter((image) => image.base64Data).length
  const urlCount = images.length - nativeCount
  const parts = [`${images.length} image(s) attached`]
  if (nativeCount) parts.push(`${nativeCount} sent as native Cascade image data`)
  if (urlCount) parts.push(`${urlCount} URL-only image(s) referenced in text`)
  lines.push(`User image context: ${parts.join('; ')}.`)
  for (const [index, image] of images.entries()) {
    if (image.sourceUrl) lines.push(`Image ${index + 1} URL: ${image.sourceUrl}`)
    else if (image.caption) lines.push(`Image ${index + 1} caption: ${image.caption}`)
  }
}

function dataUrlToImage(
  value: string
): Pick<WindsurfImageAttachment, 'base64Data' | 'mimeType'> | null {
  const match = value.match(/^data:([^;,]+);base64,([\s\S]+)$/i)
  if (!match) return null
  return { mimeType: match[1], base64Data: match[2].trim() }
}

function stripDataUrlPrefix(value: string): string {
  return dataUrlToImage(value)?.base64Data || value.trim()
}

function imageCaption(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}
