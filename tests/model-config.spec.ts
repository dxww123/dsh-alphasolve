import { describe, expect, it } from 'vitest'

import {
  mergeModelConfigs,
  parseModelConfig,
  parseModelConfigJson,
  resolveAlphaSolveConfig,
  resolveRoleLlmTarget,
} from '../src/model-config.js'

describe('parseModelConfig', () => {
  it('strictly accepts capacity, trace, and known role overrides', () => {
    expect(parseModelConfig({
      capacity: 3,
      detailedTrace: false,
      models: {
        generator: { provider: 'openai', model: 'proof-model', reasoningEffort: 'high' },
        verifier: {},
      },
    }, 'project config')).toEqual({
      capacity: 3,
      detailedTrace: false,
      models: {
        generator: { provider: 'openai', model: 'proof-model', reasoningEffort: 'high' },
        verifier: {},
      },
    })
  })

  it('fails closed on malformed, misspelled, and secret-bearing fields', () => {
    expect(() => parseModelConfig({ capacity: 0 }, 'user config')).toThrow(/user config.*positive/)
    expect(() => parseModelConfig({ capcity: 2 }, 'project config')).toThrow(/unknown field "capcity"/)
    expect(() => parseModelConfig({ models: { theoremChecker: {} } }, 'project config'))
      .toThrow(/unknown role "theoremChecker"/)
    expect(() => parseModelConfig({ models: { generator: { apiKey: 'secret' } } }, 'user config'))
      .toThrow(/unknown field "apiKey"/)
    expect(() => parseModelConfig({ models: { generator: { model: '  model ' } } }, 'user config'))
      .toThrow(/leading or trailing whitespace/)
  })

  it('reports JSON syntax errors with their source path', () => {
    expect(() => parseModelConfigJson('{', '/workspace/.alphasolve/config.json'))
      .toThrow(/^\/workspace\/\.alphasolve\/config\.json: invalid JSON/)
  })
})

describe('configuration precedence', () => {
  it('merges per-role fields from low to high precedence', () => {
    expect(mergeModelConfigs(
      {
        capacity: 2,
        detailedTrace: true,
        models: { generator: { provider: 'user-route', model: 'user-model' } },
      },
      {
        capacity: 4,
        models: {
          generator: { model: 'project-model', reasoningEffort: 'max' },
          verifier: { model: 'verify-model' },
        },
      },
    )).toEqual({
      capacity: 4,
      detailedTrace: true,
      models: {
        generator: { provider: 'user-route', model: 'project-model', reasoningEffort: 'max' },
        verifier: { model: 'verify-model' },
      },
    })
  })

  it('applies prompt capacity before project, user, and the default', () => {
    expect(resolveAlphaSolveConfig({
      promptCapacity: 7,
      project: { capacity: 5, detailedTrace: false },
      user: { capacity: 3, detailedTrace: true },
    })).toMatchObject({ capacity: 7, detailedTrace: false })
    expect(resolveAlphaSolveConfig({ user: { capacity: 3 } }).capacity).toBe(3)
    expect(resolveAlphaSolveConfig().capacity).toBe(2)
  })
})

describe('resolveRoleLlmTarget', () => {
  it('inherits missing fields and brands the explicit reasoning effort', () => {
    const inherited = {
      provider: 'parent-route',
      model: 'parent-model',
      reasoningEffort: 'medium' as never,
    }
    expect(resolveRoleLlmTarget('generator', inherited, {
      generator: { model: 'proof-model', reasoningEffort: 'max' },
    })).toEqual({
      provider: 'parent-route',
      model: 'proof-model',
      reasoningEffort: 'max',
    })
  })

  it('fails only when a newly-started role resolves to an unavailable route', () => {
    expect(() => resolveRoleLlmTarget(
      'verifier',
      { provider: 'route', model: 'parent-model' },
      { verifier: { model: 'missing' } },
      (_provider, model) => model !== 'missing',
    )).toThrow(/verifier.*not registered.*route\/missing/)
  })
})
