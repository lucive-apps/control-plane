import { partitionAssistants } from "@t3tools/client-runtime/state/assistants";
import { OrchestrationShellSnapshot, ServerConfig } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEMO_ENVIRONMENT_ID,
  DEMO_ENVIRONMENT_LABEL,
  DEMO_THREAD_IDS,
  makeDemoData,
} from "./demoFixtures";
import { DemoServer } from "./demoServer";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const encodeServerConfig = Schema.encodeSync(ServerConfig);
const decodeServerConfig = Schema.decodeUnknownSync(ServerConfig);
const encodeShellSnapshot = Schema.encodeSync(OrchestrationShellSnapshot);
const decodeShellSnapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot);

describe("demo fixtures", () => {
  it("describes the Demo Mac environment with Projects enabled", () => {
    const { serverConfig } = makeDemoData(NOW);
    expect(serverConfig.environment.environmentId).toBe(DEMO_ENVIRONMENT_ID);
    expect(serverConfig.environment.label).toBe(DEMO_ENVIRONMENT_LABEL);
    expect(serverConfig.environment.capabilities.assistants).toBe(true);
    expect(serverConfig.providers.length).toBeGreaterThan(0);
    // Round-trips through the wire schema, like a config from a real computer.
    const encoded = encodeServerConfig(serverConfig);
    expect(decodeServerConfig(encoded).environment.environmentId).toBe(DEMO_ENVIRONMENT_ID);
  });

  it("builds a shell snapshot that survives the wire schema", () => {
    const snapshot = new DemoServer({ now: () => NOW }).shellSnapshot();
    const encoded = encodeShellSnapshot(snapshot);
    const decoded = decodeShellSnapshot(encoded);
    expect(decoded.threads).toHaveLength(snapshot.threads.length);
    expect(decoded.projects).toHaveLength(snapshot.projects.length);
  });

  it("covers Projects, Tasks folders and every thread state the reviewer should see", () => {
    const snapshot = new DemoServer({ now: () => NOW }).shellSnapshot();
    const projects = snapshot.projects.map((project) => ({
      ...project,
      environmentId: DEMO_ENVIRONMENT_ID,
    }));
    const threads = snapshot.threads.map((thread) => ({
      ...thread,
      environmentId: DEMO_ENVIRONMENT_ID,
    }));
    const partition = partitionAssistants(projects, threads, null);

    expect(partition.assistants.map((entry) => entry.project.title)).toEqual([
      "Mobile App",
      "Website Launch",
    ]);
    for (const entry of partition.assistants) {
      expect(entry.coordinator).not.toBeNull();
      expect(entry.agents.length).toBeGreaterThan(0);
    }
    expect(partition.workspaceProjects.map((project) => project.title).sort()).toEqual([
      "acme-web",
      "api-server",
    ]);
    expect(partition.workspaceThreads.length).toBeGreaterThanOrEqual(4);

    const byId = new Map(snapshot.threads.map((thread) => [thread.id as string, thread]));
    expect(byId.get(DEMO_THREAD_IDS.heroLayout)?.session?.status).toBe("running");
    expect(byId.get(DEMO_THREAD_IDS.heroLayout)?.planProgress?.step).toBeTruthy();
    expect(byId.get(DEMO_THREAD_IDS.blogPost)?.settledAt).not.toBeNull();
    expect(byId.get(DEMO_THREAD_IDS.darkMode)?.hasPendingApprovals).toBe(true);
    expect(byId.get(DEMO_THREAD_IDS.pricingCopy)?.hasPendingUserInput).toBe(true);
  });

  it("gives every thread a conversation", () => {
    for (const thread of makeDemoData(NOW).threads) {
      expect(thread.messages.some((message) => message.role === "user")).toBe(true);
      expect(thread.messages.some((message) => message.role === "assistant")).toBe(true);
    }
  });
});
