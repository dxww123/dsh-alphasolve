import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

export const CALCULATOR_TOOL_NAME = 'alphasolve_calculate'

export interface CalculatorLimits {
  readonly maxLength?: number
  readonly maxNodes?: number
  readonly maxSteps?: number
  readonly maxDepth?: number
}

export interface EvaluateExpressionOptions extends CalculatorLimits {
  readonly signal?: AbortSignal
}

export type ExpressionErrorCode =
  | 'INVALID_EXPRESSION'
  | 'UNKNOWN_IDENTIFIER'
  | 'INVALID_ARITY'
  | 'NON_FINITE_RESULT'
  | 'LIMIT_EXCEEDED'
  | 'CANCELLED'

export class ExpressionEvaluationError extends Error {
  readonly code: ExpressionErrorCode

  constructor(code: ExpressionErrorCode, message: string) {
    super(message)
    this.name = 'ExpressionEvaluationError'
    this.code = code
  }
}

interface ResolvedLimits {
  readonly maxLength: number
  readonly maxNodes: number
  readonly maxSteps: number
  readonly maxDepth: number
  readonly signal?: AbortSignal
}

interface FunctionSpec {
  readonly minArgs: number
  readonly maxArgs: number
  invoke(args: readonly number[]): number
}

type Token =
  | { readonly kind: 'number'; readonly value: number; readonly start: number }
  | { readonly kind: 'identifier'; readonly value: string; readonly start: number }
  | { readonly kind: 'operator'; readonly value: '+' | '-' | '*' | '/' | '%' | '**'; readonly start: number }
  | { readonly kind: 'leftParen' | 'rightParen' | 'comma' | 'eof'; readonly start: number }

type Operator = Extract<Token, { kind: 'operator' }>['value']

const DEFAULT_LIMITS = Object.freeze({
  maxLength: 2_000,
  maxNodes: 512,
  maxSteps: 1_024,
  maxDepth: 64,
})

