/**
 * OPEN_PATH — otevře složku nebo soubor ve výchozí aplikaci systému.
 *
 * Označen jako `destructive: true` schválně: spouští externí proces, tedy má
 * účinek mimo agenta. Slouží zároveň jako živá ukázka potvrzovacího toku —
 * orchestrátor se před spuštěním musí zeptat a počkat na souhlas.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import { assertPathAllowed, LEVELS } from "../permissions.mjs";

const run = promisify(execFile);

/**
 * Otevírací příkaz podle platformy. Cesta se předává jako samostatný argument
 * pole, nikdy ne jako součást shell příkazu — proto tu žádné escapování ani
 * shell injection řešit nemusíme.
 */
const OPENERS = {
  darwin: (target) => ["open", [target]],
  win32: (target) => ["cmd", ["/c", "start", "", target]],
  linux: (target) => ["xdg-open", [target]],
};

export default {
  name: "system.open_path",
  description:
    "Otevře soubor nebo složku ve výchozí aplikaci operačního systému (správce souborů, " +
    "editor, prohlížeč). Použij, když uživatel chce něco 'otevřít' nebo 'ukázat' na obrazovce. " +
    "Akce spouští externí program, takže si vždy vyžádá potvrzení.",

  permissions: { level: LEVELS.EXECUTE, destructive: true },

  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Cesta k souboru nebo složce, kterou otevřít." },
    },
    required: ["path"],
  },

  confirmPrompt: ({ path }) => `Otevřít "${path}" ve výchozí aplikaci systému?`,

  async execute({ path }, { cfg }) {
    const target = assertPathAllowed(path, cfg);

    const opener = OPENERS[platform()];
    if (!opener) throw new Error(`Otevírání cest není na platformě "${platform()}" podporováno.`);

    const [cmd, args] = opener(target);
    await run(cmd, args, { timeout: 10_000 });

    return { summary: `Otevřeno: ${target}`, data: { path: target, opener: cmd } };
  },
};
