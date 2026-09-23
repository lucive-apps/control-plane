import {
  NonNegativeInt,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { limitTitleMessage } from "../textGeneration/ThreadTitleContext.ts";

/**
 * A thread moved to a provider that cannot resume the previous provider's
 * native session. `turnCount` is the checkpoint turn count at the switch: the
 * new provider only holds turns after it, so rewinds stop there.
 */
export const PROVIDER_SWITCHED_ACTIVITY_KIND = "provider.switched";

/**
 * Binding runtime-payload key set while the thread's current provider still
 * needs the earlier conversation. Cleared once a turn carrying it is sent.
 */
export const PENDING_PROVIDER_HANDOFF_KEY = "pendingProviderHandoff";

const MAX_HANDOFF_CHARS = 48_000;
/** Below this, a message is too long to share the turn; the handoff waits for the next one. */
export const MIN_PROVIDER_HANDOFF_CHARS = 2_000;
const MAX_HANDOFF_MESSAGE_CHARS = 6_000;
const MIN_HANDOFF_MESSAGE_CHARS = 200;
// Headroom for omission markers and the separator before the new message.
const HANDOFF_RESERVE_CHARS = 1_000;

const PendingProviderHandoff = Schema.Struct({ fromLabel: Schema.String });
export type PendingProviderHandoff = typeof PendingProviderHandoff.Type;
const decodePendingHandoffPayload = Schema.decodeUnknownOption(
  Schema.Struct({ [PENDING_PROVIDER_HANDOFF_KEY]: PendingProviderHandoff }),
);

export const ProviderSwitchedPayload = Schema.Struct({
  fromProviderInstanceId: Schema.String,
  toProviderInstanceId: Schema.String,
  fromLabel: Schema.String,
  toLabel: Schema.String,
  turnCount: NonNegativeInt,
});
export type ProviderSwitchedPayload = typeof ProviderSwitchedPayload.Type;
const decodeProviderSwitchedPayload = Schema.decodeUnknownOption(ProviderSwitchedPayload);

export function pendingProviderHandoffPayload(
  handoff: PendingProviderHandoff | null,
): Record<string, PendingProviderHandoff | null> {
  return { [PENDING_PROVIDER_HANDOFF_KEY]: handoff };
}

export function readPendingProviderHandoff(
  runtimePayload: unknown,
): PendingProviderHandoff | undefined {
  return Option.getOrUndefined(
    Option.map(
      decodePendingHandoffPayload(runtimePayload),
      (payload) => payload[PENDING_PROVIDER_HANDOFF_KEY],
    ),
  );
}

/** The switch that rewinds must not cross: the one with the highest turn count. */
export function readLatestProviderSwitch(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>,
): ProviderSwitchedPayload | undefined {
  let latest: ProviderSwitchedPayload | undefined;
  for (const activity of activities) {
    if (activity.kind !== PROVIDER_SWITCHED_ACTIVITY_KIND) continue;
    const payload = Option.getOrUndefined(decodeProviderSwitchedPayload(activity.payload));
    if (payload && (latest === undefined || payload.turnCount >= latest.turnCount)) {
      latest = payload;
    }
  }
  return latest;
}

export function providerInstanceLabel(info: {
  readonly instanceId: string;
  readonly driverKind?: ProviderDriverKind | undefined;
  readonly displayName?: string | undefined;
}): string {
  return (
    info.displayName ??
    (info.driverKind !== undefined ? PROVIDER_DISPLAY_NAMES[info.driverKind] : undefined) ??
    info.instanceId
  );
}

/** Room left for the handoff once the new message itself is accounted for. */
export function providerHandoffBudget(messageText: string | undefined): number {
  return Math.min(
    MAX_HANDOFF_CHARS,
    PROVIDER_SEND_TURN_MAX_INPUT_CHARS - (messageText?.length ?? 0) - HANDOFF_RESERVE_CHARS,
  );
}

/**
 * Render the conversation before the new message for a provider that has not
 * seen it. Keeps the first request, then the newest messages that fit, oldest
 * first. Returns undefined when there is nothing to hand over or no room.
 */
export function formatProviderHandoff(input: {
  readonly messages: ReadonlyArray<
    Pick<OrchestrationMessage, "role" | "text" | "attachments" | "context">
  >;
  readonly fromLabel: string;
  readonly maxChars: number;
}): string | undefined {
  const sections = input.messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = (
      message.role === "user"
        ? projectComposerContextForProvider({
            text: message.text,
            records: message.context?.records ?? [],
          })
        : assistantCitationsToPlainText(message.text)
    ).trim();
    const names = message.attachments?.map((attachment) => attachment.name).join(", ");
    const body = [text, ...(names ? [`[Attachments: ${names}]`] : [])].filter(Boolean).join("\n");
    return body ? [{ prefix: message.role === "user" ? "USER:\n" : "ASSISTANT:\n", body }] : [];
  });
  if (sections.length === 0) return undefined;

  const header = `<previous_conversation>\nYou are taking over this conversation from ${input.fromLabel}. The earlier messages are below, oldest first. Long or older messages may be shortened. Use them as context and answer the new message that follows.\n\n`;
  const footer = "\n</previous_conversation>";
  let remaining = input.maxChars - header.length - footer.length;
  const selected = new Map<number, string>();
  const add = (index: number): boolean => {
    const section = sections[index]!;
    const limit = Math.min(MAX_HANDOFF_MESSAGE_CHARS, remaining) - section.prefix.length - 2;
    if (limit < MIN_HANDOFF_MESSAGE_CHARS) return false;
    const text = section.prefix + limitTitleMessage(section.body, limit);
    selected.set(index, text);
    remaining -= text.length + 2;
    return true;
  };

  // The first request frames everything after it, so it is kept before recency fills the rest.
  const firstUser = sections.findIndex((section) => section.prefix === "USER:\n");
  if (firstUser >= 0) add(firstUser);
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    if (!selected.has(index) && !add(index)) break;
  }
  if (selected.size === 0) return undefined;

  const parts: string[] = [];
  let omitted = 0;
  sections.forEach((_, index) => {
    const text = selected.get(index);
    if (text === undefined) {
      omitted += 1;
      return;
    }
    if (omitted > 0) {
      parts.push(`[${omitted} earlier message${omitted === 1 ? "" : "s"} omitted]`);
      omitted = 0;
    }
    parts.push(text);
  });
  return `${header}${parts.join("\n\n")}${footer}`;
}
