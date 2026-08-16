/**
 * Short-term memory — aktuální konverzace jako ring buffer.
 *
 * Drží zprávy ve tvaru, který přebírá model provider (role + content bloky),
 * takže orchestrátor nemusí historii nikde překládat.
 */
export class ShortTermMemory {
  #turns = [];
  #maxTurns;

  constructor({ maxTurns = 30 } = {}) {
    this.#maxTurns = maxTurns;
  }

  /** @param {"user"|"assistant"} role */
  push(role, content) {
    this.#turns.push({ role, content });
    this.#trim();
  }

  /** Výsledky nástrojů se vracejí jako user turn s tool_result bloky. */
  pushToolResults(blocks) {
    if (!blocks.length) return;
    this.#turns.push({ role: "user", content: blocks });
    this.#trim();
  }

  #trim() {
    // Ořezáváme od začátku, ale nikdy nesmí historie začínat výsledkem nástroje
    // bez odpovídajícího tool_use — takový tvar API odmítne.
    while (this.#turns.length > this.#maxTurns) this.#turns.shift();
    while (this.#turns.length && this.#startsWithOrphanToolResult()) this.#turns.shift();
  }

  #startsWithOrphanToolResult() {
    const first = this.#turns[0];
    return Array.isArray(first?.content) && first.content.some((b) => b.type === "tool_result");
  }

  messages() {
    return this.#turns.map((t) => ({ ...t }));
  }

  clear() {
    this.#turns = [];
  }

  stats() {
    return { turns: this.#turns.length, maxTurns: this.#maxTurns };
  }
}
