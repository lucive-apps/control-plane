import * as Schema from "effect/Schema";

// Fork-owned. Work Louder Creator Micro 2 integration: the pad's six top keys
// show the chats on Cmd+1..Cmd+6 and open them when pressed.

/** A slot's status, as the chat's sidebar row shows it. */
export const CreatorMicroSlotStatus = Schema.Literals([
  "approval",
  "input",
  "working",
  "monitoring",
  "failed",
  "unread",
  "ready",
]);
export type CreatorMicroSlotStatus = typeof CreatorMicroSlotStatus.Type;

/** One agent key: the chat it opens (scoped thread key) and that chat's status. */
export const CreatorMicroSlot = Schema.Struct({
  threadKey: Schema.String,
  status: CreatorMicroSlotStatus,
});
export type CreatorMicroSlot = typeof CreatorMicroSlot.Type;

/** Slots by index (slot 0 = Cmd+1); null for a key with no chat. */
export const CreatorMicroSlots = Schema.Array(Schema.NullOr(CreatorMicroSlot));
export type CreatorMicroSlots = typeof CreatorMicroSlots.Type;

export const CreatorMicroConnection = Schema.Literals([
  "disabled",
  "searching",
  "connecting",
  "connected",
  "permission-denied",
  "error",
]);
export type CreatorMicroConnection = typeof CreatorMicroConnection.Type;

/**
 * What the six top keys carry on the device: the agent keycodes the
 * integration needs, the user's own layout, a mix, or not read yet.
 */
export const CreatorMicroKeymapState = Schema.Literals([
  "unknown",
  "agent-keys",
  "original",
  "mixed",
]);
export type CreatorMicroKeymapState = typeof CreatorMicroKeymapState.Type;

export const CreatorMicroState = Schema.Struct({
  enabled: Schema.Boolean,
  connection: CreatorMicroConnection,
  keymap: CreatorMicroKeymapState,
  busy: Schema.NullOr(Schema.Literals(["enabling", "disabling", "restoring"])),
  lastError: Schema.NullOr(Schema.String),
  firmware: Schema.NullOr(Schema.String),
  /** Another app (Codex, Work Louder Input) wrote lighting to the pad. */
  otherAppDetected: Schema.Boolean,
  hasBackup: Schema.Boolean,
  backupDir: Schema.NullOr(Schema.String),
  flashWritesThisSession: Schema.Number,
  lightingWritesThisSession: Schema.Number,
});
export type CreatorMicroState = typeof CreatorMicroState.Type;

/** A pad key press, sent to the renderer to open the slot's chat. */
export const CreatorMicroKeyPress = Schema.Struct({
  slot: Schema.Number,
  threadKey: Schema.NullOr(Schema.String),
});
export type CreatorMicroKeyPress = typeof CreatorMicroKeyPress.Type;
