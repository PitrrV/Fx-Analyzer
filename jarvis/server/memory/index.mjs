/**
 * Memory manager — tři oddělené vrstvy s vlastní životností.
 *
 *   SHORT-TERM  aktuální konverzace, ring buffer, jen v paměti procesu
 *   LONG-TERM   preference, fakta, projekty, pravidla — na disku, přežije restart
 *   TASK        co běží / co doběhlo / co selhalo — v paměti, projekce do UI
 *
 * Každá vrstva je samostatný modul; přidání další (vektorová, epizodická) znamená
 * jen nový soubor a jeden řádek tady.
 */
import { ShortTermMemory } from "./shortTerm.mjs";
import { LongTermMemory } from "./longTerm.mjs";
import { TaskMemory } from "./taskMemory.mjs";

export function createMemory(cfg, bus) {
  const shortTerm = new ShortTermMemory({ maxTurns: cfg.memory.shortTermTurns });
  const longTerm = new LongTermMemory({ dir: cfg.memory.dirResolved });
  const tasks = new TaskMemory({ bus });

  return {
    shortTerm,
    longTerm,
    tasks,

    /** Kompaktní kontextový blok, který se vkládá do system promptu. */
    contextBlock() {
      const facts = longTerm.all();
      const running = tasks.running();
      const parts = [];

      if (facts.length) {
        parts.push(
          "Dlouhodobý kontext o uživateli:\n" +
            facts.map((f) => `- [${f.kind}] ${f.text}`).join("\n"),
        );
      }
      if (running.length) {
        parts.push("Právě běžící úkoly:\n" + running.map((t) => `- ${t.title}`).join("\n"));
      }
      return parts.join("\n\n");
    },

    snapshot() {
      return {
        shortTerm: shortTerm.stats(),
        longTerm: longTerm.stats(),
        tasks: tasks.stats(),
      };
    },
  };
}
