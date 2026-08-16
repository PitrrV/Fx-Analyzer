# Osobní AI agent — Milestone 1

Základ osobního AI agenta: orchestrace, tool layer, memory, stavový model a HUD rozhraní.
Pracovní jméno je **JARVIS**, ale nikde v kódu není natvrdo — mění se jedním řádkem
v `jarvis.config.json`.

Tohle je **první funkční základ**, ne hotový asistent. Co existuje, funguje doopravdy.
Co neexistuje, má připravené místo a je to napsané níž.

---

## Spuštění

```bash
cd jarvis
node server/index.mjs          # → http://127.0.0.1:4177
```

Běží bez `npm install` a bez API klíče — spadne do režimu `mock` (pravidlový rozpoznávač
záměru, ne jazykový model), takže celý řetěz jde vyzkoušet hned.

Pro skutečný model:

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
node server/index.mjs
```

Kontrola, že všechno drží pohromadě:

```bash
node scripts/selftest.mjs      # 24 kontrol, bez sítě a bez API klíče
```

Zkus v rozhraní: `vypiš soubory ve složce ..` · `jaká jsou FX data` · `otevři složku ..`
(poslední si vyžádá potvrzení).

---

## Architektura

```
   UŽIVATEL
      │  text  (hlas: rozhraní hotové, převodníky ne)
      ▼
   ORCHESTRÁTOR ──────────────► MEMORY
   agentní smyčka               short-term · long-term · task
      │
      │  model rozhodne: odpovědět / nástroj / několik nástrojů za sebou
      ▼
   MODEL LAYER              anthropic │ mock        role: primary·fast·coding·secondary
      │
      ▼
   TOOL LAYER               schema → permissions → potvrzení → běh
      │
      ▼
   filesystem │ system │ fx_analyzer │ tradingview (místo připraveno)
      │
      ▼
   EVENT BUS ──► SSE ──► HUD        stav · nástroj · úkol · výsledek
