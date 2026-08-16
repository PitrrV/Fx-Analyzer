/**
 * Orchestrátor — agentní smyčka.
 *
 * Rozhodnutí „stačí odpovědět / potřebuju nástroj / potřebuju několik nástrojů
 * za sebou" nedělá tenhle kód. Dělá ho model: dostane katalog nástrojů a sám
 * volí, jestli a co zavolá. Orchestrátor jen drží smyčku, aby se dalo:
 *
 *   • promítat stav do UI (IDLE → THINKING → WORKING → SPEAKING),
 *   • zastavit se před nevratnou akcí a počkat na souhlas uživatele,
 *   • zapsat průběh do task memory,
 *   • omezit počet kroků, aby smyčka nemohla utéct.
 *
 * Ven z modelu do UI jde jen bezpečná telemetrie — stav, jméno nástroje,
 * výsledek. Interní reasoning se nikam nepublikuje.
 */
import { randomUUID } from "node:crypto";
import { STATES } from "./bus.mjs";
import { TASK_STATUS } from "./memory/taskMemory.mjs";

export class Orchestrator {
  #cfg;
  #bus;
  #memory;
  #tools;
  #models;
  #pendingConfirmations = new Map();
  #busy = false;

  constructor({ cfg, bus, memory, tools, models }) {
    this.#cfg = cfg;
    this.#bus = bus;
    this.#memory = memory;
    this.#tools = tools;
    this.#models = models;
  }

  get busy() {
    return this.#busy;
  }

  /** Čekající dotaz na potvrzení, aby ho nově připojené UI uvidělo taky. */
  pendingConfirmations() {
    return [...this.#pendingConfirmations.values()].map(({ payload }) => payload);
  }

  /**
   * Zpracuje jeden vstup uživatele od začátku do konce.
   * @param {string} text
   * @param {{role?: string}} options
   */
  async handleInput(text, { role = "primary" } = {}) {
    if (this.#busy) {
      this.#bus.log("Předchozí požadavek ještě běží — počkej na dokončení.", "warn");
      return;
    }
    this.#busy = true;

    const task = this.#memory.tasks.start(truncate(text, 80));
    this.#bus.message("user", text);
    this.#memory.shortTerm.push("user", [{ type: "text", text }]);

    try {
      const model = await this.#models.forRole(role);
      const answer = await this.#runLoop(model, task);

      this.#bus.setState(STATES.SPEAKING);
      this.#bus.message("assistant", answer);
      this.#memory.tasks.finish(task.id, TASK_STATUS.DONE, truncate(answer, 120));
    } catch (err) {
      this.#bus.setState(STATES.ERROR);
      this.#bus.message("assistant", `Narazil jsem na chybu: ${err.message}`);
      this.#bus.log(err.stack ?? err.message, "error");
      this.#memory.tasks.finish(task.id, TASK_STATUS.FAILED, err.message);
    } finally {
      this.#busy = false;
      this.#bus.setState(STATES.IDLE);
    }
  }

  /** Model ↔ nástroje, dokud model nepřestane volat nástroje nebo nedojdou kroky. */
  async #runLoop(model, task) {
    const toolDefs = this.#cfg.features.tools ? this.#tools.definitions() : [];
    const maxSteps = this.#cfg.security.maxToolCallsPerTurn;
    let steps = 0;

    for (;;) {
      this.#bus.setState(STATES.THINKING);

      const response = await model.complete({
        system: this.#systemPrompt(),
        messages: this.#memory.shortTerm.messages(),
        tools: toolDefs,
        maxTokens: this.#cfg.models.maxTokens,
      });

      this.#memory.shortTerm.push("assistant", response.content);

      if (!response.toolCalls.length) {
        return response.text || "Hotovo.";
      }

      if (steps + response.toolCalls.length > maxSteps) {
        return (
          response.text ||
          `Zastavuji se — úkol by potřeboval víc než ${maxSteps} volání nástrojů. ` +
            `Zkus ho rozdělit na menší kroky, nebo zvyš security.maxToolCallsPerTurn.`
        );
      }

      this.#bus.setState(STATES.WORKING);
      const resultBlocks = [];

      for (const call of response.toolCalls) {
        steps++;
        this.#memory.tasks.step(task.id, `${call.name}`);

        const result = await this.#tools.run(call.name, call.input, this.#toolContext());

        resultBlocks.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: !result.ok,
          content: result.ok ? renderResult(result) : `Chyba: ${result.error}`,
        });
      }

      this.#memory.shortTerm.pushToolResults(resultBlocks);
    }
  }

  #toolContext() {
    return {
      cfg: this.#cfg,
      bus: this.#bus,
      memory: this.#memory,
      requestConfirmation: (payload) => this.#requestConfirmation(payload),
    };
  }

  /**
   * Vyžádá si souhlas uživatele a blokuje volání nástroje, dokud nepřijde
   * odpověď z UI (POST /api/confirm) nebo nevyprší časový limit.
   */
  #requestConfirmation(payload) {
    const id = randomUUID();
    const full = { id, ...payload };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingConfirmations.delete(id);
        this.#bus.publish({ type: "confirm_resolved", id, approved: false, reason: "timeout" });
        resolve(false);
      }, this.#cfg.security.confirmTimeoutMs);

      this.#pendingConfirmations.set(id, {
        payload: full,
        settle: (approved) => {
          clearTimeout(timer);
          this.#pendingConfirmations.delete(id);
          this.#bus.publish({ type: "confirm_resolved", id, approved });
          resolve(approved);
        },
      });

      this.#bus.publish({ type: "confirm_request", ...full });
    });
  }

  /** Odpověď z UI na čekající potvrzení. */
  resolveConfirmation(id, approved) {
    const entry = this.#pendingConfirmations.get(id);
    if (!entry) return false;
    entry.settle(Boolean(approved));
    return true;
  }

  #systemPrompt() {
    const { name, persona, language } = this.#cfg.assistant;
    const context = this.#cfg.features.memory ? this.#memory.contextBlock() : "";

    return [
      `Jmenuješ se ${name}. ${persona}`,
      language === "cs" ? "Odpovídáš česky." : "",
      "",
      "Práce s nástroji:",
      "- Když si informaci můžeš ověřit nástrojem, ověř ji. Nehádej obsah souborů ani stav dat.",
      "- Když na odpověď žádný nástroj nepotřebuješ, prostě odpověz.",
      "- Nástroje smíš řetězit: výsledek jednoho použij jako vstup dalšího.",
      "- Nevratné akce si vyžádají potvrzení uživatele. Zamítnutí respektuj a nabídni jinou cestu.",
      "",
      "Odpovědi drž krátké a věcné. Nejdřív výsledek, teprve pak podrobnosti.",
      "Když něco nevyšlo, řekni to rovnou i s tím, co konkrétně selhalo.",
      context ? `\n${context}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

/** Výsledek nástroje pro model — kompaktní JSON, ne prozaický popis. */
function renderResult(result) {
  const payload = { summary: result.summary, ...(result.data ? { data: result.data } : {}) };
  const json = JSON.stringify(payload);
  return json.length > 40_000 ? json.slice(0, 40_000) + "\n…(zkráceno)" : json;
}

function truncate(text, max) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}
