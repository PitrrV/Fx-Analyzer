/**
 * Bezpečnostní vrstva tool layeru.
 *
 * Dvě nezávislá pravidla, obě povinná:
 *   1. Cesta — každá cesta, se kterou nástroj pracuje, musí ležet uvnitř
 *      některého z `security.allowedRoots`. Kontroluje se až kanonická cesta
 *      (po realpath), takže symlink ven z povoleného stromu neprojde.
 *   2. Potvrzení — nevratná nebo výstupní akce (`destructive: true`) se nikdy
 *      neprovede sama; orchestrátor si vyžádá souhlas uživatele a čeká na něj.
 */
import { realpathSync } from "node:fs";
import { resolve, sep, dirname } from "node:path";
import { expandPath } from "../config.mjs";

export const LEVELS = Object.freeze({
  READ: "read",
  WRITE: "write",
  EXECUTE: "execute",
  NETWORK: "network",
});

export class PermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermissionError";
  }
}

/**
 * Ověří, že cesta leží uvnitř povoleného stromu, a vrátí ji kanonicky rozbalenou.
 * Pro dosud neexistující cestu (zápis nového souboru) se ověřuje nejbližší
 * existující rodič — jinak by nešlo nikdy nic vytvořit.
 */
export function assertPathAllowed(inputPath, cfg) {
  const roots = cfg.security.allowedRootsResolved ?? [];
  if (!roots.length) throw new PermissionError("Nejsou nastavené žádné povolené kořeny (security.allowedRoots).");

  const requested = resolve(expandPath(inputPath));
  const canonical = canonicalize(requested);

  const inside = roots.some((root) => {
    const canonicalRoot = canonicalize(root);
    return canonical === canonicalRoot || canonical.startsWith(canonicalRoot + sep);
  });

  if (!inside) {
    throw new PermissionError(
      `Cesta "${inputPath}" je mimo povolené adresáře. Povoleno: ${cfg.security.allowedRoots.join(", ")}`,
    );
  }
  return canonical;
}

/** Rozbalí symlinky co nejdál to jde; u neexistující cesty rozbalí nejbližšího rodiče. */
function canonicalize(p) {
  let current = resolve(p);
  const suffix = [];

  for (;;) {
    try {
      return resolve(realpathSync(current), ...suffix);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(p); // došli jsme ke kořeni
      suffix.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

/** Rozhodne, jestli volání nástroje potřebuje explicitní souhlas uživatele. */
export function needsConfirmation(tool, cfg) {
  if (!cfg.security.confirmDestructive) return false;
  return Boolean(tool.permissions?.destructive);
}

/** Krátký lidský popis oprávnění pro UI. */
export function describePermissions(tool) {
  const p = tool.permissions ?? {};
  const parts = [p.level ?? LEVELS.READ];
  if (p.destructive) parts.push("vyžaduje potvrzení");
  return parts.join(" · ");
}
