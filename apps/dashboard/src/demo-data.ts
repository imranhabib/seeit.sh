export type Harness = "claude" | "codex";
export type HarnessFilter = Harness | "all";
export type TimeRange = "24h" | "7d" | "30d";

export type DemoSessionSummary = {
  id: string;
  label: string;
  harness: Harness;
  model: string;
  startedAt: number;
  lastCallAt: number;
  callCount: number;
  turnCount: number;
  totalTokens: number;
  cacheReadTokens: number;
  interruptedCalls: number;
  compactions: number;
};

export type AllocationCategoryId = "tools" | "context" | "instructions" | "messages" | "output";

export type AllocationSlice = {
  label: string;
  detail?: string;
  tokens: number;
};

export type AllocationCategory = {
  id: AllocationCategoryId;
  label: string;
  description: string;
  tokens: number;
  slices: AllocationSlice[];
};

export type QuotaWindow = {
  harness: Harness;
  window: string;
  usedPercent: number;
  observedAt: number;
  resetsAt: number;
  windowMinutes: number | null;
};

type Usage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

type Overview = Usage & {
  totalTokens: number;
  callCount: number;
  interruptedCalls: number;
  sessionCount: number;
  series: { at: number; claude: number; codex: number }[];
  sessions: DemoSessionSummary[];
  quota: QuotaWindow[];
};

type Call = Usage & {
  id: string;
  harness: Harness;
  sessionId: string | null;
  turnId: string | null;
  startedAt: number;
  completion: "complete" | "client_aborted";
  kind: "turn" | "background";
  compactionTrigger: "auto" | null;
};

type SessionFixture = {
  label: string;
  harness: Harness;
  lastCallHoursAgo: number;
  callCount: number;
  cadenceMinutes: number;
  contextTokens: number;
  compactionAt?: number;
  interruptAt?: number;
};

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
export const demoNow = Date.parse("2026-11-17T19:00:00Z");

const recentSessions: SessionFixture[] = [
  { label: "Review ledger delivery", harness: "claude", lastCallHoursAgo: 0.2, callCount: 21, cadenceMinutes: 6, contextTokens: 24_800, compactionAt: 14 },
  { label: "Add usage report filters", harness: "codex", lastCallHoursAgo: 0.6, callCount: 16, cadenceMinutes: 9, contextTokens: 18_400 },
  { label: "Inspect cache reuse", harness: "claude", lastCallHoursAgo: 2.4, callCount: 18, cadenceMinutes: 11, contextTokens: 15_800 },
  { label: "Trace recording retries", harness: "codex", lastCallHoursAgo: 3.2, callCount: 11, cadenceMinutes: 12, contextTokens: 13_200, interruptAt: 7 },
  { label: "Check query pagination", harness: "codex", lastCallHoursAgo: 5.7, callCount: 17, cadenceMinutes: 10, contextTokens: 22_200 },
  { label: "Review usage estimates", harness: "claude", lastCallHoursAgo: 6.5, callCount: 23, cadenceMinutes: 9, contextTokens: 20_400, compactionAt: 17, interruptAt: 20 },
  { label: "Summarize parser changes", harness: "claude", lastCallHoursAgo: 10.2, callCount: 9, cadenceMinutes: 12, contextTokens: 11_600 },
  { label: "Validate local setup", harness: "codex", lastCallHoursAgo: 10.7, callCount: 14, cadenceMinutes: 16, contextTokens: 12_400 },
  { label: "Review streaming tests", harness: "claude", lastCallHoursAgo: 13.1, callCount: 16, cadenceMinutes: 13, contextTokens: 17_600 },
  { label: "Compare session attribution", harness: "codex", lastCallHoursAgo: 14.6, callCount: 12, cadenceMinutes: 12, contextTokens: 14_500 },
  { label: "Check call timing fields", harness: "claude", lastCallHoursAgo: 16.3, callCount: 14, cadenceMinutes: 14, contextTokens: 13_650 },
  { label: "Audit quota windows", harness: "codex", lastCallHoursAgo: 17.1, callCount: 19, cadenceMinutes: 14, contextTokens: 10_900, compactionAt: 12 },
  { label: "Inspect model usage columns", harness: "claude", lastCallHoursAgo: 20.2, callCount: 19, cadenceMinutes: 9, contextTokens: 11_400 },
  { label: "Read the delivery plan", harness: "codex", lastCallHoursAgo: 21.6, callCount: 12, cadenceMinutes: 14, contextTokens: 9_100 },
  { label: "Check retention boundaries", harness: "claude", lastCallHoursAgo: 23.0, callCount: 9, cadenceMinutes: 15, contextTokens: 14_000 },
];

