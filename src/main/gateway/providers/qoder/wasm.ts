import { createRequire } from 'module'
import { access, readFile, realpath } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { QODER_CLI_COMPAT_VERSION, QODER_CLI_RUNTIME_CONFIG } from './constants'

export interface QoderWasmPreparedRequest {
  url: string
  headers: Record<string, string>
  body?: string
}

export interface QoderRuntimeAuthFields {
  encrypt_user_info?: string
  key?: string
}

const LEGACY_WASM_BASE64_PATTERN = /var dmC="([A-Za-z0-9+/=]+)";var ByQ=/
const WASM_BASE64_CANDIDATE_PATTERN =
  /\b(?:var|let|const)\s+[$A-Z_a-z][$\w]*="(AGFzbQE[A-Za-z0-9+/=]+)"/g
const DEFAULT_QODER_CLI_VERSION = QODER_CLI_COMPAT_VERSION
const nodeRequire = createRequire(__filename)
const runtimeCache = new Map<string, Promise<QoderAuthWasm>>()

export async function getQoderAuthWasm(qoderCliPath?: string): Promise<QoderAuthWasm> {
  const executable = await resolveQoderCliExecutable(qoderCliPath)
  let cached = runtimeCache.get(executable)
  if (!cached) {
    cached = QoderAuthWasm.fromExecutable(executable)
    runtimeCache.set(executable, cached)
  }
  return cached
}

async function resolveQoderCliExecutable(customPath?: string): Promise<string> {
  const candidates = [
    customPath,
    process.env.QODER_CLI_PATH,
    join(homedir(), '.local', 'bin', 'qodercli'),
    await versionedQoderCliPath().catch(() => undefined)
  ].filter((value): value is string => Boolean(value?.trim()))

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.R_OK)
      return await realpath(candidate)
    } catch {
      /* try the next known install location */
    }
  }
  throw new Error('Qoder legacy API requires the qodercli executable to extract Qoder auth WASM')
}

async function versionedQoderCliPath(): Promise<string | undefined> {
  const dir = join(homedir(), '.qoder', 'bin', 'qodercli')
  try {
    const version = (await readFile(join(dir, 'version.txt'), 'utf8')).trim()
    if (version) return join(dir, `qodercli-${version}`)
  } catch {
    /* fall back to the version bundled with the current Qoder CLI release */
  }
  return join(dir, `qodercli-${DEFAULT_QODER_CLI_VERSION}`)
}

export class QoderAuthWasm {
  private wasm!: Record<string, any>
  private cachedUint8Memory: Uint8Array | null = null
  private cachedDataView: DataView | null = null
  private readonly textEncoder = new TextEncoder()
  private readonly textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  private readonly heap: any[] = new Array(1024).fill(undefined)
  private heapNext = 0
  private wasmVectorLen = 0

  private constructor(private readonly bytes: Uint8Array) {
    this.textDecoder.decode()
    this.heap.push(undefined, null, true, false)
    this.heapNext = this.heap.length
  }

  static async fromExecutable(executable: string): Promise<QoderAuthWasm> {
    const binary = await readFile(executable)
    const runtime = new QoderAuthWasm(extractQoderAuthWasmBytes(binary))
    runtime.instantiate()
    return runtime
  }

  generateRuntimeAuthFields(inputJson: string): QoderRuntimeAuthFields {
    const output = this.stringResult((retptr, ptr, len) => {
      this.wasm.generate_runtime_auth_fields(retptr, ptr, len)
    }, inputJson)
    return parseJsonObject(output)
  }

  decryptServerResponse(text: string): string {
    return this.stringResult((retptr, ptr, len) => {
      this.wasm.decrypt_server_response(retptr, ptr, len)
    }, text)
  }

