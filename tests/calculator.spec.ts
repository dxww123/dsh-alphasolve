import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import {
  CALCULATOR_TOOL_NAME,
  createCalculatorTool,
  evaluateExpression,
  ExpressionEvaluationError,
} from '../src/calculator.js'

describe('evaluateExpression', () => {
  it('implements arithmetic precedence and right-associative powers', () => {
    expect(evaluateExpression('2 + 3 * 4 - 5 % 2')).toBe(13)
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20)
    expect(evaluateExpression('2 ** 3 ** 2')).toBe(512)
    expect(evaluateExpression('-2 ** 2')).toBe(-4)
    expect(evaluateExpression('2 ** -2')).toBe(0.25)
    expect(evaluateExpression('--2')).toBe(2)
  })

  it('supports scientific notation, constants, and finite whitelisted functions', () => {
    expect(evaluateExpression('1.5e2 + .5 + 5.')).toBe(155.5)
    expect(evaluateExpression('sin(pi / 2) + cos(0)')).toBeCloseTo(2)
    expect(evaluateExpression('log(8, 2)')).toBeCloseTo(3)
    expect(evaluateExpression('sqrt2 ** 2')).toBeCloseTo(2)
    expect(evaluateExpression('tau')).toBeCloseTo(2 * Math.PI)
  })

  it('accepts bounded comma-separated multi-argument calls', () => {
    expect(evaluateExpression('max(1, -5, 8, 3)')).toBe(8)
    expect(evaluateExpression('min(1, -5, 8, 3)')).toBe(-5)
    expect(evaluateExpression('hypot(3, 4)')).toBe(5)
    expect(evaluateExpression('atan2(0, -1)')).toBeCloseTo(Math.PI)
    expect(evaluateExpression('clamp(12, 0, 10)')).toBe(10)
  })

  it('rejects non-finite literals, operations, and function domains', () => {
    for (const expression of ['1e999', '1 / 0', '0 / 0', '1 % 0', '0 ** -1', 'sqrt(-1)', 'log(0)', 'exp(10000)']) {
      expect(() => evaluateExpression(expression), expression).toThrow(/NaN or Infinity/)
    }
    expect(evaluateExpression('-0')).toBe(0)
    expect(Object.is(evaluateExpression('-0'), -0)).toBe(false)
  })

  it('rejects unknown identifiers, property access, strings, and statement/code syntax', () => {
    const attacks = [
      'NaN',
      'Infinity',
      'random()',
      'Math.sin(0)',
      'process.exit()',
      'globalThis.process.exit()',
      'constructor.constructor("return process")()',
      'constructor(1)',
      'toString()',
      '__proto__',
      'valueOf()',
      'this',
      '1; 2',
      'x = 1',
      '[1, 2]',
      '{ value: 1 }',
      '`template`',
      '(() => 1)()',
      '2(3)',
      '1..toString()',
      '0x10',
    ]
    for (const expression of attacks) {
      expect(() => evaluateExpression(expression), expression).toThrow(ExpressionEvaluationError)
    }
  })

  it('fails closed on malformed calls and arity mismatches', () => {
    expect(() => evaluateExpression('pow(2)')).toThrow(/expects 2 argument/)
    expect(() => evaluateExpression('max()')).toThrow(/expects 1-32 argument/)
    expect(() => evaluateExpression('max(1,)')).toThrow(/expected a number/)
    expect(() => evaluateExpression('(1 + 2')).toThrow(/missing closing parenthesis/)
    expect(() => evaluateExpression('1e+')).toThrow(ExpressionEvaluationError)
    expect(() => evaluateExpression('')).toThrow(/must not be empty/)
  })

  it('enforces length, syntax-node, operation, recursion, and cancellation budgets', () => {
    expect(() => evaluateExpression('1 + 2', { maxLength: 4 })).toThrow(/maxLength=4/)
    expect(() => evaluateExpression('1 + 2', { maxNodes: 2 })).toThrow(/maxNodes=2/)
    expect(() => evaluateExpression('1 + 2 + 3', { maxSteps: 1 })).toThrow(/maxSteps=1/)
    expect(() => evaluateExpression('(((1)))', { maxDepth: 2 })).toThrow(/maxDepth=2/)

    const controller = new AbortController()
    controller.abort()
    expect(() => evaluateExpression('1 + 2', { signal: controller.signal })).toThrow(/cancelled/)
  })
})

describe('createCalculatorTool', () => {
  function execution(signal = new AbortController().signal): ToolRunContext {
    return { signal } as ToolRunContext
  }

  it('constructs the scoped alphasolve_calculate tool', async () => {
    const tool = createCalculatorTool()
    expect(tool.name).toBe(CALCULATOR_TOOL_NAME)
    expect(tool.isConcurrencySafe?.({ expression: '1 + 1' })).toBe(true)
    await expect(tool.execute({ expression: 'hypot(3, 4)' }, execution())).resolves.toEqual({
      expression: 'hypot(3, 4)',
      value: 5,
    })
  })

  it('validates its argument object and forwards cancellation', async () => {
    const tool = createCalculatorTool()
    await expect(tool.execute({ expression: '1', extra: true }, execution())).rejects.toThrow(/accepts only/)
    await expect(tool.execute({ expression: 1 }, execution())).rejects.toThrow(/expression must be a string/)

    const controller = new AbortController()
    controller.abort()
    await expect(tool.execute({ expression: '1 + 2' }, execution(controller.signal))).rejects.toThrow(/cancelled/)
  })
})
