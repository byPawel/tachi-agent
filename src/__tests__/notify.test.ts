import { describe, it, expect, vi, afterEach } from "vitest";
import { parseNotifyTargets, createNotifiers } from "../notify.js";

afterEach(() => vi.unstubAllGlobals());

describe("parseNotifyTargets", () => {
  it("parses telegram and slack targets", () => {
    expect(parseNotifyTargets("telegram:123, slack:C042")).toEqual([
      { kind: "telegram", to: "123" },
      { kind: "slack", to: "C042" },
    ]);
  });
  it("ignores blanks, malformed entries, and unknown kinds", () => {
    expect(parseNotifyTargets(" ,discord:x, telegram:, telegram:9 ")).toEqual([{ kind: "telegram", to: "9" }]);
  });
  it("returns [] for unset", () => {
    expect(parseNotifyTargets(undefined)).toEqual([]);
  });
});

describe("createNotifiers", () => {
  it("skips targets whose token is missing, builds the rest", () => {
    const notifiers = createNotifiers({
      TACHI_NOTIFY: "telegram:123,slack:C042",
      TELEGRAM_BOT_TOKEN: "tg-token",
      // SLACK_BOT_TOKEN missing → slack target dropped
    });
    expect(notifiers.length).toBe(1);
  });

  it("telegram notifier POSTs to the bot API", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
    const [n] = createNotifiers({ TACHI_NOTIFY: "telegram:123", TELEGRAM_BOT_TOKEN: "tg-token" });
    await n.send("hello");
    expect(calls[0].url).toContain("api.telegram.org/bottg-token/sendMessage");
    expect(calls[0].body).toMatchObject({ chat_id: 123, text: "hello" });
  });
});