```

Rozhodnutí „stačí odpovědět, nebo sáhnout po nástroji?" **nedělá kód** — dělá ho model.
Dostane katalog nástrojů a volí sám. Orchestrátor jen drží smyčku, aby šlo promítat stav
do UI, zastavit se před nevratnou akcí a omezit počet kroků.

### Vrstvy

| Vrstva | Soubor | Co řeší |
|---|---|---|
| Konfigurace | `server/config.mjs` | jméno, modely, funkce, bezpečnost; `.local` přepis + proměnné prostředí |
| Event bus | `server/bus.mjs` | stavový automat + jediný kanál do UI |
| Orchestrátor | `server/orchestrator.mjs` | agentní smyčka, potvrzování, limity |
| Model layer | `server/models/` | role → poskytovatel; výměna modelu bez zásahu do kódu |
| Tool layer | `server/tools/` | registry, JSON Schema validace, oprávnění |
| Memory | `server/memory/` | tři oddělené vrstvy s vlastní životností |
| Hlas | `server/voice/` | rozhraní a stavy; STT/TTS zatím ne |
| HUD | `ui/` | konzole bez build kroku |

---

## Stavy

Jediný zdroj pravdy je `bus.mjs`; UI je jeho projekce. Barva celého rozhraní se odvozuje
od aktuálního stavu.

| Stav | Význam |
|---|---|
| `IDLE` | připraven |
| `LISTENING` | naslouchá (hlasový vstup) |
| `THINKING` | zpracovává požadavek |
| `WORKING` | používá nástroje |
| `SPEAKING` | odpovídá |
| `ERROR` | něco selhalo |

**Do UI jde jen bezpečná telemetrie** — stav, jméno nástroje, průběh úkolu, výsledek.
Interní reasoning modelu se nikam nepublikuje; provider odesílá pouze finální textové delty.

---

## Nástroje

| Nástroj | Oprávnění | Co dělá |
|---|---|---|
| `filesystem.list_files` | read | výpis adresáře |
| `filesystem.read_file` | read | čtení textového souboru se stropem na velikost |
| `system.open_path` | execute · **potvrzení** | otevře cestu ve výchozí aplikaci OS |
| `fx_analyzer.status` | read | dostupnost a čerstvost dat FX Analyzeru |

### Přidání nástroje

1. nový soubor podle kontraktu (`name` / `description` / `inputSchema` / `permissions` / `execute`),
2. jeden řádek v poli `MODULES` v `server/tools/registry.mjs`,
3. název do `tools.enabled` v `jarvis.config.json`.

Nic jiného se nemění. `inputSchema` slouží zároveň jako validace vstupu i jako definice
posílaná modelu — jediný zdroj pravdy.

---

## Bezpečnost

Dvě nezávislá pravidla, obě povinná:

**Cesty** — každá cesta musí ležet uvnitř `security.allowedRoots`. Kontroluje se až
kanonická cesta po rozbalení symlinků, takže `..` ani symlink ven z povoleného stromu
neprojde. (Ověřeno v selftestu.)

**Potvrzení** — nástroj označený `destructive: true` se nikdy nespustí sám. Orchestrátor
zablokuje volání, pošle dotaz do UI a čeká na souhlas nebo timeout. Zamítnutí se modelu
vrátí jako výsledek nástroje, takže na něj umí reagovat a nabídnout jinou cestu.

Navíc: strop na počet volání nástrojů v jednom tahu, strop na velikost čteného souboru,
server poslouchá jen na `127.0.0.1`.

---

## Modely

Role místo natvrdo zadaného modelu. Výměna = úprava `jarvis.config.json`, ne kódu.

| Role | Kdy |
|---|---|
| `primary` | běžná konverzace a agentní práce |
| `fast` | krátké a latencí citlivé úkoly |
| `coding` | práce s kódem |
| `secondary` | levnější varianta pro objemné operace |

`provider: "auto"` zvolí Anthropic, pokud je klíč i SDK; jinak spadne na `mock` a řekne to
v UI i v logu. Přidání dalšího poskytovatele je nový soubor v `server/models/` a jeden
řádek v `FACTORIES`.

---

## Memory

| Vrstva | Životnost | Obsah |
|---|---|---|
| short-term | proces | aktuální konverzace (ring buffer) |
| long-term | disk | preference, fakta, projekty, pravidla |
| task | proces | co běží / doběhlo / selhalo |

Long-term je zatím JSON soubor. Rozhraní (`remember` / `all` / `forget`) je stabilní, takže
výměna za SQLite nebo vektorovou databázi je změna jednoho souboru.

---

## Co ještě není — a proč

**Hlas.** Rozhraní, stavy i tok jsou hotové (`server/voice/adapter.mjs`): wake word →
`LISTENING`, STT → `handleInput()`, `SPEAKING` → TTS, `interrupt()` kdykoli. Chybí samotné
převodníky. Až se doplní, orchestrátor se nemění — hlas je jen další vstup do stejné
funkce jako text.

**FX Analyzer.** `fx_analyzer.status` čte reálná data a hlásí jejich dostupnost a stáří.
Vědomě **neinterpretuje skóre**. Interpretace vyžaduje, aby agent rozuměl scoring systému
(`scoreCurrency`, `calcConvictionScore`, `rankPairs`, `buildForecastV5` v `engine.js`),
jeho vahám a hlavně jeho omezením. To je samostatná fáze — vymyšlené číslo je horší než
žádné. Cíl není „spusť Analyzer", ale „rozuměj jeho výstupům".

**TradingView.** Neimplementováno záměrně. Rozbor otevřených otázek (přístup k datům,
reprezentace zón, konfluence s fundamentem) je v `server/tools/tradingview/README.md`.
Pořadí prací: FX Analyzer napřed, TradingView potom.

**Ovládání počítače.** Zatím čtení souborů a otevírání cest. Zápis, přesun a mazání jsou
další krok — dorazí až s potvrzovacím tokem prověřeným v praxi a se zálohou před přepisem.

---

## Konfigurace

Vše v `jarvis.config.json`. Lokální přepis patří do `jarvis.config.local.json` (gitignored).
Proměnné prostředí: `JARVIS_NAME`, `JARVIS_PORT`, `JARVIS_PROVIDER`, `ANTHROPIC_API_KEY`.

Každou schopnost lze vypnout: `features.tools`, `features.memory`, `features.voice`,
`features.streaming`, plus `tools.enabled` / `tools.disabled` pro jednotlivé nástroje.

---

## API

| Endpoint | Co dělá |
|---|---|
| `GET /api/state` | úvodní snímek — stav, config, modely, nástroje, paměť, úkoly |
| `GET /api/stream` | SSE proud událostí (jediný kanál do UI) |
| `POST /api/message` | `{ text }` — vstup uživatele; průběh teče přes SSE |
| `POST /api/confirm` | `{ id, approve }` — odpověď na potvrzení nevratné akce |
| `GET /api/tools` | katalog nástrojů včetně vypnutých |
| `GET /api/memory` | obsah paměťových vrstev |
| `POST /api/memory/remember` | `{ kind, text }` — zápis do long-term paměti |

---

## Vztah k FX Analyzeru

Tato složka je samostatný Node podprojekt uvnitř repozitáře. **Nesahá na žádný existující
soubor** — statický web, `engine.js`, `data/*.json` ani crony se nemění a fungují dál
beze změny. Cache-busting verze v HTML souborech se kvůli agentovi nebumpují, protože se
`engine.js` ani `sync.js` nedotýká.
