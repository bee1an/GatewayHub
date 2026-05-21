import pc from 'picocolors'

export interface GlobalOptions {
  json: boolean
  color: boolean
}

let globalOptions: GlobalOptions = { json: false, color: true }

export function setGlobalOptions(opts: Partial<GlobalOptions>): void {
  globalOptions = { ...globalOptions, ...opts }
}

export function getGlobalOptions(): GlobalOptions {
  return globalOptions
}

export function isJsonMode(): boolean {
  return globalOptions.json
}

function shouldColor(): boolean {
  if (globalOptions.json) return false
  if (!globalOptions.color) return false
  if (process.env.NO_COLOR) return false
  return process.stdout.isTTY === true
}

export const colors = {
  bold: (s: string): string => (shouldColor() ? pc.bold(s) : s),
  dim: (s: string): string => (shouldColor() ? pc.dim(s) : s),
  green: (s: string): string => (shouldColor() ? pc.green(s) : s),
  red: (s: string): string => (shouldColor() ? pc.red(s) : s),
  yellow: (s: string): string => (shouldColor() ? pc.yellow(s) : s),
  cyan: (s: string): string => (shouldColor() ? pc.cyan(s) : s),
  gray: (s: string): string => (shouldColor() ? pc.gray(s) : s)
}

export function emitSuccess(data: unknown, humanRender?: () => void): void {
  if (globalOptions.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`)
    return
  }
  if (humanRender) humanRender()
  else if (data !== undefined) process.stdout.write(`${formatHumanValue(data)}\n`)
}

export function emitError(message: string, errorCode = 'CLI_ERROR'): void {
  if (globalOptions.json) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: errorCode, message } })}\n`)
    return
  }
  process.stderr.write(`${colors.red('error:')} ${message}\n`)
}

function formatHumanValue(data: unknown): string {
  if (typeof data === 'string') return data
  if (data === null || data === undefined) return ''
  return JSON.stringify(data, null, 2)
}

export interface TableColumn<T> {
  header: string
  get: (row: T) => string
  align?: 'left' | 'right'
}

export function renderTable<T>(rows: T[], columns: TableColumn<T>[]): string {
  if (rows.length === 0) return colors.dim('(empty)')

  const data = rows.map((row) => columns.map((col) => col.get(row) ?? ''))
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...data.map((r) => stripAnsi(r[i]).length))
  )

  const renderRow = (cells: string[], color = false): string =>
    cells
      .map((cell, i) => {
        const stripped = stripAnsi(cell)
        const pad = ' '.repeat(Math.max(0, widths[i] - stripped.length))
        const padded = columns[i].align === 'right' ? pad + cell : cell + pad
        return color ? colors.bold(padded) : padded
      })
      .join('  ')

  const headerRow = renderRow(
    columns.map((c) => c.header),
    true
  )
  const bodyRows = data.map((cells) => renderRow(cells))
  return [headerRow, ...bodyRows].join('\n')
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;]*m/g, '')
}
export function printTable<T>(rows: T[], columns: TableColumn<T>[]): void {
  process.stdout.write(`${renderTable(rows, columns)}\n`)
}
