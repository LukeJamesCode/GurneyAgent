import type {
  BreakerSnapshot,
  ChatChunk,
  ChatOptions,
  LLM,
  LLMProvider,
  ProfileConfig,
  ProfileName,
} from './llm.js';

export interface RoutedLLM extends LLM {
  registerProvider(provider: LLMProvider): () => void;
}

function providerMatches(provider: LLMProvider, model: string): boolean {
  return model === provider.id || model.startsWith(`${provider.id}:`);
}

export function createRoutedLLM(base: LLM): RoutedLLM {
  const providers = new Map<string, LLMProvider>();

  function providerFor(model: string): LLMProvider | undefined {
    for (const provider of providers.values()) {
      if (providerMatches(provider, model)) return provider;
    }
    return undefined;
  }

  function resolveModel(profile: ProfileName | { model: string }): string {
    return typeof profile === 'object' ? profile.model : base.resolveModel(profile);
  }

  function chat(opts: ChatOptions): AsyncIterable<ChatChunk> {
    const model = resolveModel(opts.profile);
    const provider = providerFor(model);
    if (provider) return provider.chat({ ...opts, model });
    return base.chat(opts);
  }

  async function health(): Promise<{
    ok: boolean;
    models: string[];
    providers?: Record<string, { ok: boolean; models: string[] }>;
  }> {
    const baseHealth = await base.health();
    const providerHealth: Record<string, { ok: boolean; models: string[] }> = {
      ollama: { ok: baseHealth.ok, models: baseHealth.models },
    };
    const modelSet = new Set(baseHealth.models);
    let anyProviderOk = false;

    for (const provider of providers.values()) {
      const h = provider.health
        ? await provider.health()
        : { ok: true, models: provider.models?.() ?? [provider.id] };
      providerHealth[provider.id] = h;
      if (h.ok) anyProviderOk = true;
      for (const model of h.models) modelSet.add(model);
    }

    return {
      ok: baseHealth.ok || anyProviderOk,
      models: [...modelSet],
      providers: providerHealth,
    };
  }

  function listProfiles(): Record<ProfileName, ProfileConfig | null> {
    return base.listProfiles();
  }

  function breakerSnapshot(): BreakerSnapshot {
    return base.breakerSnapshot();
  }

  function stopIdleEviction(): void {
    base.stopIdleEviction();
  }

  // Vision capability is a property of the underlying Ollama model; registered
  // providers are routed by chat() and don't advertise it, so defer to the base.
  async function supportsVision(model: string): Promise<boolean> {
    return base.supportsVision ? base.supportsVision(model) : false;
  }

  function registerProvider(provider: LLMProvider): () => void {
    providers.set(provider.id, provider);
    return () => {
      if (providers.get(provider.id) === provider) providers.delete(provider.id);
    };
  }

  return {
    chat,
    health,
    listProfiles,
    resolveModel,
    supportsVision,
    breakerSnapshot,
    stopIdleEviction,
    registerProvider,
  };
}