const NUMBER_PREFIX = /^(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/
const IDENTIFIER_START = /[A-Za-z_]/
const IDENTIFIER_CONTINUE = /[A-Za-z0-9_]/

function fixedArity(arity: number, invoke: (...args: number[]) => number): FunctionSpec {
  return { minArgs: arity, maxArgs: arity, invoke: args => invoke(...args) }
}

function rangedArity(minArgs: number, maxArgs: number, invoke: (...args: number[]) => number): FunctionSpec {
  return { minArgs, maxArgs, invoke: args => invoke(...args) }
}

/** Deliberately finite whitelist: no random, callbacks, objects, or property access. */
const FUNCTIONS: Readonly<Record<string, FunctionSpec>> = Object.freeze({
  abs: fixedArity(1, Math.abs),
  acos: fixedArity(1, Math.acos),
  acosh: fixedArity(1, Math.acosh),
  asin: fixedArity(1, Math.asin),
  asinh: fixedArity(1, Math.asinh),
  atan: fixedArity(1, Math.atan),
  atanh: fixedArity(1, Math.atanh),
  atan2: fixedArity(2, Math.atan2),
  cbrt: fixedArity(1, Math.cbrt),
  ceil: fixedArity(1, Math.ceil),
  clamp: fixedArity(3, (value, lower, upper) => Math.min(Math.max(value, lower), upper)),
  cos: fixedArity(1, Math.cos),
  cosh: fixedArity(1, Math.cosh),
  exp: fixedArity(1, Math.exp),
  floor: fixedArity(1, Math.floor),
  hypot: rangedArity(1, 32, Math.hypot),
  ln: fixedArity(1, Math.log),
  log: rangedArity(1, 2, (value, base = Math.E) => Math.log(value) / Math.log(base)),
  log10: fixedArity(1, Math.log10),
  log2: fixedArity(1, Math.log2),
  max: rangedArity(1, 32, Math.max),
  min: rangedArity(1, 32, Math.min),
  pow: fixedArity(2, Math.pow),
  round: fixedArity(1, Math.round),
  sign: fixedArity(1, Math.sign),
  sin: fixedArity(1, Math.sin),
  sinh: fixedArity(1, Math.sinh),
  sqrt: fixedArity(1, Math.sqrt),
  tan: fixedArity(1, Math.tan),
  tanh: fixedArity(1, Math.tanh),
  trunc: fixedArity(1, Math.trunc),
})

const CONSTANTS: Readonly<Record<string, number>> = Object.freeze({
  e: Math.E,
  E: Math.E,
  pi: Math.PI,
  PI: Math.PI,
  tau: 2 * Math.PI,
  TAU: 2 * Math.PI,
  phi: (1 + Math.sqrt(5)) / 2,
  PHI: (1 + Math.sqrt(5)) / 2,
  sqrt2: Math.SQRT2,
  SQRT2: Math.SQRT2,
  ln2: Math.LN2,
  LN2: Math.LN2,
  ln10: Math.LN10,
  LN10: Math.LN10,
  log2e: Math.LOG2E,
  LOG2E: Math.LOG2E,
  log10e: Math.LOG10E,
  LOG10E: Math.LOG10E,
})

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function resolveLimits(options: EvaluateExpressionOptions): ResolvedLimits {
  return {
    maxLength: positiveLimit(options.maxLength, DEFAULT_LIMITS.maxLength, 'maxLength'),
    maxNodes: positiveLimit(options.maxNodes, DEFAULT_LIMITS.maxNodes, 'maxNodes'),
    maxSteps: positiveLimit(options.maxSteps, DEFAULT_LIMITS.maxSteps, 'maxSteps'),
    maxDepth: positiveLimit(options.maxDepth, DEFAULT_LIMITS.maxDepth, 'maxDepth'),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
}

function fail(code: ExpressionErrorCode, message: string): never {
  throw new ExpressionEvaluationError(code, message)
}

function finite(value: number, context: string): number {
  if (!Number.isFinite(value)) fail('NON_FINITE_RESULT', `${context} produced NaN or Infinity`)
  // JSON has no distinct negative-zero representation; normalize before the
  // tool registry's lossless-JSON boundary.
  return Object.is(value, -0) ? 0 : value
}

class Lexer {
  private index = 0

  constructor(private readonly input: string) {}

  next(): Token {
    while (this.index < this.input.length && /\s/.test(this.input[this.index] ?? '')) this.index += 1
    const start = this.index
    if (start >= this.input.length) return { kind: 'eof', start }
    const current = this.input[start] ?? ''

    if (/\d/.test(current) || (current === '.' && /\d/.test(this.input[start + 1] ?? ''))) {
      const match = NUMBER_PREFIX.exec(this.input.slice(start))
      if (match === null) fail('INVALID_EXPRESSION', `invalid number at position ${start + 1}`)
      this.index += match[0].length
      const value = Number(match[0])
      return { kind: 'number', value: finite(value, `number at position ${start + 1}`), start }
    }

    if (IDENTIFIER_START.test(current)) {
      this.index += 1
      while (this.index < this.input.length && IDENTIFIER_CONTINUE.test(this.input[this.index] ?? '')) {
        this.index += 1
      }
      return { kind: 'identifier', value: this.input.slice(start, this.index), start }
    }

    this.index += 1
    switch (current) {
      case '+':
      case '-':
      case '/':
      case '%':
        return { kind: 'operator', value: current, start }
      case '*':
        if (this.input[this.index] === '*') {
          this.index += 1
          return { kind: 'operator', value: '**', start }
        }
        return { kind: 'operator', value: '*', start }
      case '(':
        return { kind: 'leftParen', start }
      case ')':
        return { kind: 'rightParen', start }
      case ',':
        return { kind: 'comma', start }
      default:
        fail('INVALID_EXPRESSION', `unsupported character ${JSON.stringify(current)} at position ${start + 1}`)
    }
  }
}

class Parser {
  private readonly lexer: Lexer
  private token: Token
  private nodes = 0
  private steps = 0
  private depth = 0

  constructor(input: string, private readonly limits: ResolvedLimits) {
    this.lexer = new Lexer(input)
    this.token = this.lexer.next()
  }

  parse(): number {
    this.checkCancelled()
    const result = this.parseAdditive()
    if (this.token.kind !== 'eof') {
      fail('INVALID_EXPRESSION', `unexpected token at position ${this.token.start + 1}`)
    }
    return finite(result, 'expression')
  }

  private advance(): void {
    this.token = this.lexer.next()
  }

  private checkCancelled(): void {
    if (this.limits.signal?.aborted) fail('CANCELLED', 'calculation was cancelled')
  }

  private countNode(): void {
    this.checkCancelled()
    this.nodes += 1
    if (this.nodes > this.limits.maxNodes) {
      fail('LIMIT_EXCEEDED', `expression exceeds maxNodes=${this.limits.maxNodes}`)
    }
  }

  private countStep(): void {
    this.checkCancelled()
    this.steps += 1
    if (this.steps > this.limits.maxSteps) {
      fail('LIMIT_EXCEEDED', `expression exceeds maxSteps=${this.limits.maxSteps}`)
    }
  }

  private descend<T>(parse: () => T): T {
    this.depth += 1
    if (this.depth > this.limits.maxDepth) {
      this.depth -= 1
      return fail('LIMIT_EXCEEDED', `expression exceeds maxDepth=${this.limits.maxDepth}`)
    }
    try {
      return parse()
    } finally {
      this.depth -= 1
    }
  }

  private operator(value: Operator): boolean {
    return this.token.kind === 'operator' && this.token.value === value
  }

  private tokenKind(): Token['kind'] {
    return this.token.kind
  }

  private parseAdditive(): number {
    let value = this.parseMultiplicative()
    while (this.operator('+') || this.operator('-')) {
      const operator = this.token.kind === 'operator' ? this.token.value : fail('INVALID_EXPRESSION', 'operator invariant')
      this.advance()
      const right = this.parseMultiplicative()
      this.countNode()
      this.countStep()
      value = finite(operator === '+' ? value + right : value - right, `operator ${operator}`)
    }
    return value
  }

  private parseMultiplicative(): number {
    let value = this.parseUnary()
    while (this.operator('*') || this.operator('/') || this.operator('%')) {
      const operator = this.token.kind === 'operator' ? this.token.value : fail('INVALID_EXPRESSION', 'operator invariant')
      this.advance()
      const right = this.parseUnary()
      this.countNode()
      this.countStep()
      if (operator === '*') value = finite(value * right, 'operator *')
      else if (operator === '/') value = finite(value / right, 'operator /')
      else value = finite(value % right, 'operator %')
    }
    return value
  }

  private parseUnary(): number {
    if (this.operator('+') || this.operator('-')) {
      const operator = this.token.kind === 'operator' ? this.token.value : fail('INVALID_EXPRESSION', 'operator invariant')
      this.advance()
      const value = this.descend(() => this.parseUnary())
      this.countNode()
      this.countStep()
      return finite(operator === '-' ? -value : value, `unary ${operator}`)
    }
    return this.parsePower()
  }

  private parsePower(): number {
    const left = this.parsePrimary()
    if (!this.operator('**')) return left
    this.advance()
    const right = this.descend(() => this.parseUnary())
    this.countNode()
    this.countStep()
    return finite(left ** right, 'operator **')
  }

  private parsePrimary(): number {
    if (this.token.kind === 'number') {
      const value = this.token.value
      this.advance()
      this.countNode()
      return value
    }

    if (this.token.kind === 'identifier') {
      const identifier = this.token.value
      const position = this.token.start
      this.advance()
      if (this.tokenKind() === 'leftParen') return this.parseCall(identifier, position)
      const constant = Object.hasOwn(CONSTANTS, identifier) ? CONSTANTS[identifier] : undefined
      if (constant === undefined) {
        return fail('UNKNOWN_IDENTIFIER', `unknown identifier "${identifier}" at position ${position + 1}`)
      }
      this.countNode()
      return constant
    }

    if (this.token.kind === 'leftParen') {
      const position = this.token.start
      this.advance()
      const value = this.descend(() => this.parseAdditive())
      if (this.tokenKind() !== 'rightParen') {
        return fail('INVALID_EXPRESSION', `missing closing parenthesis for position ${position + 1}`)
      }
      this.advance()
      return value
    }

    return fail('INVALID_EXPRESSION', `expected a number, constant, function, or parenthesis at position ${this.token.start + 1}`)
  }

  private parseCall(identifier: string, position: number): number {
    const fn = Object.hasOwn(FUNCTIONS, identifier) ? FUNCTIONS[identifier] : undefined
    if (fn === undefined) {
      return fail('UNKNOWN_IDENTIFIER', `unknown function "${identifier}" at position ${position + 1}`)
    }
    this.advance()
    const args: number[] = []
    if (this.token.kind !== 'rightParen') {
      while (true) {
        args.push(this.descend(() => this.parseAdditive()))
        if (this.token.kind !== 'comma') break
        this.advance()
      }
    }
    if (this.token.kind !== 'rightParen') {
      return fail('INVALID_EXPRESSION', `missing closing parenthesis for function "${identifier}"`)
    }
    this.advance()

    if (args.length < fn.minArgs || args.length > fn.maxArgs) {
      const expected = fn.minArgs === fn.maxArgs ? String(fn.minArgs) : `${fn.minArgs}-${fn.maxArgs}`
      return fail('INVALID_ARITY', `function "${identifier}" expects ${expected} argument(s), received ${args.length}`)
    }
    this.countNode()
    this.countStep()
    return finite(fn.invoke(args), `function ${identifier}`)
  }
}

/** Evaluate one side-effect-free arithmetic expression using the fixed grammar. */
export function evaluateExpression(expression: string, options: EvaluateExpressionOptions = {}): number {
  if (typeof expression !== 'string') throw new TypeError('expression must be a string')
  const limits = resolveLimits(options)
  if (expression.length === 0 || expression.trim().length === 0) {
    return fail('INVALID_EXPRESSION', 'expression must not be empty')
  }
  if (expression.length > limits.maxLength) {
    return fail('LIMIT_EXCEEDED', `expression exceeds maxLength=${limits.maxLength}`)
  }
  if (limits.signal?.aborted) return fail('CANCELLED', 'calculation was cancelled')
  return new Parser(expression, limits).parse()
}

function parseToolArgs(args: unknown): { expression: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new TypeError('alphasolve_calculate arguments must be an object')
  }
  const record = args as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== 'expression') {
    throw new TypeError('alphasolve_calculate accepts only the expression argument')
  }
  if (typeof record.expression !== 'string') throw new TypeError('expression must be a string')
  return { expression: record.expression }
}

/** Construct the scoped calculator tool installed for approved helper roles. */
export function createCalculatorTool(limits: CalculatorLimits = {}): ToolDefinition {
  return {
    name: CALCULATOR_TOOL_NAME,
    description: 'Evaluate a bounded arithmetic expression without code execution. Supports numbers, scientific notation, + - * / % **, parentheses, and the documented finite math function/constant whitelist.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expression: {
          type: 'string',
          description: 'Arithmetic expression. Constants include pi, e, tau, phi, sqrt2; functions include abs, trig, log, sqrt, min, max, hypot, pow, round, and clamp.',
        },
      },
      required: ['expression'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          expression: { type: 'string' },
          value: { type: 'number' },
        },
        required: ['expression', 'value'],
      },
      render: (_args, value) => {
        const result = value as { expression: string; value: number }
        return [{ type: 'text', text: `${result.expression} = ${String(result.value)}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const { expression } = parseToolArgs(args)
      const value = evaluateExpression(expression, { ...limits, signal: exec.signal })
      return { expression, value }
    },
  }
}
