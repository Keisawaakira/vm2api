import vm from 'node:vm'
const plain = (value) => JSON.parse(JSON.stringify(value))
const esm = (init) => {
  let done = false
  return () => {
    if (!done) {
      done = true
      init()
    }
  }
}

/** Executes the recorded API constructor and beta functions, with external SDK/config boundaries mocked. */
export function requestWireApiControl(
  sem,
  {
    body = {},
    options = {},
    baseBetas = ['claude-code-20250219', 'oauth-2025-04-20'],
    profile = true,
    auth = true,
    extraBody = {},
  } = {},
) {
  const calls = { cache: 0, configureEffort: 0 }
  const ctx = vm.createContext({
    __esm: esm,
    calls,
    process: { env: {} },
    options2: {
      querySource: 'agent:kin',
      model: body.model || 'claude-opus-4-6',
      honorCallerThinking: true,
      wireThinking: body.thinking,
      wireBody: body,
      wireMessages: body.messages || [],
      maxOutputTokensOverride: body.max_tokens || 128000,
      outputConfigOverride: body.output_config,
      contextManagementOverride: body.context_management,
      safeguards: body.safeguards,
      toolChoice: body.tool_choice,
      topP: body.top_p,
      topK: body.top_k,
      temperatureOverride: body.temperature,
      stopSequences: body.stop_sequences,
      ...options,
    },
    thinkingConfig:
      body.thinking?.type === 'enabled'
        ? { type: 'enabled', budgetTokens: body.thinking.budget_tokens }
        : body.thinking || { type: 'disabled' },
    betas: baseBetas.slice(),
    useBetas: baseBetas.length > 0,
    CONTEXT_1M_BETA_HEADER: 'context-1m-2025-08-07',
    STRUCTURED_OUTPUTS_BETA_HEADER: 'structured-outputs-2025-12-15',
    CONTEXT_MANAGEMENT_BETA_HEADER: 'context-management-2025-06-27',
    REDACT_THINKING_BETA_HEADER: 'redact',
    FAST_MODE_BETA_HEADER: 'fast-mode-2026-02-01',
    getSonnet1mExpTreatmentEnabled: () => false,
    getAPIProvider: () => 'firstParty',
    getBedrockExtraBodyParamsBetas: () => [],
    toolSearchHeader: null,
    getExtraBodyParams: () => structuredClone(extraBody),
    effort: body.output_config?.effort,
    configureEffortParams: () => {
      calls.configureEffort++
    },
    configureTaskBudgetParams() {},
    modelSupportsStructuredOutputs: () => true,
    getMaxOutputTokensForModel: () => 32000,
    isEnvTruthy: () => false,
    modelSupportsThinking: () => true,
    modelSupportsAdaptiveThinking: () => true,
    getMaxThinkingTokensForModel: () => 8192,
    getAPIContextManagement: () => ({ edits: ['native-default'] }),
    thinkingClearLatched: false,
    getPromptCachingEnabled: () => true,
    isFastModeEnabled: () => false,
    isFastModeAvailable: () => true,
    isFastModeCooldown: () => false,
    isFastModeSupportedByModel: () => true,
    fastModeHeaderLatched: false,
    cachedMCEnabled: false,
    cacheEditingHeaderLatched: false,
    cacheEditingBetaHeader: 'cache-editing',
    logForDebugging() {},
    logForDebugging2() {},
    isKinQuerySource: (value) => ['agent:kin', 'native_messages'].includes(value),
    isAnthropicAuthEnabled: () => auth,
    hasProfileScope: () => profile,
    messagesForAPI: body.messages || [],
    consumedCacheEdits: [],
    consumedPinnedEdits: [],
    addCacheBreakpoints: (value) => value,
    system: structuredClone(body.system || []),
    allTools: structuredClone(body.tools || []),
    readPanelCacheTtl: () => '1h',
    explicitCacheTtl: () => '1h',
    resolveKinCacheTtl: () => '1h',
    applyKinOwnedCacheMarkers: () => {
      calls.cache++
    },
    fillMissingCacheTtl: () => {
      calls.cache++
    },
    normalizeModelStringForAPI: (value) => value,
    getAPIMetadata: () => ({ user_id: 'fixture-host-identity' }),
    lastRequestBetas: [],
  })
  vm.runInContext(sem.request_wire.helpers + '\n' + sem.request_wire.official_betas, ctx)
  vm.runInContext(
    'function construct(){' + sem.request_wire.params + '\nreturn paramsFromContext({model:options2.model})}',
    ctx,
  )
  const result = plain(ctx.construct())
  return { result, calls, lastRequestBetas: plain(ctx.lastRequestBetas) }
}

/** Executes the real bridge while stopping at the existing SDK boundary. */
export async function requestWireBridgeControl(query, input) {
  let captured
  const ctx = vm.createContext({
    asSystemPrompt: (value) => value,
    getEmptyToolPermissionContext: () => ({}),
    queryModelWithStreaming: async function* (value) {
      captured = value
    },
  })
  vm.runInContext(query, ctx)
  for await (const value of ctx.queryKinMessagesWithStreaming(input)) void value
  return captured
}
