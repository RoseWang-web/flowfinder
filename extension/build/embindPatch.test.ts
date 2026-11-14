/**
 * The patched embind glue must behave exactly like the generated original.
 * We pull the original functions out of the real face_mesh files, run them
 * side by side with the patched ones (in Node, where eval is allowed) on the
 * same mock types, and compare return values, the arguments that reach the
 * C++ side, destructor calls and errors.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { patchEmbind } from './embindPatch'

const FACE_MESH = resolve(__dirname, '../../node_modules/@mediapipe/face_mesh')
const FILES = ['face_mesh_solution_simd_wasm_bin.js', 'face_mesh_solution_wasm_bin.js']

/** Source of `function <name>(...) {...}`, matching braces outside string literals. */
function extract(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`no ${name}`)
  let depth = 0
  let quote: string | null = null
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unbalanced ${name}`)
}

type Log = unknown[]
type Dtor = 'none' | 'fn' | 'stack'
interface Glue {
  craftInvokerFunction: (...a: unknown[]) => any
  __emval_get_method_caller: (argCount: number, argTypes: unknown) => number
  callers: any[]
}

function load(source: string, log: Log, types: () => unknown[]): Glue {
  const parts = ['makeLegalFunctionName', 'createNamedFunction', 'new_', 'craftInvokerFunction', '__emval_get_method_caller']
    .map(n => extract(source, n)).join('\n')
  const callers: any[] = []
  // eslint-disable-next-line no-new-func
  const glue = new Function(
    'throwBindingError', 'runDestructors', '__emval_lookupTypes', '__emval_addMethodCaller',
    `var char_0=48;var char_9=57;${parts}; return { craftInvokerFunction, __emval_get_method_caller }`,
  )(
    (m: string) => { throw new Error('BindingError: ' + m) },
    (d: (() => void)[]) => { log.push('runDestructors'); d.forEach(f => f()) },
    () => types(),
    (fn: unknown) => { callers.push(fn); return callers.length - 1 },
  )
  return { ...glue, callers }
}

/** Mock embind type: records wiring and optionally needs a destructor. */
function mockType(log: Log, name: string, dtor: Dtor) {
  return {
    name,
    destructorFunction: dtor === 'none' ? null : dtor === 'fn' ? (w: unknown) => log.push(`dtor ${name} ${String(w)}`) : undefined,
    toWireType(d: (() => void)[] | null, v: unknown) {
      log.push(`toWire ${name} ${v === undefined ? 'undefined' : typeof v === 'object' ? 'obj' : String(v)} stack=${d ? 'yes' : 'null'}`)
      if (d) d.push(() => log.push(`stackDtor ${name}`))
      return `w(${name})`
    },
    fromWireType: (rv: unknown) => `ret(${String(rv)})`,
  }
}

function run(f: () => unknown): unknown {
  try { return { value: f() } } catch (e) { return { error: (e as Error).message } }
}

describe('embind CSP patch', () => {
  for (const file of FILES) {
    const original = readFileSync(resolve(FACE_MESH, file), 'utf8')
    const patched = patchEmbind(original, file)

    it(`${file}: no eval / new Function remains`, () => {
      expect(patched).not.toMatch(/new Function\(|new_\(Function/)
    })

    it(`${file}: craftInvokerFunction behaves identically`, () => {
      const argSets: Dtor[][] = [[], ['none'], ['fn', 'none'], ['none', 'stack', 'fn']]
      let n = 0
      for (const ret of ['void', 'int'])
        for (const method of [false, true])
          for (const args of argSets)
            for (const thisDtor of ['none', 'fn', 'stack'] as Dtor[]) {
              const outcome = (source: string) => {
                const log: Log = []
                const glue = load(source, log, () => [])
                const argTypes = [
                  mockType(log, ret, 'none'),
                  method ? mockType(log, 'Self', thisDtor) : null,
                  ...args.map((d, i) => mockType(log, `T${i}`, d)),
                ]
                const invoker = (...a: unknown[]) => { log.push(['invoker', ...a]); return 'rv' }
                const fn = glue.craftInvokerFunction('my-func', argTypes, method ? {} : null, invoker, 'TARGET')
                const self = { id: 'self' }
                const good = run(() => fn.apply(self, args.map((_, i) => `a${i}`)))
                const bad = run(() => fn.apply(self, [...args.map((_, i) => `a${i}`), 'extra']))
                return { name: fn.name, good, bad, log }
              }
              expect(outcome(patched), JSON.stringify({ ret, method, args, thisDtor })).toEqual(outcome(original))
              n++
            }
      expect(n).toBe(48)
    })

    it(`${file}: __emval_get_method_caller behaves identically`, () => {
      for (const retVoid of [true, false]) {
        for (const nArgs of [0, 1, 3]) {
          const outcome = (source: string) => {
            const log: Log = []
            const types = [
              { name: retVoid ? 'void' : 'val', isVoid: retVoid, toWireType: (d: unknown, rv: unknown) => `wire(${String(rv)},${String(d)})` },
              ...Array.from({ length: nArgs }, (_, i) => ({
                name: `A${i}`,
                argPackAdvance: 8,
                readValueFromPointer: (p: number) => `v${i}@${p}`,
                deleteObject: i === 1 ? (v: unknown) => log.push(`delete ${String(v)}`) : undefined,
              })),
            ]
            const glue = load(source, log, () => types)
            const caller = glue.callers[glue.__emval_get_method_caller(nArgs + 1, 0)]
            const handle = { m(...a: unknown[]) { log.push(['m', this === handle, ...a]); return 'rv' } }
            const result = caller(handle, 'm', 'DESTRUCTORS', 1000)
            return { name: caller.name, result, log }
          }
          expect(outcome(patched)).toEqual(outcome(original))
        }
      }
    })
  }

  it('refuses to build if the upstream file changes shape', () => {
    expect(() => patchEmbind('no embind here', 'x.js')).toThrow(/expected 1/)
  })
})
