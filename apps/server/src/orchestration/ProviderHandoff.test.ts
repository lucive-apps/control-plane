import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderHandoff,
  providerHandoffBudget,
  readLatestProviderSwitch,
  readPendingProviderHandoff,
} from "./ProviderHandoff.ts";

const user = (text: string) => ({ role: "user" as const, text });
const assistant = (text: string) => ({ role: "assistant" as const, text });

describe("formatProviderHandoff", () => {
  it("renders the conversation oldest first, skipping thinking and system notes", () => {
    const handoff = formatProviderHandoff({
      messages: [
        user("Add dark mode"),
        { role: "reasoning", text: "Thinking about tokens" },
        assistant("Done. Tokens now have dark values."),
        { role: "system", text: "Session restarted" },
        user("Make charts fade"),
      ],
      fromLabel: "Claude",
      maxChars: 48_000,
    });

    expect(handoff).toBe(
      "<previous_conversation>\nYou are taking over this conversation from Claude. The earlier messages are below, oldest first. Long or older messages may be shortened. Use them as context and answer the new message that follows.\n\n" +
        "USER:\nAdd dark mode\n\nASSISTANT:\nDone. Tokens now have dark values.\n\nUSER:\nMake charts fade" +
        "\n</previous_conversation>",
    );
  });

  it("keeps the first request and the newest messages when the budget runs out", () => {
    const messages = [
      user("Original task"),
      ...Array.from({ length: 12 }, (_, index) => assistant(`${index} `.repeat(1_000))),
      user("Latest follow-up"),
    ];
    const handoff = formatProviderHandoff({ messages, fromLabel: "Codex", maxChars: 12_000 });

    expect(handoff).toBeDefined();
    expect(handoff!.length).toBeLessThanOrEqual(12_000 + 100);
    expect(handoff).toContain("USER:\nOriginal task");
    expect(handoff).toContain("USER:\nLatest follow-up");
    expect(handoff).toMatch(/\[\d+ earlier messages omitted\]/);
    expect(handoff!.indexOf("Original task")).toBeLessThan(handoff!.indexOf("omitted"));
  });

  it("lists attachments by name and returns nothing when there is no earlier content", () => {
    expect(
      formatProviderHandoff({
        messages: [
          {
            role: "user",
            text: "See the screenshot",
            attachments: [
              {
                type: "image",
                id: "attachment-1",
                name: "chart.png",
                mimeType: "image/png",
                sizeBytes: 10,
              },
            ],
          },
        ],
        fromLabel: "Codex",
        maxChars: 48_000,
      }),
    ).toContain("USER:\nSee the screenshot\n[Attachments: chart.png]");
    expect(
      formatProviderHandoff({ messages: [user("   ")], fromLabel: "Codex", maxChars: 48_000 }),
    ).toBeUndefined();
  });
});

describe("providerHandoffBudget", () => {
  it("leaves room for the new message under the provider input cap", () => {
    expect(providerHandoffBudget("short")).toBe(48_000);
    expect(providerHandoffBudget("x".repeat(100_000))).toBe(19_000);
  });
});

describe("handoff state", () => {
  it("reads a pending handoff and treats a cleared one as absent", () => {
    expect(readPendingProviderHandoff({ pendingProviderHandoff: { fromLabel: "Codex" } })).toEqual({
      fromLabel: "Codex",
    });
    expect(readPendingProviderHandoff({ pendingProviderHandoff: null })).toBeUndefined();
    expect(readPendingProviderHandoff(null)).toBeUndefined();
  });

  it("uses the switch with the highest turn count as the rewind boundary", () => {
    const payload = (turnCount: number, toLabel: string) => ({
      fromProviderInstanceId: "codex",
      toProviderInstanceId: "claudeAgent",
      fromLabel: "Codex",
      toLabel,
      turnCount,
    });
    expect(
      readLatestProviderSwitch([
        { kind: "provider.switched", payload: payload(2, "Claude") },
        { kind: "context-compaction", payload: {} },
        { kind: "provider.switched", payload: payload(5, "Grok") },
        { kind: "provider.switched", payload: { turnCount: "bad" } },
      ]),
    ).toMatchObject({ turnCount: 5, toLabel: "Grok" });
  });
});
