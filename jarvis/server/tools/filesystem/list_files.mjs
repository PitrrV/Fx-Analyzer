/**
 * LIST_FILES — první testovací nástroj, který ověřuje celý řetěz
 * USER → AI → TOOL → POČÍTAČ → RESULT → UI.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { assertPathAllowed, LEVELS } from "../permissions.mjs";

export default {
  name: "filesystem.list_files",
  description:
    "Vypíše obsah adresáře na disku (soubory a podadresáře, s velikostí a časem změny). " +
    "Použij, když má uživatel zjistit, co ve složce je, najít soubor podle jména, nebo se " +
    "zorientovat ve struktuře projektu. Čte pouze adresáře uvnitř povolených kořenů.",

  permissions: { level: LEVELS.READ, destructive: false },

  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Cesta k adresáři. Podporuje ~ pro domovský adresář.",
      },
      pattern: {
        type: "string",
        description: "Nepovinný filtr podle podřetězce v názvu (bez rozlišení velikosti písmen).",
      },
      limit: {
        type: "integer",
        description: "Maximální počet položek ve výpisu.",
        default: 100,
        minimum: 1,
        maximum: 1000,
      },
    },
    required: ["path"],
  },

  async execute({ path, pattern, limit }, { cfg }) {
    const dir = assertPathAllowed(path, cfg);

    const info = await stat(dir);
    if (!info.isDirectory()) throw new Error(`"${path}" není adresář.`);

    let entries = await readdir(dir, { withFileTypes: true });
    if (pattern) {
      const needle = pattern.toLowerCase();
      entries = entries.filter((e) => e.name.toLowerCase().includes(needle));
    }

    const total = entries.length;
    entries = entries.slice(0, limit);

    const items = await Promise.all(
      entries.map(async (e) => {
        const base = { name: e.name, type: e.isDirectory() ? "dir" : "file" };
        try {
          const s = await stat(join(dir, e.name));
          return { ...base, size: s.size, modified: s.mtime.toISOString() };
        } catch {
          return { ...base, size: null, modified: null };
        }
      }),
    );

    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));

    const shown = items.length;
    return {
      summary:
        `${dir}: ${shown} z ${total} položek` +
        (pattern ? ` (filtr "${pattern}")` : "") +
        (shown < total ? " — výpis zkrácen" : ""),
      data: { path: dir, total, shown, items },
    };
  },
};