const olderSessions: SessionFixture[] = Array.from({ length: 29 }, (_, index) => {
  const hoursAgo = (index + 1) * 24;
  return [
    {
      label: "Review gateway changes",
      harness: "claude" as const,
      lastCallHoursAgo: hoursAgo + 4,
      callCount: 12 + (index * 7) % 15,
      cadenceMinutes: 9 + index % 5,
      contextTokens: 7_000 + (index * 2_700) % 17_000,
    },
    {
      label: "Verify ledger behavior",
      harness: "codex" as const,
      lastCallHoursAgo: hoursAgo + 8,
      callCount: 10 + (index * 5) % 14,
      cadenceMinutes: 11 + index % 4,
      contextTokens: 8_000 + (index * 3_400) % 11_000,
    },
  ];
}).flat();

const modelForHarness = { claude: "claude-sonnet-5-5", codex: "gpt-6-luna" };

const sessions = [...recentSessions, ...olderSessions].map((fixture, sessionIndex) => {
  const id = `demo-session-${sessionIndex + 1}`;
  const lastCallAt = demoNow - Math.round(fixture.lastCallHoursAgo * hour);
  const startedAt = lastCallAt - (fixture.callCount - 1) * fixture.cadenceMinutes * minute;
  const calls = Array.from({ length: fixture.callCount }, (_, index): Call => {
    const compaction = index === fixture.compactionAt;
    const interrupted = index === fixture.interruptAt;
    // The context grows within each session and falls once compaction takes effect.
    const sinceCompaction = fixture.compactionAt !== undefined && index > fixture.compactionAt
      ? index - fixture.compactionAt - 1
      : index;
    const context = Math.round(fixture.contextTokens * (
      0.65 + sinceCompaction * 0.045 + ((index * 3 + sessionIndex) % 7) * 0.04
    ));
    const cacheReadTokens = Math.round(context * (index % 6 === 0 ? 0.42 : 0.82));
    const cacheWriteTokens = fixture.harness === "claude" ? Math.round((context - cacheReadTokens) * 0.45) : 0;
    const outputTokens = interrupted ? 260 : 550 + ((index * 313 + sessionIndex * 89) % 1_600);
    return {
      id: `${id}-call-${index + 1}`,
      harness: fixture.harness,
      sessionId: id,
      turnId: `${id}-turn-${1 + Math.floor(index / 4)}`,
      startedAt: startedAt + index * fixture.cadenceMinutes * minute,
      kind: compaction ? "background" : "turn",
      completion: interrupted ? "client_aborted" : "complete",
      compactionTrigger: compaction ? "auto" : null,
      inputTokens: context - cacheReadTokens - cacheWriteTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
    };
  });
  return { id, label: fixture.label, harness: fixture.harness, startedAt, lastCallAt, calls };
});

// A background model call with no session contributes usage without creating a row.
const calls: Call[] = [
  ...sessions.flatMap((session) => session.calls),
  {
    id: "demo-background-1",
    harness: "codex",
    sessionId: null,
    turnId: null,
    startedAt: demoNow - 70 * minute,
    kind: "background",
    completion: "complete",
    compactionTrigger: null,
    inputTokens: 5_250,
    cacheReadTokens: 3_100,
    cacheWriteTokens: 0,
    outputTokens: 210,
  },
];

