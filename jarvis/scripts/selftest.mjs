/**
 * Selftest — ověří celý řetěz USER → AI → TOOL → POČÍTAČ → RESULT
 * bez prohlížeče, bez sítě a bez API klíče.
 *
 *   node scripts/selftest.mjs
 */
import { loadConfig } from "../server/config.mjs";
import { bus } from "../server/bus.mjs";
import { createMemory } from "../server/memory/index.mjs";
import { ToolRegistry } from "../server/tools/registry.mjs";
import { createModelRegistry } from "../server/models/registry.mjs";
import { Orchestrator } from "../server/orchestrator.mjs";
import { assertPathAllowed, PermissionError } from "../server/tools/permissions.mjs";
import { validate } from "../server/tools/schema.mjs";

let failures = 0;

function check(name, condition, detail = "") {
  const mark = condition ? "  ok  " : " FAIL ";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

// Provider natvrdo na mock, ať je test deterministický a nic nestojí.
process.env.JARVIS_PROVIDER = "mock";

const cfg = loadConfig();
const memory = createMemory(cfg, bus);
const tools = new ToolRegistry(cfg);
const models = await createModelRegistry(cfg, bus);
const orchestrator = new Orchestrator({ cfg, bus, memory, tools, models });

console.log("\n── konfigurace ────────────────────────────────");
check("jméno asistenta je konfigurovatelné", typeof cfg.assistant.name === "string" && cfg.assistant.name.length > 0, cfg.assistant.name);
check("povolené kořeny jsou absolutní", cfg.security.allowedRootsResolved.every((p) => p.startsWith("/")));

console.log("\n── validace vstupu ────────────────────────────");
check("chybějící povinné pole se odmítne", validate({ type: "object", properties: { p: { type: "string" } }, required: ["p"] }, {}).ok === false);
check("výchozí hodnota se doplní", validate({ type: "object", properties: { n: { type: "integer", default: 7 } } }, {}).value.n === 7);
check("špatný typ se odmítne", validate({ type: "object", properties: { n: { type: "integer" } } }, { n: "x" }).ok === false);

console.log("\n── oprávnění ──────────────────────────────────");
check("cesta uvnitř povoleného kořene projde", Boolean(assertPathAllowed(cfg.security.allowedRoots[0], cfg)));
check(
  "cesta mimo povolené kořeny se zablokuje",
  await (async () => {
    try {
      assertPathAllowed("/etc", cfg);
      return false;
    } catch (e) {
      return e instanceof PermissionError;
    }
  })(),
);
check(
  "únik přes .. se zablokuje",
  await (async () => {
    try {
      assertPathAllowed(`${cfg.security.allowedRoots[0]}/../../../etc`, cfg);
      return false;
    } catch (e) {
      return e instanceof PermissionError;
    }
  })(),
);

console.log("\n── registr nástrojů ───────────────────────────");
const catalog = tools.catalog();
check("nástroje jsou registrované", catalog.length >= 4, `${catalog.length} nástrojů`);
check("definice mají tvar pro model", tools.definitions().every((d) => d.name && d.description && d.input_schema));
check("destruktivní nástroj vyžaduje potvrzení", catalog.find((t) => t.name === "system.open_path")?.needsConfirmation === true);

console.log("\n── běh nástroje ───────────────────────────────");
const ctx = { cfg, bus, memory, requestConfirmation: async () => true };

const listing = await tools.run("filesystem.list_files", { path: cfg.security.allowedRoots[0], limit: 5 }, ctx);
check("list_files uspěl", listing.ok, listing.summary ?? listing.error);
check("list_files vrátil položky", (listing.data?.items?.length ?? 0) > 0);

const blocked = await tools.run("filesystem.read_file", { path: "/etc/hosts" }, ctx);
check("read_file mimo kořeny selže", blocked.ok === false, blocked.error);

const fx = await tools.run("fx_analyzer.status", {}, ctx);
check("fx_analyzer.status uspěl", fx.ok, fx.summary ?? fx.error);
check("fx_analyzer našel datové zdroje", (fx.data?.sources ?? []).some((s) => s.available));

console.log("\n── potvrzovací tok ────────────────────────────");
const denied = await tools.run("system.open_path", { path: cfg.security.allowedRoots[0] }, { ...ctx, requestConfirmation: async () => false });
check("zamítnutí zastaví nevratnou akci", denied.ok === false && denied.status === "denied");

console.log("\n── celá smyčka orchestrátoru ──────────────────");
const seen = [];
bus.on("event", (e) => seen.push(e));

await orchestrator.handleInput(`vypiš soubory ve složce ${cfg.security.allowedRoots[0]}`);

const states = seen.filter((e) => e.type === "state").map((e) => e.state);
const toolEvents = seen.filter((e) => e.type === "tool");
const replies = seen.filter((e) => e.type === "message" && e.role === "assistant");

check("agent prošel stavem THINKING", states.includes("THINKING"), states.join(" → "));
check("agent prošel stavem WORKING", states.includes("WORKING"));
check("agent zavolal nástroj", toolEvents.some((e) => e.name === "filesystem.list_files"));
check("agent skončil odpovědí", replies.length > 0);
check("agent se vrátil do IDLE", states.at(-1) === "IDLE");
check("úkol je zaznamenán jako dokončený", memory.tasks.stats().done === 1);

console.log("\n── paměť ──────────────────────────────────────");
memory.longTerm.remember("preference", "Testovací preference ze selftestu.");
check("long-term paměť ukládá", memory.longTerm.all("preference").length > 0);
check("kontextový blok se skládá", memory.contextBlock().includes("Testovací preference"));
memory.longTerm.all("preference").forEach((i) => memory.longTerm.forget(i.id));

console.log(
  failures === 0
    ? "\n✓ Všechny kontroly prošly.\n"
    : `\n✗ ${failures} kontrol selhalo.\n`,
);
process.exit(failures === 0 ? 0 : 1);
