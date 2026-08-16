/**
 * Načtení konfigurace. Pořadí (pozdější přebíjí dřívější):
 *   jarvis.config.json  →  jarvis.config.local.json (gitignored)  →  proměnné prostředí
 *
 * Jméno asistenta je čistě konfigurační — nikde v kódu se "JARVIS" natvrdo nevyskytuje.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Hluboké slučování objektů; pole se nahrazují, nespojují. */
function merge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

/**
 * Rozbalí cestu na absolutní.
 *   `~/...`  → domovský adresář
 *   `/...`   → beze změny
 *   ostatní  → relativně k adresáři jarvis/, ne k aktuálnímu pracovnímu adresáři.
 *
 * Poslední pravidlo je záměrné: `".."` tak vždy znamená kořen repozitáře
 * Fx-Analyzeru bez ohledu na to, odkud se server spustí.
 */
export function expandPath(p) {
  if (!p) return p;
  if (p.startsWith("~")) return resolve(join(homedir(), p.slice(1)));
  if (p.startsWith("/")) return resolve(p);
  return resolve(ROOT, p);
}

let cached = null;

export function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;

  let cfg = readJson(join(ROOT, "jarvis.config.json"));
  if (!cfg) throw new Error("Chybí jarvis.config.json v " + ROOT);

  cfg = merge(cfg, readJson(join(ROOT, "jarvis.config.local.json")) ?? {});

  if (process.env.JARVIS_NAME) cfg.assistant.name = process.env.JARVIS_NAME;
  if (process.env.JARVIS_PORT) cfg.server.port = Number(process.env.JARVIS_PORT);
  if (process.env.JARVIS_PROVIDER) cfg.models.provider = process.env.JARVIS_PROVIDER;

  cfg.security.allowedRootsResolved = (cfg.security.allowedRoots || []).map(expandPath);
  cfg.memory.dirResolved = resolve(ROOT, cfg.memory.dir);

  cached = cfg;
  return cfg;
}

/** Konfigurace bezpečná pro odeslání do UI — bez čehokoli tajného. */
export function publicConfig(cfg = loadConfig()) {
  return {
    assistant: cfg.assistant,
    features: cfg.features,
    models: {
      provider: cfg.models.provider,
      roles: Object.fromEntries(
        Object.entries(cfg.models.roles).map(([role, r]) => [role, { provider: r.provider, model: r.model }]),
      ),
    },
    tools: cfg.tools,
    security: {
      allowedRoots: cfg.security.allowedRoots,
      confirmDestructive: cfg.security.confirmDestructive,
      maxToolCallsPerTurn: cfg.security.maxToolCallsPerTurn,
    },
  };
}
