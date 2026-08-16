/**
 * Model layer — žádná část systému nemluví s konkrétním poskytovatelem přímo.
 *
 * Orchestrátor si vyžádá roli ("primary", "fast", "coding", "secondary") a dostane
 * objekt s jedinou metodou `complete()`. Výměna modelu nebo poskytovatele je tedy
 * změna v jarvis.config.json, ne v kódu.
 *
 * Kontrakt providera:
 *   complete({ system, messages, tools, maxTokens }) → {
 *     text:      string,
 *     toolCalls: [{ id, name, input }],
 *     content:   nativní bloky odpovědi (jdou zpět do historie beze změny),
 *     usage:     { inputTokens, outputTokens } | null
 *   }
 */
import { createAnthropicProvider } from "./anthropic.mjs";
import { createMockProvider } from "./mock.mjs";

const FACTORIES = {
  anthropic: createAnthropicProvider,
  mock: createMockProvider,
};

export async function createModelRegistry(cfg, bus) {
  const requested = cfg.models.provider;
  const resolved = requested === "auto" ? await detectProvider(bus) : requested;

  if (!FACTORIES[resolved]) throw new Error(`Neznámý poskytovatel modelu: ${resolved}`);

  const cache = new Map();

  async function forRole(role = "primary") {
    const roleCfg = cfg.models.roles[role];
    if (!roleCfg) throw new Error(`Role modelu "${role}" není nakonfigurovaná.`);

    // Když auto-detekce spadla na mock, ignorujeme provider zapsaný u role —
    // jinak by se systém pokusil volat API, pro které nemá klíč.
    const provider = resolved === "mock" ? "mock" : roleCfg.provider;
    const cacheKey = `${provider}:${role}`;

    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, await FACTORIES[provider]({ cfg, roleCfg, role, bus }));
    }
    return cache.get(cacheKey);
  }

  return {
    provider: resolved,
    degraded: resolved === "mock" && requested !== "mock",
    forRole,
    describe() {
      return {
        provider: resolved,
        requested,
        degraded: resolved === "mock" && requested !== "mock",
        roles: Object.fromEntries(
          Object.entries(cfg.models.roles).map(([r, c]) => [
            r,
            { model: resolved === "mock" ? "mock" : c.model, provider: resolved === "mock" ? "mock" : c.provider },
          ]),
        ),
      };
    },
  };
}

/**
 * Auto-detekce: použij Anthropic, pokud je k dispozici klíč i SDK.
 * Jinak spadni na mock, aby se agent dal spustit i bez API klíče.
 */
async function detectProvider(bus) {
  if (!process.env.ANTHROPIC_API_KEY) {
    bus?.log("ANTHROPIC_API_KEY není nastavený — jedu v režimu mock (omezené schopnosti).", "warn");
    return "mock";
  }
  try {
    await import("@anthropic-ai/sdk");
    return "anthropic";
  } catch {
    bus?.log("Balíček @anthropic-ai/sdk chybí (spusť npm install) — jedu v režimu mock.", "warn");
    return "mock";
  }
}
