/**
 * Anthropic provider — jedno kolo konverzace přes oficiální SDK.
 *
 * Streamuje se schválně: dlouhá odpověď jinak riskuje HTTP timeout a UI by
 * navíc nemělo z čeho ukazovat, že agent pracuje. Textové delty jdou na bus,
 * takže se odpověď v HUD skládá průběžně.
 *
 * Smyčku volání nástrojů nedrží provider, ale orchestrátor — potřebujeme mezi
 * kroky vstoupit kvůli potvrzování akcí a projekci stavu do UI.
 */
export async function createAnthropicProvider({ cfg, roleCfg, role, bus }) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

  return {
    role,
    model: roleCfg.model,

    async complete({ system, messages, tools = [], maxTokens }) {
      const stream = client.messages.stream({
        model: roleCfg.model,
        max_tokens: maxTokens ?? cfg.models.maxTokens,
        system,
        messages,
        ...(tools.length ? { tools } : {}),
        thinking: { type: "adaptive" },
        output_config: { effort: roleCfg.effort ?? "high" },
      });

      // Do UI posíláme jen výsledný text. Interní reasoning modelu se ven
      // nikdy neposílá — v HUD se ukazuje pouze stav, nástroj a výsledek.
      stream.on("text", (delta) => bus?.publish({ type: "delta", text: delta }));

      const message = await stream.finalMessage();

      const text = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      const toolCalls = message.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));

      return {
        text,
        toolCalls,
        content: message.content,
        stopReason: message.stop_reason,
        usage: {
          inputTokens: message.usage?.input_tokens ?? 0,
          outputTokens: message.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}
