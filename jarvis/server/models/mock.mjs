/**
 * Mock provider — deterministický náhradník bez API klíče a bez sítě.
 *
 * Není to model. Je to pravidlový rozpoznávač záměru v češtině, jehož jediný účel
 * je udržet celý řetěz spustitelný a testovatelný:
 *
 *     USER → orchestrátor → TOOL → počítač → RESULT → UI
 *
 * Dodržuje stejný kontrakt jako Anthropic provider (`complete()` vrací `text`,
 * `toolCalls` a `content`), takže orchestrátor mezi nimi nerozlišuje. Až bude
 * nastavený ANTHROPIC_API_KEY, tenhle soubor se přestane používat sám od sebe.
 */
import { randomUUID } from "node:crypto";

/** Vzory se zkoušejí shora dolů; první shoda vyhrává. */
const INTENTS = [
  {
    id: "list_files",
    test: /(vypiš|ukaž|zobraz|co je|obsah|seznam|projdi)\s+.*(soubor|složk|adresář|slozk)/i,
    build: (text) => ({ name: "filesystem.list_files", input: { path: extractPath(text) ?? ".." } }),
  },
  {
    id: "read_file",
    test: /(přečti|precti|otevři obsah|co je v souboru|ukaž obsah|zobraz soubor)/i,
    build: (text) => {
      const path = extractPath(text);
      return path ? { name: "filesystem.read_file", input: { path } } : null;
    },
  },
  {
    id: "open_path",
    test: /(otevři|otevri|spusť|spust)\s+(mi\s+)?(složk|slozk|adresář|soubor|projekt|analyzer|analyzér)/i,
    build: (text) => ({ name: "system.open_path", input: { path: extractPath(text) ?? ".." } }),
  },
  {
    id: "fx_status",
    test: /(fx|analyzer|analyzér|trh|market|sentiment|cot|kalendář|kalendar|data)/i,
    build: () => ({ name: "fx_analyzer.status", input: {} }),
  },
];

export async function createMockProvider({ cfg, role }) {
  const name = cfg.assistant.name;

  return {
    role,
    model: "mock",

    async complete({ messages, tools = [] }) {
      const enabled = new Set(tools.map((t) => t.name));
      const last = messages.at(-1);

      // Druhý průchod: v historii už jsou výsledky nástrojů → shrň je a skonči.
      const toolResults = Array.isArray(last?.content)
        ? last.content.filter((b) => b.type === "tool_result")
        : [];
      if (toolResults.length) {
        return finalAnswer(summarizeResults(toolResults));
      }

      const text = extractText(last);
      if (!text) return finalAnswer(`Poslouchám. Řekni, co mám udělat.`);

      for (const intent of INTENTS) {
        if (!intent.test.test(text)) continue;
        const call = intent.build(text);
        if (!call || !enabled.has(call.name)) continue;

        return {
          text: "",
          toolCalls: [{ id: `mock_${randomUUID()}`, name: call.name, input: call.input }],
          content: [{ type: "tool_use", id: `mock_${randomUUID()}`, name: call.name, input: call.input }],
          stopReason: "tool_use",
          usage: null,
        };
      }

      if (/^(ahoj|čau|cau|dobrý den|hej|zdravím)\b/i.test(text) || new RegExp(`^${name}\\b`, "i").test(text)) {
        return finalAnswer("Poslouchám.");
      }
      if (/(kdo jsi|jak se jmenuješ|co umíš|pomoc|help)/i.test(text)) {
        return finalAnswer(capabilitiesText(name, tools));
      }

      return finalAnswer(
        `Běžím v režimu mock — bez jazykového modelu, takže rozumím jen několika typům příkazů. ` +
          `Nastav ANTHROPIC_API_KEY a spusť npm install, a začnu rozumět souvislé češtině.\n\n` +
          capabilitiesText(name, tools),
      );
    },
  };
}

function finalAnswer(text) {
  return { text, toolCalls: [], content: [{ type: "text", text }], stopReason: "end_turn", usage: null };
}

function extractText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ");
}

/** Vytáhne z věty cestu — cokoli s lomítkem, tildou nebo tečkou v názvu. */
function extractPath(text) {
  const match = text.match(/(~?[\w.\-/]*[/][\w.\-/]*|~[\w.\-/]*|\b[\w-]+\.[a-z]{1,5}\b)/i);
  return match?.[0] ?? null;
}

/**
 * Shrnutí výsledků nástrojů. Skutečný model tohle udělá sám a mnohem líp;
 * tady jde jen o to nevysypat uživateli do konverzace surové JSON.
 */
function summarizeResults(blocks) {
  return blocks
    .map((b) => {
      const raw = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      if (b.is_error) return `Nepovedlo se: ${raw}`;

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return raw;
      }

      const lines = [parsed.summary ?? "Hotovo."];
      const items = parsed.data?.items;
      const sources = parsed.data?.sources;

      if (Array.isArray(items)) {
        lines.push(...items.slice(0, 20).map((i) => `  ${i.type === "dir" ? "▸" : " "} ${i.name}`));
      } else if (Array.isArray(sources)) {
        lines.push(
          ...sources.map((s) =>
            s.available
              ? `  • ${s.label}: ${s.coverage ?? "k dispozici"}${s.ageHours != null ? ` (stáří ${s.ageHours} h)` : ""}`
              : `  • ${s.label}: nedostupné`,
          ),
        );
      } else if (typeof parsed.data?.content === "string") {
        lines.push("", parsed.data.content.slice(0, 1500));
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

function capabilitiesText(name, tools) {
  const list = tools.length
    ? tools.map((t) => `  • ${t.name}`).join("\n")
    : "  (žádné nástroje nejsou zapnuté)";
  return `Jsem ${name}. V tomhle režimu zvládnu:\n${list}\n\nZkus třeba: „vypiš soubory ve složce ..“ nebo „jaká jsou FX data".`;
}
