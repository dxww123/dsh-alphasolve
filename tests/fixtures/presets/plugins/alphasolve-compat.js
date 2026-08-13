// Model-facing preset fixture for the AlphaSolve compatibility integration
// tests. It intentionally has no imports so the real preset Loader can resolve
// it from the fixture directory exactly as it resolves a user-authored preset.

export const name = 'alphasolve-compat-fixture'
export const inject = ['tools', 'systemPrompt']

function parameters(name) {
  if (name === 'write') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    }
  }
  if (name === 'edit') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    }
  }
  const pathField = name === 'glob' || name === 'grep' ? 'path' : 'file_path'
  return {
    type: 'object',
    additionalProperties: false,
    properties: { [pathField]: { type: 'string' } },
  }
}

function tool(name) {
  return {
    name,
    description: `${name} preset fixture`,
    parameters: parameters(name),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: args => Promise.resolve({ name, arguments: args }),
  }
}

export function apply(ctx, config) {
  for (const toolName of config.tools ?? []) ctx.tools.register(tool(toolName))
  ctx.systemPrompt.section({
    name: `preset:${config.marker}`,
    order: 10,
    text: `fixture preset ${config.marker}`,
    ...(config.complete === true ? { complete: true } : {}),
  })
  if (config.presentation !== undefined) ctx.tools.presentAs(config.presentation)
}
