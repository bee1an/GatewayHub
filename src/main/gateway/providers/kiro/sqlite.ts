const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<unknown>

export async function importNodeSqlite(): Promise<typeof import('node:sqlite')> {
  const originalEmitWarning = process.emitWarning

  process.emitWarning = ((warning: string | Error, ...args: any[]) => {
    const message = typeof warning === 'string' ? warning : warning.message
    const type = typeof args[0] === 'string' ? args[0] : undefined
    if (type === 'ExperimentalWarning' && /SQLite/i.test(message)) return
    return originalEmitWarning.call(process, warning as any, ...args)
  }) as typeof process.emitWarning
  try {
    const sqlite = (await dynamicImport('node:sqlite')) as typeof import('node:sqlite')
    await new Promise((resolve) => setImmediate(resolve))
    return sqlite
  } finally {
    process.emitWarning = originalEmitWarning
  }
}
