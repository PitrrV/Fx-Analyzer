/**
 * Tool registry — jediné místo, kde se nástroje registrují, filtrují configem
 * a spouštějí.
 *
 * Kontrakt nástroje (viz kterýkoli soubor v tools/*):
 *   name         "namespace.akce"
 *   description  text, podle kterého se model rozhoduje, kdy nástroj sáhne
 *   inputSchema  JSON Schema vstupu (posílá se modelu i validátoru)
 *   permissions  { level, destructive }
 *   execute(input, ctx) → { summary, data }   nebo hodí chybu
 *
 * Přidání nástroje = nový soubor + jeden řádek v `MODULES` + zápis do
 * `tools.enabled` v jarvis.config.json. Nic jiného se nemění.
 */
import { validate } from "./schema.mjs";
import { needsConfirmation, describePermissions, PermissionError } from "./permissions.mjs";

import listFiles from "./filesystem/list_files.mjs";
import readFile from "./filesystem/read_file.mjs";
import openPath from "./system/open_path.mjs";
import fxStatus from "./fx_analyzer/status.mjs";

/** Všechny známé nástroje. Zapnutí řídí config, ne tento seznam. */
const MODULES = [listFiles, readFile, openPath, fxStatus];

export class ToolRegistry {
  #tools = new Map();
  #cfg;

  constructor(cfg) {
    this.#cfg = cfg;
    for (const tool of MODULES) this.#register(tool);
  }

  #register(tool) {
    for (const field of ["name", "description", "inputSchema", "execute"]) {
      if (!tool?.[field]) throw new Error(`Nástroj postrádá povinné pole "${field}": ${tool?.name ?? "?"}`);
    }
    if (this.#tools.has(tool.name)) throw new Error(`Duplicitní nástroj: ${tool.name}`);
    this.#tools.set(tool.name, tool);
  }

  #isEnabled(name) {
    const { enabled = [], disabled = [] } = this.#cfg.tools;
    if (disabled.includes(name)) return false;
    return enabled.length === 0 || enabled.includes(name);
  }

  get(name) {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Neznámý nástroj: ${name}`);
    if (!this.#isEnabled(name)) throw new PermissionError(`Nástroj "${name}" je vypnutý v konfiguraci.`);
    return tool;
  }

  enabled() {
    return [...this.#tools.values()].filter((t) => this.#isEnabled(t.name));
  }

  /** Přehled pro UI — včetně vypnutých, aby bylo vidět, co je k dispozici. */
  catalog() {
    return [...this.#tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      enabled: this.#isEnabled(t.name),
      permissions: describePermissions(t),
      needsConfirmation: needsConfirmation(t, this.#cfg),
    }));
  }

  /** Definice ve tvaru, který přebírá model provider. */
  definitions() {
    return this.enabled().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  /**
   * Spustí nástroj: validace vstupu → případné potvrzení → provedení.
   * Chyby nikdy nevyhazuje ven — vrací je jako `{ ok:false }`, protože model
   * musí chybu dostat zpátky jako tool_result a umět na ni zareagovat.
   *
   * @param ctx { cfg, bus, memory, requestConfirmation(payload) → Promise<boolean> }
   */
  async run(name, rawInput, ctx) {
    const started = Date.now();
    try {
      const tool = this.get(name);

      const parsed = validate(tool.inputSchema, rawInput);
      if (!parsed.ok) {
        return this.#fail(name, `Neplatný vstup: ${parsed.errors.join("; ")}`, started);
      }

      if (needsConfirmation(tool, this.#cfg)) {
        const approved = await ctx.requestConfirmation({
          tool: tool.name,
          input: parsed.value,
          question: tool.confirmPrompt?.(parsed.value) ?? `Spustit ${tool.name}?`,
        });
        if (!approved) {
          return this.#fail(name, "Uživatel akci nepotvrdil.", started, { status: "denied" });
        }
      }

      ctx.bus.tool(name, "running", { input: parsed.value });
      const result = await tool.execute(parsed.value, ctx);

      const payload = {
        ok: true,
        name,
        summary: result?.summary ?? "Hotovo.",
        data: result?.data ?? null,
        ms: Date.now() - started,
      };
      ctx.bus.tool(name, "ok", { summary: payload.summary, ms: payload.ms });
      return payload;
    } catch (err) {
      return this.#fail(name, err.message ?? String(err), started, {}, ctx);
    }
  }

  #fail(name, message, started, extra = {}, ctx = null) {
    const payload = { ok: false, name, error: message, ms: Date.now() - started, ...extra };
    ctx?.bus.tool(name, extra.status ?? "error", { summary: message, ms: payload.ms });
    return payload;
  }
}
