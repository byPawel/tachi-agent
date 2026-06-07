/**
 * Built-in driver registration (side effect on import).
 *
 * Importing this module registers the built-in Driver factories by name so
 * front-ends can select one via getDriver(name) / createOrchestrator({ driver: "hermes" }).
 * Idempotent — registerDriver is last-registration-wins.
 */
import { registerDriver } from "../registry.js";
import { OllamaDriver } from "./ollama.js";
import { HermesDriver } from "./hermes.js";

registerDriver("ollama", () => new OllamaDriver());
registerDriver("hermes", () => new HermesDriver());
