/**
 * READ_FILE — čtení textového souboru s tvrdým stropem na velikost,
 * aby jeden velký soubor nezaplavil kontext modelu.
 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { assertPathAllowed, LEVELS } from "../permissions.mjs";

/** Přípony, u kterých nemá smysl posílat obsah modelu. */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
  ".zip", ".gz", ".tar", ".mp3", ".mp4", ".wav", ".woff", ".woff2",
]);

export default {
  name: "filesystem.read_file",
  description:
    "Přečte obsah textového souboru (kód, JSON, markdown, konfigurace, log). " +
    "Použij, když potřebuješ vidět, co v souboru skutečně je, než na něj odpovíš. " +
    "Binární soubory nečte a velké soubory vrací zkrácené.",

  permissions: { level: LEVELS.READ, destructive: false },

  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Cesta k souboru. Podporuje ~ pro domovský adresář." },
      maxBytes: {
        type: "integer",
        description: "Strop pro počet přečtených bajtů; výchozí hodnota je v konfiguraci.",
        minimum: 1,
      },
    },
    required: ["path"],
  },

  async execute({ path, maxBytes }, { cfg }) {
    const file = assertPathAllowed(path, cfg);

    const info = await stat(file);
    if (info.isDirectory()) throw new Error(`"${path}" je adresář — použij filesystem.list_files.`);

    const ext = extname(file).toLowerCase();
    if (BINARY_EXT.has(ext)) {
      throw new Error(`"${ext}" je binární formát, obsah nelze přečíst jako text.`);
    }

    const cap = Math.min(maxBytes ?? cfg.security.maxFileBytes, cfg.security.maxFileBytes);
    const buffer = await readFile(file);
    const truncated = buffer.length > cap;
    const content = buffer.subarray(0, cap).toString("utf8");

    return {
      summary:
        `${file} — ${info.size} B${truncated ? `, zobrazeno prvních ${cap} B` : ""}, ` +
        `${content.split("\n").length} řádků`,
      data: { path: file, bytes: info.size, truncated, content },
    };
  },
};
