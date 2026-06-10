// vitest.config.ts — only the main tree's tests; .claude/ holds worktrees/settings, never suite input.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
});
