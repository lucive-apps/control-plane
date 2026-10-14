import { describe, expect, it } from "@effect/vitest";

import {
  GROK_COST_USD_TICKS_PER_DOLLAR,
  initialCodexScanState,
  parseClaudeLine,
  parseCodexLine,
  parseGrokLine,
  parseMuseLine,
  totalTokens,
} from "./usageTranscripts.ts";

/** Shaped after a real Claude Code assistant record. */
function claudeLine(overrides: {
  messageId: string;
  contentType: string;
  model?: string;
  outputTokens?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-07T04:05:13.944Z",
    sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    cwd: "/home/theo/project",
    message: {
      id: overrides.messageId,
      role: "assistant",
      model: overrides.model ?? "claude-fable-5",
      content: [{ type: overrides.contentType }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 66818,
        cache_read_input_tokens: 1000,
        output_tokens: overrides.outputTokens ?? 286,
      },
    },
  });
}

describe("parseClaudeLine", () => {
  it("extracts token totals and a dedupe key", () => {
    const record = parseClaudeLine(claudeLine({ messageId: "msg_1", contentType: "text" }));

    expect(record).not.toBeNull();
    expect(record?.provider).toBe("claude");
    expect(record?.model).toBe("claude-fable-5");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 66818,
      outputTokens: 286,
      reasoningTokens: 0,
    });
    expect(record?.dedupeKey).toBe("msg_1:");
  });

  it("gives every content block of one message the same dedupe key", () => {
    // T3 Code writes one record per content block, each repeating the parent
    // message's full usage. Summing them would overcount ~2.4x on real data.
    const text = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "text" }));
    const toolUse = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "tool_use" }));

    expect(text?.dedupeKey).toBe(toolUse?.dedupeKey);
    expect(text?.totals).toEqual(toolUse?.totals);
  });

  it("ignores records that are not assistant messages", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "user", message: {} }))).toBeNull();
    expect(parseClaudeLine("not json")).toBeNull();
  });
});

