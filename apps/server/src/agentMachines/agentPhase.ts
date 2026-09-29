import * as Schema from "effect/Schema";

/**
 * What an agent is doing, as `cp_agent_list` and `cp_agent_read` report it.
 * Its own module so the linked-machine store can use it without importing the
 * tool definitions, which import the linked-machine services.
 */
export const AgentPhase = Schema.Literals([
  "idle",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
  "stale",
]);
export type AgentPhase = typeof AgentPhase.Type;