  createContext(options: {
    machineId: string
    cosyVersion?: string
    userInfoJson: string
    runtimeConfigJson?: string
  }): QoderWasmContext {
    const retptr = this.wasm.__wbindgen_add_to_stack_pointer(-16)
    try {
      const machinePtr = this.passStringToWasm(options.machineId)
      const machineLen = this.wasmVectorLen
      const versionPtr = this.passStringToWasm(options.cosyVersion || DEFAULT_QODER_CLI_VERSION)
      const versionLen = this.wasmVectorLen
      const userPtr = this.passStringToWasm(options.userInfoJson)
      const userLen = this.wasmVectorLen
      const runtimePtr = this.passStringToWasm(
        options.runtimeConfigJson ||
          JSON.stringify({
            ...QODER_CLI_RUNTIME_CONFIG
          })
      )
      const runtimeLen = this.wasmVectorLen
      this.wasm.qodercontext_new(
        retptr,
        machinePtr,
        machineLen,
        versionPtr,
        versionLen,
        userPtr,
        userLen,
        runtimePtr,
        runtimeLen
      )
      const view = this.dataView()
      const ptr = view.getInt32(retptr, true)
      const err = view.getInt32(retptr + 4, true)
      const flag = view.getInt32(retptr + 8, true)
      if (flag) throw this.takeObject(err)
      return new QoderWasmContext(this, ptr >>> 0)
    } finally {
      this.wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }

  freeContext(ptr: number): void {
    if (ptr) this.wasm.__wbg_qodercontext_free(ptr, 0)
  }

  freeRequest(ptr: number): void {
    if (ptr) this.wasm.__wbg_requestresult_free(ptr, 0)
  }

  prepareInferRequest(
    contextPtr: number,
    baseUrl: string,
    bodyJson: string,
    modelKey: string,
    modelSource: string
  ): QoderWasmPreparedRequest {
    const retptr = this.wasm.__wbindgen_add_to_stack_pointer(-16)
    let requestPtr = 0
    try {
      const basePtr = this.passStringToWasm(baseUrl)
      const baseLen = this.wasmVectorLen
      const bodyPtr = this.passStringToWasm(bodyJson)
      const bodyLen = this.wasmVectorLen
      const modelPtr = this.passStringToWasm(modelKey)
      const modelLen = this.wasmVectorLen
      const sourcePtr = this.passStringToWasm(modelSource)
      const sourceLen = this.wasmVectorLen
      this.wasm.qodercontext_prepareInferRequest(
        retptr,
        contextPtr,
        basePtr,
        baseLen,
        bodyPtr,
        bodyLen,
        modelPtr,
        modelLen,
        sourcePtr,
        sourceLen
      )
      const view = this.dataView()
      requestPtr = view.getInt32(retptr, true) >>> 0
      const err = view.getInt32(retptr + 4, true)
      const flag = view.getInt32(retptr + 8, true)
      if (flag) throw this.takeObject(err)
      return this.readRequestResult(requestPtr)
    } finally {
      this.wasm.__wbindgen_add_to_stack_pointer(16)
      if (requestPtr) this.freeRequest(requestPtr)
    }
  }

  private instantiate(): void {
    const imports = {
      './qoder_auth_wasm_bg.js': {
        __wbindgen_object_drop_ref: (idx: number) => {
          this.takeObject(idx)
        },
        __wbindgen_object_clone_ref: (idx: number) => this.addHeapObject(this.getObject(idx)),
        __wbg_set_08463b1df38a7e29: (target: number, key: number, value: number) =>
          this.addHeapObject(
            this.getObject(target).set(this.getObject(key), this.getObject(value))
          ),
        __wbg_getRandomValues_d49329ff89a07af1: (ptr: number, len: number) =>
          this.handleError(() => {
            globalThis.crypto.getRandomValues(
              new Uint8Array(this.wasm.memory.buffer, ptr >>> 0, len >>> 0)
            )
          }),
        __wbg_crypto_38df2bab126b63dc: (idx: number) =>
          this.addHeapObject(this.getObject(idx).crypto),
        __wbg_process_44c7a14e11e9f69e: (idx: number) =>
          this.addHeapObject(this.getObject(idx).process),
        __wbg_versions_276b2795b1c6a219: (idx: number) =>
          this.addHeapObject(this.getObject(idx).versions),
        __wbg_node_84ea875411254db1: (idx: number) => this.addHeapObject(this.getObject(idx).node),
        __wbg_require_b4edbdcf3e2a1ef0: () =>
          this.handleError(() => this.addHeapObject(nodeRequire)),
        __wbg_msCrypto_bd5a034af96bcba6: (idx: number) =>
          this.addHeapObject(this.getObject(idx).msCrypto),
        __wbg_getRandomValues_c44a50d8cfdaebeb: (cryptoIdx: number, arrayIdx: number) =>
          this.handleError(() => {
            this.getObject(cryptoIdx).getRandomValues(this.getObject(arrayIdx))
          }),
        __wbg_randomFillSync_6c25eac9869eb53c: (cryptoIdx: number, arrayIdx: number) =>
          this.handleError(() => {
            this.getObject(cryptoIdx).randomFillSync(this.takeObject(arrayIdx))
          }),
        __wbg_call_d578befcc3145dee: (fnIdx: number, thisIdx: number, argIdx: number) =>
          this.handleError(() =>
            this.addHeapObject(
              this.getObject(fnIdx).call(this.getObject(thisIdx), this.getObject(argIdx))
            )
          ),
        __wbg_new_with_length_9cedd08484b73942: (len: number) =>
          this.addHeapObject(new Uint8Array(len >>> 0)),
        __wbg_length_0c32cb8543c8e4c8: (idx: number) => this.getObject(idx).length,
        __wbg_prototypesetcall_3e05eb9545565046: (ptr: number, len: number, valueIdx: number) => {
          Uint8Array.prototype.set.call(
            this.uint8Memory().subarray(ptr >>> 0, (ptr >>> 0) + len),
            this.getObject(valueIdx)
          )
        },
        __wbg_subarray_0f98d3fb634508ad: (idx: number, start: number, end: number) =>
          this.addHeapObject(this.getObject(idx).subarray(start >>> 0, end >>> 0)),
        __wbg_new_99cabae501c0a8a0: () => this.addHeapObject(new Map()),
        __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
        __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () =>
          typeof globalThis === 'undefined' ? 0 : this.addHeapObject(globalThis),
        __wbg_static_accessor_SELF_24f78b6d23f286ea: () =>
          typeof self === 'undefined' ? 0 : this.addHeapObject(self),
        __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () =>
          typeof global === 'undefined' ? 0 : this.addHeapObject(global),
        __wbg_static_accessor_WINDOW_59fd959c540fe405: () =>
          typeof window === 'undefined' ? 0 : this.addHeapObject(window),
        __wbg___wbindgen_throw_81fc77679af83bc6: (ptr: number, len: number) => {
          throw new Error(this.getString(ptr, len))
        },
        __wbg_Error_2e59b1b37a9a34c3: (ptr: number, len: number) =>
          this.addHeapObject(new Error(this.getString(ptr, len))),
        __wbg___wbindgen_is_object_40c5a80572e8f9d3: (idx: number) => {
          const value = this.getObject(idx)
          return typeof value === 'object' && value !== null
        },
        __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (idx: number) =>
          typeof this.getObject(idx) === 'string',
        __wbg___wbindgen_is_function_49868bde5eb1e745: (idx: number) =>
          typeof this.getObject(idx) === 'function',
        __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (idx: number) =>
          this.getObject(idx) === undefined,
        __wbindgen_cast_0000000000000001: (ptr: number, len: number) =>
          this.addHeapObject(this.uint8Memory().subarray(ptr >>> 0, (ptr >>> 0) + len)),
        __wbindgen_cast_0000000000000002: (ptr: number, len: number) =>
          this.addHeapObject(this.getString(ptr, len))
      }
    }
    const moduleBytes = this.bytes.buffer.slice(
      this.bytes.byteOffset,
      this.bytes.byteOffset + this.bytes.byteLength
    ) as ArrayBuffer
    const instance = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes), imports)
    this.wasm = instance.exports as Record<string, any>
  }

  private readRequestResult(requestPtr: number): QoderWasmPreparedRequest {
    const headersObject = this.takeObject(this.wasm.requestresult_headers(requestPtr))
    const headers: Record<string, string> = {}
    if (!headersObject || typeof headersObject.forEach !== 'function') {
      throw new Error('Qoder WASM returned invalid request headers')
    }
    headersObject.forEach((value: unknown, key: unknown) => {
      headers[String(key)] = String(value)
    })
    const url = this.requestResultString(requestPtr, 'requestresult_url')
    if (!url) throw new Error('Qoder WASM returned empty request URL')
    return {
      url,
      body: this.requestResultString(requestPtr, 'requestresult_body', true),
      headers
    }
  }

  private requestResultString(
    requestPtr: number,
    exportName: 'requestresult_url' | 'requestresult_body',
    optional = false
  ): string | undefined {
    const retptr = this.wasm.__wbindgen_add_to_stack_pointer(-16)
    let ptr = 0
    let len = 0
    try {
      this.wasm[exportName](retptr, requestPtr)
      const view = this.dataView()
      ptr = view.getInt32(retptr, true)
      len = view.getInt32(retptr + 4, true)
      if (!ptr && optional) return undefined
      return this.getString(ptr, len).slice()
    } finally {
      this.wasm.__wbindgen_add_to_stack_pointer(16)
      if (ptr) this.wasm.__wbindgen_export4(ptr, len, 1)
    }
  }

  private stringResult(
    fn: (retptr: number, ptr: number, len: number) => void,
    input: string
  ): string {
    const retptr = this.wasm.__wbindgen_add_to_stack_pointer(-16)
    let outPtr = 0
    let outLen = 0
    try {
      const ptr = this.passStringToWasm(input)
      const len = this.wasmVectorLen
      fn(retptr, ptr, len)
      const view = this.dataView()
      outPtr = view.getInt32(retptr, true)
      outLen = view.getInt32(retptr + 4, true)
      const errPtr = view.getInt32(retptr + 8, true)
      const errFlag = view.getInt32(retptr + 12, true)
      if (errFlag) throw this.takeObject(errPtr)
      return this.getString(outPtr, outLen).slice()
    } finally {
      this.wasm.__wbindgen_add_to_stack_pointer(16)
      if (outPtr) this.wasm.__wbindgen_export4(outPtr, outLen, 1)
    }
  }

  private passStringToWasm(value: string): number {
    let len = value.length
    let ptr = this.wasm.__wbindgen_export2(len, 1) >>> 0
    const memory = this.uint8Memory()
    let offset = 0
    for (; offset < len; offset++) {
      const code = value.charCodeAt(offset)
      if (code > 0x7f) break
      memory[ptr + offset] = code
    }
    if (offset !== len) {
      if (offset !== 0) value = value.slice(offset)
      ptr = this.wasm.__wbindgen_export3(ptr, len, (len = offset + value.length * 3), 1) >>> 0
      const view = this.uint8Memory().subarray(ptr + offset, ptr + len)
      const result = this.textEncoder.encodeInto(value, view)
      offset += result.written
      ptr = this.wasm.__wbindgen_export3(ptr, len, offset, 1) >>> 0
    }
    this.wasmVectorLen = offset
    return ptr
  }

  private addHeapObject(value: any): number {
    if (this.heapNext === this.heap.length) this.heap.push(this.heap.length + 1)
    const idx = this.heapNext
    this.heapNext = this.heap[idx]
    this.heap[idx] = value
    return idx
  }

  private getObject(idx: number): any {
    return this.heap[idx]
  }

  private dropObject(idx: number): void {
    if (idx < 1028) return
    this.heap[idx] = this.heapNext
    this.heapNext = idx
  }

  private takeObject(idx: number): any {
    const value = this.getObject(idx)
    this.dropObject(idx)
    return value
  }

  private uint8Memory(): Uint8Array {
    if (!this.cachedUint8Memory || this.cachedUint8Memory.byteLength === 0) {
      this.cachedUint8Memory = new Uint8Array(this.wasm.memory.buffer)
    }
    return this.cachedUint8Memory
  }

  private dataView(): DataView {
    if (!this.cachedDataView || this.cachedDataView.buffer !== this.wasm.memory.buffer) {
      this.cachedDataView = new DataView(this.wasm.memory.buffer)
    }
    return this.cachedDataView
  }

  private getString(ptr: number, len: number): string {
    ptr >>>= 0
    return this.textDecoder.decode(this.uint8Memory().subarray(ptr, ptr + len))
  }

  private handleError(fn: () => any): any {
    try {
      return fn()
    } catch (error) {
      this.wasm.__wbindgen_export(this.addHeapObject(error))
    }
  }
}