function quotaObservation(harness: Harness, window: string, usedPercent: number, resetsIn: number, windowMinutes: number | null) {
  const [call] = calls
    .filter((entry) => entry.harness === harness && entry.kind === "turn")
    .sort((a, b) => b.startedAt - a.startedAt);
  return {
    callId: call.id,
    harness,
    window,
    usedPercent,
    observedAt: call.startedAt,
    resetsAt: demoNow + resetsIn,
    windowMinutes,
  };
}

const quotaWindows = [
  quotaObservation("claude", "5h", 42, 105 * minute, null),
  quotaObservation("claude", "7d", 31, 3 * day + 5 * hour, null),
  quotaObservation("codex", "primary", 67, 183 * minute, 300),
  quotaObservation("codex", "secondary", 54, 2 * day + 12 * hour, 10_080),
];

const ranges = {
  "24h": { duration: day, step: hour },
  "7d": { duration: 7 * day, step: 6 * hour },
  "30d": { duration: 30 * day, step: day },
};

function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
}

function summarize(visibleCalls: readonly Call[]) {
  const usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  let interruptedCalls = 0;
  for (const call of visibleCalls) {
    usage.inputTokens += call.inputTokens;
    usage.cacheReadTokens += call.cacheReadTokens;
    usage.cacheWriteTokens += call.cacheWriteTokens;
    usage.outputTokens += call.outputTokens;
    if (call.completion !== "complete") interruptedCalls += 1;
  }
  return { ...usage, totalTokens: totalTokens(usage), callCount: visibleCalls.length, interruptedCalls };
}

function sessionSummary(session: typeof sessions[number]): DemoSessionSummary {
  const { callCount, totalTokens, cacheReadTokens, interruptedCalls } = summarize(session.calls);
  const turnIds = session.calls.flatMap((call) => call.kind === "turn" && call.turnId ? [call.turnId] : []);
  return {
    id: session.id,
    label: session.label,
    harness: session.harness,
    model: modelForHarness[session.harness],
    startedAt: session.startedAt,
    lastCallAt: session.lastCallAt,
    callCount,
    turnCount: new Set(turnIds).size,
    totalTokens,
    cacheReadTokens,
    interruptedCalls,
    compactions: session.calls.filter((call) => call.compactionTrigger !== null).length,
  };
}

export function getOverview(range: TimeRange, harness: HarnessFilter): Overview {
  const { duration, step } = ranges[range];
  const start = demoNow - duration;
  const visibleCalls = calls.filter((call) =>
    call.startedAt >= start && call.startedAt < demoNow && (harness === "all" || harness === call.harness)
  );
  const series = Array.from({ length: duration / step }, (_, index) => ({
    at: start + index * step,
    claude: 0,
    codex: 0,
  }));
  const sessionIds = new Set<string>();
  for (const call of visibleCalls) {
    const bucket = series[Math.floor((call.startedAt - start) / step)];
    bucket[call.harness] += totalTokens(call);
    if (call.sessionId) sessionIds.add(`${call.harness}/${call.sessionId}`);
  }

  return {
    ...summarize(visibleCalls),
    sessionCount: sessionIds.size,
    series,
    sessions: sessions
      .filter((session) => sessionIds.has(`${session.harness}/${session.id}`))
      .sort((a, b) => b.lastCallAt - a.lastCallAt)
      .slice(0, 6)
      .map(sessionSummary),
    quota: quotaWindows.filter((window) => harness === "all" || harness === window.harness),
  };
}

const toolNames = {
  claude: ["Read", "Grep", "Bash", "Edit", "Read", "Glob", "Bash", "Agent"],
  codex: ["exec_command", "apply_patch", "exec_command", "spawn_agent", "exec_command", "apply_patch"],
};

