/**
 * Built-in driver registration (side effect on import).
 *
 * Importing this module registers the built-in Driver factories by name so
 * front-ends can select one via getDriver(name) / createOrchestrator({ driver: "hermes" }).
 * Idempotent — registerDriver is last-registration-wins.
 *
 * Built-ins: ollama (local default), hermes (self-hosted OpenAI-compatible),
 * openai (OPENAI_API_KEY required), openrouter (OPENROUTER_API_KEY required).
 * The key-requiring factories throw lazily — only when the driver is selected.
 */
import { registerDriver } from "../registry.js";
import { OllamaDriver } from "./ollama.js";
import { HermesDriver } from "./hermes.js";
import { createOpenAIDriver } from "./openai.js";
import { createOpenRouterDriver } from "./openrouter.js";

registerDriver("ollama", () => new OllamaDriver());
registerDriver("hermes", () => new HermesDriver());
registerDriver("openai", () => createOpenAIDriver());
registerDriver("openrouter", () => createOpenRouterDriver());