describe("parseCodexLine", () => {
  const sessionMeta = JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-01T05:17:41.289Z",
    payload: { type: "session_meta", id: "019fbbc1-b12c-7360-a685-28c181f0025f" },
  });
  const turnContext = JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T05:17:42.694Z",
    payload: { type: "turn_context", model: "gpt-5.6-sol" },
  });
  const tokenCount = (inputTokens: number, cached: number, output: number, reasoning: number) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T05:17:49.919Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
          },
        },
      },
    });

  it("attributes usage to the model from the preceding turn context", () => {
    const state = initialCodexScanState();
    parseCodexLine(sessionMeta, state);
    parseCodexLine(turnContext, state);
    const record = parseCodexLine(tokenCount(19239, 11008, 299, 116), state);

    expect(record?.provider).toBe("codex");
    expect(record?.model).toBe("gpt-5.6-sol");
    expect(record?.sessionId).toBe("019fbbc1-b12c-7360-a685-28c181f0025f");
    // Codex reports input_tokens inclusive of the cached portion.
    expect(record?.totals.uncachedInputTokens).toBe(19239 - 11008);
    expect(record?.totals.cachedInputTokens).toBe(11008);
    expect(record?.totals.reasoningTokens).toBe(116);
  });

  it("skips a repeated token_count so deltas are not double counted", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const first = parseCodexLine(tokenCount(100, 0, 10, 0), state);
    const repeat = parseCodexLine(tokenCount(100, 0, 10, 0), state);

    expect(first).not.toBeNull();
    expect(repeat).toBeNull();
  });

  it("drops usage that arrives before any model is known", () => {
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
  });

  it("does not let a pre-model event poison the duplicate signature", () => {
    // A token_count before its turn_context is dropped; the identical event
    // re-emitted once the model is known must still be counted.
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
    parseCodexLine(turnContext, state);
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).not.toBeNull();
  });

  // A forked/subagent rollout opens with the parent's history copied in and
  // every line re-stamped to the fork instant, then the ancestors' session
  // metas. Counting those again multiplied usage ~1.85x on real data (#5758).
  describe("forked rollouts", () => {
    const meta = (overrides: {
      id: string;
      timestamp: string;
      forkedFromId?: string;
      spawnParentId?: string;
    }) =>
      JSON.stringify({
        type: "session_meta",
        timestamp: overrides.timestamp,
        payload: {
          type: "session_meta",
          id: overrides.id,
          ...(overrides.forkedFromId === undefined
            ? {}
            : { forked_from_id: overrides.forkedFromId }),
          ...(overrides.spawnParentId === undefined
            ? {}
            : {
                source: {
                  subagent: { thread_spawn: { parent_thread_id: overrides.spawnParentId } },
                },
              }),
        },
      });
    const stamped = (timestamp: string, line: string) => {
      const parsed = JSON.parse(line) as { timestamp: string };
      parsed.timestamp = timestamp;
      return JSON.stringify(parsed);
    };

    it("keeps the child session id over copied ancestor metas", () => {
      const state = initialCodexScanState();
      parseCodexLine(meta({ id: "child", timestamp: "2026-08-01T05:00:00.000Z" }), state);
      parseCodexLine(meta({ id: "parent", timestamp: "2026-08-01T05:00:00.000Z" }), state);
      parseCodexLine(turnContext, state);
      const record = parseCodexLine(tokenCount(100, 0, 10, 0), state);

      expect(record?.sessionId).toBe("child");
    });

    it("drops the re-stamped copied burst and keeps the first real event", () => {
      const state = initialCodexScanState();
      const forkInstant = "2026-08-01T05:00:00.000Z";
      parseCodexLine(meta({ id: "child", timestamp: forkInstant, forkedFromId: "parent" }), state);
      parseCodexLine(meta({ id: "parent", timestamp: forkInstant }), state);
      parseCodexLine(stamped(forkInstant, turnContext), state);

      // Copied history: written in one burst at the fork instant.
      expect(
        parseCodexLine(stamped("2026-08-01T05:00:00.001Z", tokenCount(100, 0, 10, 0)), state),
      ).toBeNull();
      expect(
        parseCodexLine(stamped("2026-08-01T05:00:00.002Z", tokenCount(200, 0, 20, 0)), state),
      ).toBeNull();

      // The child's first genuine turn lands seconds later and must count.
      const real = parseCodexLine(
        stamped("2026-08-01T05:00:06.000Z", tokenCount(300, 0, 30, 0)),
        state,
      );
      expect(real).not.toBeNull();
      expect(real?.totals.outputTokens).toBe(30);

      // Suppression never restarts, even for closely spaced later events.
      const next = parseCodexLine(
        stamped("2026-08-01T05:00:06.100Z", tokenCount(400, 0, 40, 0)),
        state,
      );
      expect(next).not.toBeNull();
    });

    it("recognizes subagent spawns without forked_from_id", () => {
      const state = initialCodexScanState();
      const spawnInstant = "2026-08-01T05:00:00.000Z";
      parseCodexLine(
        meta({ id: "child", timestamp: spawnInstant, spawnParentId: "parent" }),
        state,
      );
      parseCodexLine(stamped(spawnInstant, turnContext), state);
      expect(
        parseCodexLine(stamped("2026-08-01T05:00:00.001Z", tokenCount(100, 0, 10, 0)), state),
      ).toBeNull();
    });

    it("does not suppress anything in a rollout that is not a fork", () => {
      const state = initialCodexScanState();
      parseCodexLine(meta({ id: "root", timestamp: "2026-08-01T05:00:00.000Z" }), state);
      parseCodexLine(stamped("2026-08-01T05:00:00.100Z", turnContext), state);
      const record = parseCodexLine(
        stamped("2026-08-01T05:00:00.200Z", tokenCount(100, 0, 10, 0)),
        state,
      );
      expect(record).not.toBeNull();
    });
  });
});

describe("totalTokens", () => {
  it("does not add reasoning on top of output", () => {
    expect(
      totalTokens({
        uncachedInputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationTokens: 30,
        outputTokens: 40,
        reasoningTokens: 25,
      }),
    ).toBe(100);
  });
});

