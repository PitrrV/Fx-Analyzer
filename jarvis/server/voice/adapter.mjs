/**
 * Hlasová vrstva — rozhraní a stavy jsou hotové, převodníky zatím ne.
 *
 * Záměr: až se hlas zapne (`features.voice: true`), nesmí se kvůli tomu měnit
 * nic v orchestrátoru. Hlas je jen další vstup do `orchestrator.handleInput()`
 * a další odběratel stavu SPEAKING — přesně jako textový vstup.
 *
 *   wake word  →  bus: IDLE → LISTENING
 *   STT        →  orchestrator.handleInput(text)
 *   orchestr.  →  bus: THINKING → WORKING → SPEAKING
 *   TTS        →  odběratel stavu SPEAKING + zpráv asistenta
 *   přerušení  →  interrupt() kdykoli během SPEAKING
 *
 * Implementace STT/TTS bude vyměnitelná stejně jako model provider: rozhraní
 * níže zůstane, změní se jen tělo.
 */
import { STATES } from "../bus.mjs";

export function createVoiceAdapter({ cfg, bus, orchestrator }) {
  const enabled = Boolean(cfg.features.voice);
  let listening = false;

  /** Vstupní bod pro STT — přepis řeči vstupuje stejnou cestou jako text. */
  async function submitTranscript(text) {
    if (!enabled) throw new Error("Hlasový vstup je vypnutý (features.voice).");
    listening = false;
    await orchestrator.handleInput(text);
  }

  /** Aktivační slovo: „JARVIS." → „Poslouchám." → příkaz bez dalšího klikání. */
  function wake() {
    if (!enabled) return false;
    listening = true;
    bus.setState(STATES.LISTENING);
    return true;
  }

  /** Přerušení asistenta uprostřed mluvení — uživatel má vždy přednost. */
  function interrupt() {
    if (bus.state === STATES.SPEAKING) bus.setState(STATES.IDLE);
    listening = false;
  }

  return {
    enabled,
    wake,
    interrupt,
    submitTranscript,

    describe() {
      return {
        enabled,
        listening,
        wakeWord: cfg.assistant.wakeWord,
        language: cfg.assistant.language,
        stt: null, // dosud nezapojeno
        tts: null, // dosud nezapojeno
        note: enabled
          ? "Hlas je zapnutý, ale STT/TTS převodníky ještě nejsou implementované."
          : "Hlas je vypnutý. Architektura i stavy jsou připravené, chybí jen STT/TTS.",
      };
    },
  };
}
