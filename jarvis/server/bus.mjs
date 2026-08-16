/**
 * Event bus + stavový automat asistenta.
 *
 * Ven z agenta jde POUZE bezpečná telemetrie: stav, jaký nástroj běží, status úkolu,
 * výsledek. Interní reasoning modelu se sem záměrně nikdy neposílá.
 */
import { EventEmitter } from "node:events";

export const STATES = Object.freeze({
  IDLE: "IDLE",
  LISTENING: "LISTENING",
  THINKING: "THINKING",
  WORKING: "WORKING",
  SPEAKING: "SPEAKING",
  ERROR: "ERROR",
});

/** Povolené přechody. Do ERROR a IDLE se lze dostat odkudkoli. */
const TRANSITIONS = {
  IDLE: ["LISTENING", "THINKING"],
  LISTENING: ["THINKING", "IDLE"],
  THINKING: ["WORKING", "SPEAKING", "IDLE"],
  WORKING: ["THINKING", "WORKING", "SPEAKING", "IDLE"],
  SPEAKING: ["IDLE", "LISTENING"],
  ERROR: ["IDLE", "LISTENING"],
};

class Bus extends EventEmitter {
  #state = STATES.IDLE;
  #seq = 0;
  #history = [];

  get state() {
    return this.#state;
  }

  /** Posledních N událostí — nový SSE klient je dostane, aby neviděl prázdné UI. */
  get history() {
    return this.#history;
  }

  setState(next, meta = {}) {
    if (!STATES[next]) throw new Error("Neznámý stav: " + next);
    const allowed = next === STATES.ERROR || next === STATES.IDLE || TRANSITIONS[this.#state]?.includes(next);
    if (!allowed) {
      this.emit("event", this.#wrap({ type: "log", level: "warn", text: `Přeskočen přechod ${this.#state} → ${next}` }));
    }
    if (this.#state === next) return;
    this.#state = next;
    this.publish({ type: "state", state: next, ...meta });
  }

  #wrap(payload) {
    const evt = { seq: ++this.#seq, ts: Date.now(), ...payload };
    this.#history.push(evt);
    if (this.#history.length > 200) this.#history.shift();
    return evt;
  }

  /** Jediná cesta, kudy se cokoli dostane do UI. */
  publish(payload) {
    const evt = this.#wrap(payload);
    this.emit("event", evt);
    return evt;
  }

  message(role, text, extra = {}) {
    return this.publish({ type: "message", role, text, ...extra });
  }

  tool(name, status, detail = {}) {
    return this.publish({ type: "tool", name, status, ...detail });
  }

  task(id, title, status, extra = {}) {
    return this.publish({ type: "task", id, title, status, ...extra });
  }

  log(text, level = "info") {
    return this.publish({ type: "log", level, text });
  }
}

export const bus = new Bus();
