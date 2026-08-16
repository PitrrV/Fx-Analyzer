/**
 * Task memory — co agent právě dělá, co dokončil a co selhalo.
 *
 * Každá změna se publikuje na bus, takže panel úkolů v UI je jen projekce téhle
 * struktury; UI nemá vlastní stav úkolů, který by mohl utéct.
 */
import { randomUUID } from "node:crypto";

export const TASK_STATUS = Object.freeze({
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
});

export class TaskMemory {
  #tasks = new Map();
  #bus;

  constructor({ bus }) {
    this.#bus = bus;
  }

  start(title) {
    const task = {
      id: randomUUID(),
      title,
      status: TASK_STATUS.RUNNING,
      steps: [],
      startedAt: Date.now(),
      endedAt: null,
    };
    this.#tasks.set(task.id, task);
    this.#emit(task);
    return task;
  }

  step(id, text) {
    const task = this.#tasks.get(id);
    if (!task) return;
    task.steps.push({ text, ts: Date.now() });
    this.#emit(task);
  }

  finish(id, status = TASK_STATUS.DONE, summary = "") {
    const task = this.#tasks.get(id);
    if (!task) return;
    task.status = status;
    task.summary = summary;
    task.endedAt = Date.now();
    this.#emit(task);
  }

  #emit(task) {
    this.#bus?.task(task.id, task.title, task.status, {
      steps: task.steps.map((s) => s.text),
      summary: task.summary ?? "",
    });
  }

  running() {
    return [...this.#tasks.values()].filter((t) => t.status === TASK_STATUS.RUNNING);
  }

  all() {
    return [...this.#tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  stats() {
    const all = this.all();
    return {
      total: all.length,
      running: all.filter((t) => t.status === TASK_STATUS.RUNNING).length,
      done: all.filter((t) => t.status === TASK_STATUS.DONE).length,
      failed: all.filter((t) => t.status === TASK_STATUS.FAILED).length,
    };
  }
}