export function getSessionAllocation({ id, harness }: Pick<DemoSessionSummary, "id" | "harness">): AllocationCategory[] {
  const session = sessions.find((entry) => entry.id === id && entry.harness === harness);
  if (!session) return [];

  const firstInput = totalTokens(session.calls[0]) - session.calls[0].outputTokens;
  const instructions = Math.round(firstInput * 0.14);
  const schemas = Math.round(firstInput * 0.12);
  const toolInterval = Math.max(2, Math.ceil((session.calls.length - 1) / 8));
  const tools: AllocationSlice[] = [];
  const turns = new Map<Call["turnId"], { label: string; context: number; lastContext: number; messages: number }>();
  let resultTokens = 0;
  let answerTokens = 0;
  let reasoningTokens = 0;
  let compactionTokens = 0;

  // These fixtures partition each call's known tokens. A tool result uses input from the next call.
  for (const [index, call] of session.calls.entries()) {
    const prior = turns.get(call.turnId);
    const turn = prior ?? { label: `Turn ${turns.size + 1}`, context: 0, lastContext: 0, messages: 0 };
    const conversation = totalTokens(call) - call.outputTokens - instructions - schemas - resultTokens;
    const messageTokens = call.kind === "turn" && turn.messages === 0
      ? Math.round(conversation * (index === 0 ? 1 : 0.18))
      : 0;
    turn.lastContext = conversation - messageTokens;
    turn.context += turn.lastContext;
    turn.messages += messageTokens;
    turns.set(call.turnId, turn);

    resultTokens = 0;
    let argumentTokens = 0;
    const nextCall = session.calls[index + 1];
    if (nextCall && index % toolInterval === 0 && call.kind === "turn" && call.completion === "complete") {
      const nextInput = totalTokens(nextCall) - nextCall.outputTokens;
      resultTokens = Math.round(nextInput * (0.14 + (index % 5) * 0.04));
      argumentTokens = Math.round(call.outputTokens * 0.18);
      const names = toolNames[harness];
      tools.push({ label: names[tools.length % names.length], detail: `Model call ${index + 1}`, tokens: argumentTokens + resultTokens });
    }

    const remainingOutput = call.outputTokens - argumentTokens;
    if (call.compactionTrigger) {
      compactionTokens += remainingOutput;
    } else {
      const reasoning = Math.round(remainingOutput * 0.23);
      reasoningTokens += reasoning;
      answerTokens += remainingOutput - reasoning;
    }
  }

  const categories: Omit<AllocationCategory, "tokens">[] = [
    { id: "tools", label: "Tool calls", description: "Tool arguments and result tokens first sent back to the model, grouped by invocation.", slices: tools },
    {
      id: "context", label: "Accumulated context",
      description: "Earlier messages and tool results sent again as model input, grouped by turn.",
      slices: [...turns.values()].map((turn) => ({
        label: turn.label,
        detail: turn.lastContext.toLocaleString("en-US") + " carried on last call",
        tokens: turn.context,
      })),
    },
    {
      id: "instructions", label: "Instructions & schemas",
      description: "System instructions and tool definitions included in model input.",
      slices: [
        { label: "System instructions", tokens: instructions * session.calls.length },
        { label: "Tool definitions", tokens: schemas * session.calls.length },
      ],
    },
    {
      id: "messages", label: "New messages", description: "New user input at the start of each turn.",
      slices: [...turns.values()].map((turn) => ({ label: turn.label, tokens: turn.messages })),
    },
    {
      id: "output", label: "Model output", description: "Answer text, reasoning, and any compaction summary tokens.",
      slices: [
        { label: "Answer text", tokens: answerTokens },
        { label: "Reasoning", tokens: reasoningTokens },
        { label: "Compaction summaries", tokens: compactionTokens },
      ],
    },
  ];
  return categories.map(({ slices, ...category }) => ({
    ...category,
    tokens: slices.reduce((sum, slice) => sum + slice.tokens, 0),
    slices: slices.filter((slice) => slice.tokens > 0),
  }));
}