describe("parseGrokLine", () => {
  /** Shaped after a real Grok Build `turn_completed` session update. */
  function turnCompleted(overrides?: {
    sessionId?: string;
    promptId?: string;
    timestamp?: number;
    agentTimestampMs?: number;
    usage?: Record<string, unknown>;
    modelUsage?: Record<string, Record<string, unknown>> | null;
  }): string {
    const modelUsage =
      overrides && "modelUsage" in overrides
        ? overrides.modelUsage
        : {
            "grok-4.5-build": {
              inputTokens: 20_272,
              outputTokens: 272,
              totalTokens: 20_544,
              cachedReadTokens: 11_264,
              cacheCreationTokens: 0,
              reasoningTokens: 180,
              costUsdTicks: 230_272_000,
            },
          };

    return JSON.stringify({
      timestamp: overrides?.timestamp ?? 1_786_372_566,
      method: "_x.ai/session/update",
      params: {
        sessionId: overrides?.sessionId ?? "019fec1a-12f7-72f2-9b1f-7778a00aea3c",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: overrides?.promptId ?? "prompt-1",
          stop_reason: "end_turn",
          usage: {
            inputTokens: 20_272,
            outputTokens: 272,
            totalTokens: 20_544,
            cachedReadTokens: 11_264,
            cacheCreationTokens: 0,
            reasoningTokens: 180,
            costUsdTicks: 230_272_000,
            ...(modelUsage === null ? {} : { modelUsage }),
            ...overrides?.usage,
          },
        },
        _meta: {
          eventId: "event-1",
          agentTimestampMs: overrides?.agentTimestampMs ?? 1_786_372_566_485,
        },
      },
    });
  }

  it("extracts per-model totals and provider-reported cost ticks", () => {
    const records = parseGrokLine(turnCompleted());

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.provider).toBe("grok");
    expect(record?.model).toBe("grok-4.5-build");
    expect(record?.sessionId).toBe("019fec1a-12f7-72f2-9b1f-7778a00aea3c");
    expect(record?.timestampMs).toBe(1_786_372_566_485);
    expect(record?.totals).toEqual({
      uncachedInputTokens: 20_272 - 11_264,
      cachedInputTokens: 11_264,
      cacheCreationTokens: 0,
      outputTokens: 272,
      reasoningTokens: 180,
    });
    expect(record?.reportedCostUsd).toBeCloseTo(230_272_000 / GROK_COST_USD_TICKS_PER_DOLLAR, 12);
    expect(record?.dedupeKey).toBe("019fec1a-12f7-72f2-9b1f-7778a00aea3c:prompt-1:grok-4.5-build");
  });

  it("emits one record per model when modelUsage has several entries", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 1000,
            outputTokens: 50,
            cachedReadTokens: 400,
            reasoningTokens: 20,
            costUsdTicks: 50_000_000,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 200,
            outputTokens: 30,
            cachedReadTokens: 100,
            reasoningTokens: 0,
            costUsdTicks: 10_000_000,
          },
        },
      }),
    );

    expect(records.map((record) => record.model).toSorted()).toEqual([
      "grok-4.5",
      "grok-composer-2.5-fast",
    ]);
    expect(records.every((record) => record.provider === "grok")).toBe(true);
    expect(records.find((record) => record.model === "grok-4.5")?.reportedCostUsd).toBeCloseTo(
      0.005,
      12,
    );
  });

  it("inherits top-level cost ticks for a single model without its own ticks", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5-build": {
            inputTokens: 1000,
            outputTokens: 10,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.reportedCostUsd).toBe(1);
  });

  it("falls back to a generic grok model when modelUsage is absent", () => {
    const records = parseGrokLine(turnCompleted({ modelUsage: null }));

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.provider).toBe("grok");
    expect(record?.model).toBe("grok");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 20_272 - 11_264,
      cachedInputTokens: 11_264,
      cacheCreationTokens: 0,
      outputTokens: 272,
      reasoningTokens: 180,
    });
    expect(record?.reportedCostUsd).toBeCloseTo(230_272_000 / GROK_COST_USD_TICKS_PER_DOLLAR, 12);
    expect(record?.dedupeKey).toBe("019fec1a-12f7-72f2-9b1f-7778a00aea3c:prompt-1:grok");
  });

  it("pro-rates top-level cost ticks across multi-model turns without per-model ticks", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 300,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 100,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(2);
    const byModel = Object.fromEntries(records.map((record) => [record.model, record]));
    expect(byModel["grok-4.5"]?.reportedCostUsd).toBeCloseTo(0.75, 12);
    expect(byModel["grok-composer-2.5-fast"]?.reportedCostUsd).toBeCloseTo(0.25, 12);
    const sum =
      (byModel["grok-4.5"]?.reportedCostUsd ?? 0) +
      (byModel["grok-composer-2.5-fast"]?.reportedCostUsd ?? 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("pro-rates aggregate cost when a zero-token sibling carries costUsdTicks: 0", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 300,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 100,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
          "empty-sibling": {
            inputTokens: 0,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
            costUsdTicks: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(2);
    expect(records.every((record) => record.model !== "empty-sibling")).toBe(true);
    const byModel = Object.fromEntries(records.map((record) => [record.model, record]));
    expect(byModel["grok-4.5"]?.reportedCostUsd).toBeCloseTo(0.75, 12);
    expect(byModel["grok-composer-2.5-fast"]?.reportedCostUsd).toBeCloseTo(0.25, 12);
    const sum =
      (byModel["grok-4.5"]?.reportedCostUsd ?? 0) +
      (byModel["grok-composer-2.5-fast"]?.reportedCostUsd ?? 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("allocates leftover aggregate ticks to models that omit per-model ticks", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 300,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
            costUsdTicks: 0.4 * GROK_COST_USD_TICKS_PER_DOLLAR,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 100,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(2);
    const byModel = Object.fromEntries(records.map((record) => [record.model, record]));
    expect(byModel["grok-4.5"]?.reportedCostUsd).toBeCloseTo(0.4, 12);
    expect(byModel["grok-composer-2.5-fast"]?.reportedCostUsd).toBeCloseTo(0.6, 12);
    const sum =
      (byModel["grok-4.5"]?.reportedCostUsd ?? 0) +
      (byModel["grok-composer-2.5-fast"]?.reportedCostUsd ?? 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("does not invent a colliding dedupe key when prompt_id is missing", () => {
    const line = JSON.stringify({
      timestamp: 1_786_372_566,
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "turn_completed",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            modelUsage: {
              "grok-4.5": { inputTokens: 10, outputTokens: 2 },
            },
          },
        },
      },
    });

    expect(parseGrokLine(line)[0]?.dedupeKey).toBeNull();
  });

  it("ignores non-turn lines and empty usage", () => {
    expect(parseGrokLine(JSON.stringify({ method: "session/update", params: {} }))).toEqual([]);
    expect(parseGrokLine("not json")).toEqual([]);
    expect(
      parseGrokLine(
        turnCompleted({
          modelUsage: {
            "grok-4.5-build": {
              inputTokens: 0,
              outputTokens: 0,
              cachedReadTokens: 0,
              reasoningTokens: 0,
              costUsdTicks: 0,
            },
          },
        }),
      ),
    ).toEqual([]);
  });

  it("falls back to the outer unix-seconds timestamp when agent meta is missing", () => {
    const line = JSON.stringify({
      timestamp: 1_786_372_566,
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p1",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            modelUsage: {
              "grok-4.5": { inputTokens: 10, outputTokens: 2 },
            },
          },
        },
      },
    });

    const records = parseGrokLine(line);
    expect(records[0]?.timestampMs).toBe(1_786_372_566_000);
  });
});

