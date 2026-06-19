import { describe, expect, it } from 'vitest'
import { findQoderAuthWasmBase64Candidates } from '../wasm'

describe('qoder/wasm', () => {
  it('finds qoder auth wasm candidates without depending on minified variable names', () => {
    const wasm = 'AGFzbQEAAAABtest=='

    expect(findQoderAuthWasmBase64Candidates(`var dmC="${wasm}";var ByQ=`)).toEqual([wasm])
    expect(findQoderAuthWasmBase64Candidates(`var XpC="${wasm}";var WyQ=`)).toEqual([wasm])
  })
})
