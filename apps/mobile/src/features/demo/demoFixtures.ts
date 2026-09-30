import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  type OrchestrationThreadShell,
  ServerConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Sample data for demo mode. Everything is decoded through the real contract
 * schemas, so the demo environment feeds the same state layer and screens as a
 * paired computer.
 */

export const DEMO_ENVIRONMENT_ID = EnvironmentId.make("demo-mac");
export const DEMO_ENVIRONMENT_LABEL = "Demo Mac";
/** Never contacted: the demo session is served in-process. */
export const DEMO_HTTP_BASE_URL = "https://demo.controlplane.invalid";
export const DEMO_WS_BASE_URL = "wss://demo.controlplane.invalid";

export const DEMO_UNAVAILABLE_MESSAGE = "Demo mode: connect a computer to do this.";

const MODEL_SELECTION = { instanceId: "claudeAgent", model: "claude-opus-4-6" } as const;
const CODEX_SELECTION = { instanceId: "codex", model: "gpt-5.4" } as const;

export const DEMO_PROJECT_IDS = {
  launch: "demo-project-launch",
  mobile: "demo-project-mobile",
  web: "demo-tasks-acme-web",
  api: "demo-tasks-api-server",
} as const;

export const DEMO_THREAD_IDS = {
  launchCoordinator: "demo-thread-launch-coordinator",
  heroLayout: "demo-thread-hero-layout",
  blogPost: "demo-thread-blog-post",
  mobileCoordinator: "demo-thread-mobile-coordinator",
  darkMode: "demo-thread-dark-mode",
  pricingCopy: "demo-thread-pricing-copy",
  reactUpgrade: "demo-thread-react-upgrade",
  rateLimit: "demo-thread-rate-limit",
  slowSearch: "demo-thread-slow-search",
} as const;

export const DEMO_APPROVAL_REQUEST_ID = "demo-approval-run-tests";
export const DEMO_QUESTION_REQUEST_ID = "demo-question-pricing-tone";

const decodeServerConfig = Schema.decodeUnknownSync(ServerConfig);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);
const decodeShellSnapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot);