export class QoderWasmContext {
  private disposed = false

  constructor(
    private readonly runtime: QoderAuthWasm,
    private readonly ptr: number
  ) {}

  prepareInferRequest(baseUrl: string, bodyJson: string, modelKey: string, modelSource: string) {
    if (this.disposed) throw new Error('Qoder WASM context has been disposed')
    return this.runtime.prepareInferRequest(this.ptr, baseUrl, bodyJson, modelKey, modelSource)
  }

  free(): void {
    if (this.disposed) return
    this.disposed = true
    this.runtime.freeContext(this.ptr)
  }
}

export function findQoderAuthWasmBase64Candidates(binaryText: string): string[] {
  const candidates: string[] = []
  const legacy = LEGACY_WASM_BASE64_PATTERN.exec(binaryText)?.[1]
  if (legacy) candidates.push(legacy)
  for (const match of binaryText.matchAll(WASM_BASE64_CANDIDATE_PATTERN)) {
    const value = match[1]
    if (value && !candidates.includes(value)) candidates.push(value)
  }
  return candidates
}

function extractQoderAuthWasmBytes(binary: Uint8Array): Uint8Array {
  const text = Buffer.from(binary).toString('latin1')
  for (const candidate of findQoderAuthWasmBase64Candidates(text)) {
    const bytes = Buffer.from(candidate, 'base64')
    try {
      const module = new WebAssembly.Module(bytes)
      const exports = WebAssembly.Module.exports(module)
      const names = new Set(exports.map((item) => item.name))
      if (names.has('qodercontext_new') && names.has('generate_runtime_auth_fields')) {
        return bytes
      }
    } catch {
      /* try next embedded base64 candidate */
    }
  }
  throw new Error('Unable to extract qoder_auth_wasm from qodercli executable')
}

function parseJsonObject(value: string): Record<string, any> {
  const parsed = JSON.parse(value || '{}')
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}
