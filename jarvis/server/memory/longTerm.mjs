/**
 * Long-term memory — preference, fakta, projekty a pravidla, která mají přežít restart.
 *
 * Úložiště je záměrně triviální JSON soubor. Rozhraní (`remember` / `all` / `forget`)
 * je stabilní, takže výměna za SQLite nebo vektorovou databázi je změna jednoho souboru.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const KINDS = ["preference", "fact", "project", "rule"];

export class LongTermMemory {
  #file;
  #items = [];

  constructor({ dir }) {
    mkdirSync(dir, { recursive: true });
    this.#file = join(dir, "long-term.json");
    if (existsSync(this.#file)) {
      try {
        this.#items = JSON.parse(readFileSync(this.#file, "utf8"));
      } catch {
        this.#items = [];
      }
    }
  }

  remember(kind, text) {
    if (!KINDS.includes(kind)) throw new Error(`Neznámý druh paměti: ${kind}`);
    const item = { id: randomUUID(), kind, text, createdAt: new Date().toISOString() };
    this.#items.push(item);
    this.#flush();
    return item;
  }

  forget(id) {
    const before = this.#items.length;
    this.#items = this.#items.filter((i) => i.id !== id);
    if (this.#items.length !== before) this.#flush();
    return before !== this.#items.length;
  }

  all(kind) {
    return kind ? this.#items.filter((i) => i.kind === kind) : [...this.#items];
  }

  #flush() {
    writeFileSync(this.#file, JSON.stringify(this.#items, null, 2));
  }

  stats() {
    return {
      count: this.#items.length,
      byKind: Object.fromEntries(KINDS.map((k) => [k, this.#items.filter((i) => i.kind === k).length])),
    };
  }
}