describe("parseMuseLine", () => {
  /**
   * Shaped after a real Muse Code `model_completed` run event, nested in its
   * outer frame exactly as `session.jsonl` stores it. Token figures are the
   * sanitised values from genuine history, not invented ones.
   */
  function museLine(overrides?: {
    recordId?: string;
    sessionId?: string;
    recordedAtUs?: number;
    model?: string;
    usage?: Record<string, unknown>;
    eventKind?: string;
  }): string {
    const inner = {
      schema_version: 1,
      id: overrides?.recordId ?? "5a5f3d97-363c-4fe7-9f82-6e3c65d978be",
      stream: {
        kind: "session",
        id: overrides?.sessionId ?? "01a13b76-b508-7000-aac2-224fa15f0683",
      },
      sequence: 66,
      recorded_at: overrides?.recordedAtUs ?? 1_786_372_566_485_000,
      record_type: "event",
      durability: "durable",
      causation_id: null,
      payload_type: "runtime.session",
      payload_schema_version: 1,
      payload: {
        kind: "run",
        run_id: "01a13b76-b617-7000-bd8a-b162440beb02",
        event: {
          kind: overrides?.eventKind ?? "model_completed",
          usage: {
            input_tokens: 42129,
            output_tokens: 135,
            cached_tokens: 41716,
            cache_write_tokens: 0,
            cache_read_tokens: 41716,
            reasoning_tokens: 0,
            ...overrides?.usage,
          },
          duration_ms: 2306,
          finish_reason: "tool_calls",
          model: overrides?.model ?? "muse-wonder-1.0",
        },
      },
    };
    return JSON.stringify({
      retained_frame: "session_transaction",
      frame_schema_version: 1,
      outer_log_ordinal: 94,
      transaction_id: "956ecdf9-cf5e-4840-b694-711530050f12",
      children: [{ child_index: 0, record_json: JSON.stringify(inner) }],
    });
  }

  it("extracts token totals, model, session, and a dedupe key", () => {
    const records = parseMuseLine(museLine());

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.provider).toBe("muse");
    expect(record?.model).toBe("muse-wonder-1.0");
    expect(record?.sessionId).toBe("01a13b76-b508-7000-aac2-224fa15f0683");
    expect(record?.timestampMs).toBe(1_786_372_566_485);
    // Muse reports input_tokens inclusive of the cached portion.
    expect(record?.totals).toEqual({
      uncachedInputTokens: 42129 - 41716,
      cachedInputTokens: 41716,
      cacheCreationTokens: 0,
      outputTokens: 135,
      reasoningTokens: 0,
    });
    expect(record?.reportedCostUsd).toBeNull();
    expect(record?.dedupeKey).toBe("5a5f3d97-363c-4fe7-9f82-6e3c65d978be");
  });

  it("clamps reasoning into output and keeps cache writes separate", () => {
    const records = parseMuseLine(
      museLine({
        usage: {
          input_tokens: 1000,
          output_tokens: 120,
          cached_tokens: 0,
          cache_write_tokens: 200,
          cache_read_tokens: 100,
          reasoning_tokens: 500,
        },
      }),
    );

    expect(records[0]?.totals).toEqual({
      uncachedInputTokens: 700,
      cachedInputTokens: 100,
      cacheCreationTokens: 200,
      outputTokens: 120,
      reasoningTokens: 120,
    });
  });

  it("returns one record per model_completed child in a shared frame", () => {
    const first = JSON.parse(museLine({ recordId: "record-1" })) as {
      children: { record_json: string }[];
    };
    const second = JSON.parse(museLine({ recordId: "record-2" })) as {
      children: { record_json: string }[];
    };
    const shared = JSON.stringify({
      retained_frame: "session_transaction",
      children: [...first.children, ...second.children],
    });

    const records = parseMuseLine(shared);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.dedupeKey)).toEqual(["record-1", "record-2"]);
  });

  it("gives a repeated event the same dedupe key so the aggregate drops it", () => {
    // The companion goal_usage_attribution events repeat these quantities
    // under different ids, and subagent logs never repeat a parent id, so the
    // record id alone keeps every turn counted exactly once.
    const line = museLine();
    expect(parseMuseLine(line)[0]?.dedupeKey).toBe(parseMuseLine(line)[0]?.dedupeKey);
    expect(parseMuseLine(line)).toHaveLength(1);
  });

  it("ignores attribution repeats, other events, and empty usage", () => {
    expect(parseMuseLine(museLine({ eventKind: "goal_usage_attribution" }))).toEqual([]);
    expect(parseMuseLine(museLine({ eventKind: "model_response_created" }))).toEqual([]);
    expect(
      parseMuseLine(
        museLine({
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            cache_write_tokens: 0,
            cache_read_tokens: 0,
            reasoning_tokens: 0,
          },
        }),
      ),
    ).toEqual([]);
    expect(parseMuseLine("not json")).toEqual([]);
  });
});
