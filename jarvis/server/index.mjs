/**
 * HTTP server — obsluhuje HUD, REST API a SSE stream událostí.
 *
 * Bez závislostí, jen node:http. Poslouchá na 127.0.0.1, protože agent má
 * přístup k souborovému systému a nemá co dělat na veřejné síti.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

import { loadConfig, publicConfig, ROOT } from "./config.mjs";
import { bus } from "./bus.mjs";
import { createMemory } from "./memory/index.mjs";
import { ToolRegistry } from "./tools/registry.mjs";
import { createModelRegistry } from "./models/registry.mjs";
import { Orchestrator } from "./orchestrator.mjs";
import { createVoiceAdapter } from "./voice/adapter.mjs";

const cfg = loadConfig();
const memory = createMemory(cfg, bus);
const tools = new ToolRegistry(cfg);
const models = await createModelRegistry(cfg, bus);
const orchestrator = new Orchestrator({ cfg, bus, memory, tools, models });
const voice = createVoiceAdapter({ cfg, bus, orchestrator });

const UI_DIR = join(ROOT, "ui");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(res, url.pathname);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case "GET /api/stream":
      return streamEvents(req, res);

    case "GET /api/state":
      return json(res, 200, {
        state: bus.state,
        busy: orchestrator.busy,
        config: publicConfig(cfg),
        models: models.describe(),
        tools: tools.catalog(),
        memory: memory.snapshot(),
        voice: voice.describe(),
        tasks: memory.tasks.all(),
        pendingConfirmations: orchestrator.pendingConfirmations(),
      });

    case "GET /api/tools":
      return json(res, 200, { tools: tools.catalog() });

    case "GET /api/memory":
      return json(res, 200, { ...memory.snapshot(), longTerm: memory.longTerm.all(), tasks: memory.tasks.all() });

    case "POST /api/message": {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "Prázdná zpráva." });
      if (orchestrator.busy) return json(res, 409, { error: "Agent právě pracuje." });

      // Odpovídáme hned; průběh teče přes SSE.
      orchestrator.handleInput(text, { role: body.role ?? "primary" });
      return json(res, 202, { accepted: true });
    }

    case "POST /api/confirm": {
      const body = await readBody(req);
      const ok = orchestrator.resolveConfirmation(body.id, body.approve);
      return json(res, ok ? 200 : 404, ok ? { resolved: true } : { error: "Neznámé nebo již vyřízené potvrzení." });
    }

    case "POST /api/memory/remember": {
      const body = await readBody(req);
      const item = memory.longTerm.remember(body.kind ?? "fact", String(body.text ?? "").trim());
      return json(res, 201, item);
    }

    default:
      return json(res, 404, { error: `Neznámý endpoint: ${route}` });
  }
}

/** SSE — jediný kanál, kterým se do UI dostávají události agenta. */
function streamEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const send = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);

  // Nový klient dostane aktuální stav a nedávnou historii, aby neviděl prázdné UI.
  send({ type: "state", state: bus.state, seq: 0, ts: Date.now() });
  for (const evt of bus.history.slice(-60)) send(evt);

  bus.on("event", send);
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    bus.off("event", send);
  });
}

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : normalize(pathname).replace(/^([/\\.])+/, "");
  const file = join(UI_DIR, rel);

  if (!file.startsWith(UI_DIR)) return json(res, 403, { error: "Zakázáno." });

  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404");
  }
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

server.listen(cfg.server.port, cfg.server.host, () => {
  const { name } = cfg.assistant;
  const desc = models.describe();

  console.log(`\n  ${name} běží na http://${cfg.server.host}:${cfg.server.port}`);
  console.log(`  Model:     ${desc.provider}${desc.degraded ? "  (degradovaný režim — chybí API klíč nebo SDK)" : ""}`);
  console.log(`  Nástroje:  ${tools.enabled().map((t) => t.name).join(", ") || "žádné"}`);
  console.log(`  Kořeny:    ${cfg.security.allowedRoots.join(", ")}`);
  console.log(`  Hlas:      ${cfg.features.voice ? "zapnuto" : "vypnuto (architektura připravena)"}\n`);
});