function minutesAgo(now: number, minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

export function makeDemoServerConfig(now: number): ServerConfig {
  const checkedAt = new Date(now).toISOString();
  const provider = (input: {
    readonly instanceId: string;
    readonly driver: string;
    readonly displayName: string;
    readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  }) => ({
    instanceId: input.instanceId,
    driver: input.driver,
    displayName: input.displayName,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: input.models.map((model, index) => ({
      slug: model.slug,
      name: model.name,
      isCustom: false,
      isDefault: index === 0,
      capabilities: null,
    })),
  });
  return decodeServerConfig({
    environment: {
      environmentId: DEMO_ENVIRONMENT_ID,
      label: DEMO_ENVIRONMENT_LABEL,
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "demo",
      capabilities: {
        repositoryIdentity: false,
        connectionProbe: true,
        threadSettlement: true,
        threadSnooze: true,
        threadPinning: true,
        assistants: true,
      },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "/Users/demo",
    keybindingsConfigPath: "/Users/demo/.config/control-plane/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      provider({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "Claude",
        models: [
          { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
          { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        ],
      }),
      provider({
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
      }),
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/Users/demo/.control-plane/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    // Decodes to the server defaults, like a fresh install.
    settings: {},
    shellResumeCompletionMarker: true,
    threadResumeCompletionMarker: true,
  });
}

interface DemoProjectInput {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly coordinatorThreadId?: string;
  readonly icon: { readonly kind: "emoji"; readonly emoji: string } | null;
  readonly createdMinutesAgo: number;
}

const DEMO_PROJECTS: ReadonlyArray<DemoProjectInput> = [
  {
    id: DEMO_PROJECT_IDS.launch,
    title: "Website Launch",
    workspaceRoot: "/Users/demo/Projects/website-launch",
    coordinatorThreadId: DEMO_THREAD_IDS.launchCoordinator,
    icon: { kind: "emoji", emoji: "🚀" },
    createdMinutesAgo: 60 * 24 * 6,
  },
  {
    id: DEMO_PROJECT_IDS.mobile,
    title: "Mobile App",
    workspaceRoot: "/Users/demo/Projects/mobile-app",
    coordinatorThreadId: DEMO_THREAD_IDS.mobileCoordinator,
    icon: { kind: "emoji", emoji: "📱" },
    createdMinutesAgo: 60 * 24 * 4,
  },
  {
    id: DEMO_PROJECT_IDS.web,
    title: "acme-web",
    workspaceRoot: "/Users/demo/Code/acme-web",
    icon: null,
    createdMinutesAgo: 60 * 24 * 20,
  },
  {
    id: DEMO_PROJECT_IDS.api,
    title: "api-server",
    workspaceRoot: "/Users/demo/Code/api-server",
    icon: null,
    createdMinutesAgo: 60 * 24 * 30,
  },
];

type DemoMessage = readonly [role: "user" | "assistant", text: string, minutesAgo: number];

interface DemoThreadInput {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly codex?: boolean;
  readonly state: "running" | "completed";
  readonly settledMinutesAgo?: number;
  readonly messages: ReadonlyArray<DemoMessage>;
  readonly activities?: (now: number, turnId: string) => ReadonlyArray<unknown>;
  readonly planProgress?: {
    readonly step: string;
    readonly completedSteps: number;
    readonly totalSteps: number;
  };
}

const DEMO_THREADS: ReadonlyArray<DemoThreadInput> = [
  {
    id: DEMO_THREAD_IDS.launchCoordinator,
    projectId: DEMO_PROJECT_IDS.launch,
    title: "Launch coordinator",
    branch: null,
    state: "completed",
    messages: [
      ["user", "Plan the launch for Friday. Split it into agents and keep me posted.", 190],
      [
        "assistant",
        [
          "Here is the plan for Friday's launch. I started two agents:",
          "",
          "1. **Fix hero image layout on mobile**: the hero crops badly under 400px wide. Running now.",
          "2. **Write launch blog post**: draft is done and ready for your review.",
          "",
          "I will check back when the layout fix lands and run the full test suite before we ship.",
        ].join("\n"),
        185,
      ],
      ["user", "Great. Make sure the blog post links to the pricing page.", 40],
      [
        "assistant",
        "Done. The post now links to `/pricing` in the intro and the closing call to action.",
        38,
      ],
    ],
  },
  {
    id: DEMO_THREAD_IDS.heroLayout,
    projectId: DEMO_PROJECT_IDS.launch,
    title: "Fix hero image layout on mobile",
    branch: "fix/hero-mobile-layout",
    state: "running",
    planProgress: { step: "Running visual checks", completedSteps: 2, totalSteps: 4 },
    messages: [
      [
        "user",
        "The hero image crops the headline on small phones. Fix it and check 320, 375 and 430 widths.",
        30,
      ],
      [
        "assistant",
        [
          "Found it: `Hero.tsx` sets a fixed `height: 520px` and `object-fit: cover`, so narrow screens lose the top of the image.",
          "",
          "- Switched to `aspect-ratio: 4 / 3` below 480px",
          "- Moved the headline above the image on small screens",
          "",
          "Running visual checks at 320, 375 and 430 now.",
        ].join("\n"),
        12,
      ],
    ],
  },
  {
    id: DEMO_THREAD_IDS.blogPost,
    projectId: DEMO_PROJECT_IDS.launch,
    title: "Write launch blog post",
    branch: "docs/launch-post",
    state: "completed",
    settledMinutesAgo: 90,
    messages: [
      ["user", "Draft a short launch post: what it is, who it is for, one screenshot.", 180],
      [
        "assistant",
        [
          "Draft saved to `content/blog/launch.md` (640 words).",
          "",
          "**Outline**",
          "- What we built and why",
          "- Three things you can do on day one",
          "- Pricing and how to get started",
          "",
          "I used `hero-dashboard.png` as the screenshot. Want a shorter version for social?",
        ].join("\n"),
        150,
      ],
    ],
  },
  {
    id: DEMO_THREAD_IDS.mobileCoordinator,
    projectId: DEMO_PROJECT_IDS.mobile,
    title: "Mobile app coordinator",
    branch: null,
    state: "completed",
    messages: [
      ["user", "Next up is dark mode. Get an agent on it.", 70],
      [
        "assistant",
        "Started **Add dark mode toggle**. It is waiting on your approval to run the settings tests.",
        55,
      ],
    ],
  },
  {
    id: DEMO_THREAD_IDS.darkMode,
    projectId: DEMO_PROJECT_IDS.mobile,
    title: "Add dark mode toggle",
    branch: "feat/dark-mode-toggle",
    codex: true,
    state: "running",
    messages: [
      [
        "user",
        "Add a dark mode toggle to Settings > Appearance. Follow the system by default.",
        65,
      ],
      [
        "assistant",
        [
          "Added `ThemeToggle` with three options: System, Light and Dark. The choice is saved per device.",
          "",
          "Next I want to run the settings test suite to make sure nothing else changed.",
        ].join("\n"),
        52,
      ],
    ],
    activities: (now, turnId) => [
      {
        id: "demo-activity-approval-requested",
        tone: "approval",
        kind: "approval.requested",
        summary: "Run tests",
        payload: {
          requestId: DEMO_APPROVAL_REQUEST_ID,
          requestKind: "command",
          detail: "pnpm test --filter settings",
        },
        turnId,
        createdAt: minutesAgo(now, 51),
      },
    ],
  },
  {
    id: DEMO_THREAD_IDS.pricingCopy,
    projectId: DEMO_PROJECT_IDS.web,
    title: "Update pricing page copy",
    branch: "copy/pricing-refresh",
    state: "running",
    messages: [
      ["user", "Refresh the pricing page copy. Keep it short.", 25],
      ["assistant", "I have two directions for the headline. Which tone do you want?", 22],
    ],
    activities: (now, turnId) => [
      {
        id: "demo-activity-question-requested",
        tone: "info",
        kind: "user-input.requested",
        summary: "Question",
        payload: {
          requestId: DEMO_QUESTION_REQUEST_ID,
          questions: [
            {
              id: "tone",
              header: "Headline tone",
              question: "Which tone should the pricing headline use?",
              options: [
                { label: "Friendly", description: "Simple pricing that grows with you." },
                { label: "Direct", description: "One plan. Every feature. No surprises." },
              ],
              multiSelect: false,
            },
          ],
        },
        turnId,
        createdAt: minutesAgo(now, 22),
      },
    ],
  },
  {
    id: DEMO_THREAD_IDS.reactUpgrade,
    projectId: DEMO_PROJECT_IDS.web,
    title: "Upgrade React to 19",
    branch: "chore/react-19",
    state: "completed",
    messages: [
      ["user", "Upgrade React to 19 and fix anything that breaks.", 60 * 26],
      [
        "assistant",
        [
          "Upgraded `react` and `react-dom` to 19.1. Two fixes were needed:",
          "",
          "- Replaced `ReactDOM.render` with `createRoot` in `main.tsx`",
          "- Removed a `defaultProps` usage in `Button.tsx`",
          "",
          "All 214 tests pass.",
        ].join("\n"),
        60 * 25,
      ],
    ],
  },
  {
    id: DEMO_THREAD_IDS.rateLimit,
    projectId: DEMO_PROJECT_IDS.api,
    title: "Add rate limiting to /login",
    branch: "feat/login-rate-limit",
    codex: true,
    state: "completed",
    messages: [
      ["user", "Rate limit /login to 5 attempts per minute per IP.", 60 * 5],
      [
        "assistant",
        [
          "Added a sliding window limiter in `middleware/rateLimit.ts`:",
          "",
          "```ts",
          'app.post("/login", rateLimit({ windowMs: 60_000, max: 5 }), login);',
          "```",
          "",
          "Returns `429` with a `Retry-After` header. Added 3 tests.",
        ].join("\n"),
        60 * 5 - 8,
      ],
    ],
  },
  {
    id: DEMO_THREAD_IDS.slowSearch,
    projectId: DEMO_PROJECT_IDS.api,
    title: "Investigate slow search query",
    branch: null,
    state: "completed",
    messages: [
      ["user", "Search takes 3 seconds on large accounts. Why?", 60 * 8],
      [
        "assistant",
        "The `ILIKE '%term%'` filter on `documents.title` scans the whole table. A trigram index brings it to about 40ms on the staging copy. Want me to add the migration?",
        60 * 8 - 15,
      ],
    ],
  },
];

function buildThread(input: DemoThreadInput, now: number): OrchestrationThread {
  const turnId = `${input.id}-turn-1`;
  const first = input.messages[0];
  const last = input.messages[input.messages.length - 1];
  const createdAt = minutesAgo(now, (first?.[2] ?? 0) + 1);
  const updatedAt = minutesAgo(now, last?.[2] ?? 0);
  const running = input.state === "running";
  const lastAssistant = input.messages.findLast(([role]) => role === "assistant");
  const selection = input.codex ? CODEX_SELECTION : MODEL_SELECTION;
  return decodeThread({
    id: input.id,
    projectId: input.projectId,
    title: input.title,
    modelSelection: selection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: input.branch,
    worktreePath: null,
    latestTurn: {
      turnId,
      state: running ? "running" : "completed",
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: running ? null : updatedAt,
      assistantMessageId:
        lastAssistant === undefined ? null : `${input.id}-message-${input.messages.length - 1}`,
    },
    createdAt,
    updatedAt,
    archivedAt: null,
    settledOverride: input.settledMinutesAgo === undefined ? null : "settled",
    settledAt:
      input.settledMinutesAgo === undefined ? null : minutesAgo(now, input.settledMinutesAgo),
    deletedAt: null,
    messages: input.messages.map(([role, text, age], index) => ({
      id: `${input.id}-message-${index}`,
      role,
      text,
      turnId,
      streaming: false,
      createdAt: minutesAgo(now, age),
      updatedAt: minutesAgo(now, age),
    })),
    proposedPlans: [],
    activities: input.activities?.(now, turnId) ?? [],
    checkpoints: [],
    session: {
      threadId: input.id,
      status: running ? "running" : "ready",
      providerName: input.codex ? "Codex" : "Claude",
      providerInstanceId: selection.instanceId,
      runtimeMode: "approval-required",
      activeTurnId: running ? turnId : null,
      lastError: null,
      updatedAt,
    },
  });
}

/** Projects the full thread onto the shell row the Home list renders. */
export function demoThreadShell(
  thread: OrchestrationThread,
  planProgress: DemoThreadInput["planProgress"] | null = null,
): OrchestrationThreadShell {
  const pending = derivePendingRequests(thread.activities);
  const latestUserMessage = thread.messages.findLast((m) => m.role === "user");
  const running = thread.latestTurn?.state === "running";
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    pullRequests: thread.pullRequests,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    unsettledAt: thread.unsettledAt ?? null,
    snoozedUntil: thread.snoozedUntil ?? null,
    snoozedAt: thread.snoozedAt ?? null,
    pinnedAt: thread.pinnedAt ?? null,
    session: thread.session,
    latestUserMessageAt: latestUserMessage?.createdAt ?? null,
    hasPendingApprovals: pending.approvals.length > 0,
    hasPendingUserInput: pending.userInputs.length > 0,
    hasActionableProposedPlan: false,
    planProgress: running ? planProgress : null,
  };
}

export interface DemoData {
  readonly serverConfig: ServerConfig;
  readonly projects: OrchestrationShellSnapshot["projects"];
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly planProgressByThreadId: ReadonlyMap<
    string,
    NonNullable<DemoThreadInput["planProgress"]>
  >;
}

export function makeDemoData(now: number = Date.now()): DemoData {
  const threads = DEMO_THREADS.map((input) => buildThread(input, now));
  const snapshot = decodeShellSnapshot({
    snapshotSequence: 1,
    updatedAt: new Date(now).toISOString(),
    threads: [],
    projects: DEMO_PROJECTS.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      defaultModelSelection: MODEL_SELECTION,
      ...(project.icon === null ? {} : { projectIcon: project.icon }),
      ...(project.coordinatorThreadId === undefined
        ? {}
        : { assistant: { coordinatorThreadId: project.coordinatorThreadId } }),
      scripts: [],
      createdAt: minutesAgo(now, project.createdMinutesAgo),
      updatedAt: minutesAgo(now, project.createdMinutesAgo),
    })),
  });
  const planProgressByThreadId = new Map<string, NonNullable<DemoThreadInput["planProgress"]>>();
  for (const input of DEMO_THREADS) {
    if (input.planProgress !== undefined) planProgressByThreadId.set(input.id, input.planProgress);
  }
  return {
    serverConfig: makeDemoServerConfig(now),
    projects: snapshot.projects,
    threads,
    planProgressByThreadId,
  };
}
