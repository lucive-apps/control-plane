import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Fork-owned. The user's global instructions: one markdown file per server
// (`<stateDir>/GLOBAL_AGENTS.md`) that every provider session in the chosen
// scopes receives ahead of its Project instructions. Imports only effect so
// settings.ts and rpc.ts can import this module without a cycle.

/** The file name under the server's state directory. */
export const GLOBAL_INSTRUCTIONS_FILE = "GLOBAL_AGENTS.md";

/**
 * Characters of the file that reach a prompt. The rest stays on disk behind a
 * truncation marker. These land in every session, so the cap is half the
 * Project memory's inline cap.
 */
export const GLOBAL_INSTRUCTIONS_CAP_CHARS = 8_000;

/** Which sessions receive the global instructions. All on by default; an empty file changes nothing. */
export const GlobalInstructionsScopes = Schema.Struct({
  /** Project coordinator threads. */
  coordinators: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Agents in a Project, one-off and standing. */
  projectAgents: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Threads outside a Control Plane Project. */
  tasks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type GlobalInstructionsScopes = typeof GlobalInstructionsScopes.Type;

export const GlobalInstructionsScopesPatch = Schema.Struct({
  coordinators: Schema.optionalKey(Schema.Boolean),
  projectAgents: Schema.optionalKey(Schema.Boolean),
  tasks: Schema.optionalKey(Schema.Boolean),
});
export type GlobalInstructionsScopesPatch = typeof GlobalInstructionsScopesPatch.Type;

// ── RPC ────────────────────────────────────────────────────────────

export const GlobalInstructionsInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("read") }),
  /** Replaces the file. An empty text leaves an empty file, which injects nothing. */
  Schema.Struct({
    action: Schema.Literal("write"),
    text: Schema.String.check(Schema.isMaxLength(200_000)),
  }),
]);
export type GlobalInstructionsInput = typeof GlobalInstructionsInput.Type;

export const GlobalInstructionsResult = Schema.Struct({
  /** Absolute path on the server, for editing on disk. */
  path: Schema.String,
  /** The whole file; "" when it does not exist. */
  text: Schema.String,
  capChars: Schema.Int,
});
export type GlobalInstructionsResult = typeof GlobalInstructionsResult.Type;

export class GlobalInstructionsError extends Schema.TaggedError<GlobalInstructionsError>()(
  "GlobalInstructionsError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
