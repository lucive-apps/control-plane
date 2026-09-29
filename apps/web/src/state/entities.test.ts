import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { makeWorkspaceProjectsAtom, resolveThreadDetailRef } from "./entities";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("resolveThreadDetailRef", () => {
  it("does not subscribe to a reserved draft thread before it enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: true,
      }),
    ).toBeNull();
  });

  it("subscribes once the reserved draft thread enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: true,
        waitForShell: true,
      }),
    ).toBe(threadRef);
  });

  it("keeps direct server-thread lookups enabled when the shell has not loaded it", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: false,
      }),
    ).toBe(threadRef);
  });
});

describe("makeWorkspaceProjectsAtom", () => {
  const workspace = { id: "workspace", title: "Website", assistant: null };
  const project = {
    id: "project",
    title: "Personal",
    assistant: { coordinatorThreadId: ThreadId.make("thread-coordinator") },
  };

  it("keeps the same list while only a Project changes, and follows workspace changes", () => {
    const source = Atom.make<ReadonlyArray<typeof workspace | typeof project>>([
      workspace,
      project,
    ]);
    const workspaces = makeWorkspaceProjectsAtom(source);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(workspaces);

    const initial = registry.get(workspaces);
    expect(initial).toEqual([workspace]);

    registry.set(source, [workspace, { ...project, title: "Renamed" }]);
    expect(registry.get(workspaces)).toBe(initial);

    const renamedWorkspace = { ...workspace, title: "Site" };
    registry.set(source, [renamedWorkspace, project]);
    expect(registry.get(workspaces)).toEqual([renamedWorkspace]);

    unmount();
  });
});
