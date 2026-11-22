import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Button, Descriptions, Drawer, Progress, Segmented, Select, Table } from "antd";
import type { TableColumnsType } from "antd";
import {
  demoNow,
  getOverview,
  type DemoSessionSummary,
  type Harness,
  type HarnessFilter,
  type QuotaWindow,
  type TimeRange,
} from "./demo-data.ts";
import { chartColors, compactFormat, dateTimeFormat, harnessNames, numberFormat, percentFormat } from "./format.ts";

const UsageChart = lazy(() => import("./UsageChart.tsx"));
const SessionAllocation = lazy(() => import("./SessionAllocation.tsx"));

const rangeOptions: { label: string; value: TimeRange }[] = [
  { label: "Last 24 hours", value: "24h" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
];

const harnessOptions: { label: string; value: HarnessFilter }[] = [
  { label: "All", value: "all" },
  { label: "Claude Code", value: "claude" },
  { label: "Codex", value: "codex" },
];

const harnessGroups: Record<HarnessFilter, Harness[]> = {
  all: ["claude", "codex"],
  claude: ["claude"],
  codex: ["codex"],
};

type Filters = { range: TimeRange; harness: HarnessFilter };
type Detail = { kind: "usage" } | { kind: "session"; session: DemoSessionSummary };

function filtersFromUrl(): Filters {
  const params = new URLSearchParams(window.location.search);
  return {
    range: rangeOptions.find((option) => option.value === params.get("range"))?.value ?? "24h",
    harness: harnessOptions.find((option) => option.value === params.get("harness"))?.value ?? "all",
  };
}

const relativeTime = new Intl.RelativeTimeFormat("en-US", { numeric: "always" });

function lastSeen(timestamp: number) {
  const minutes = Math.max(0, Math.floor((demoNow - timestamp) / 60_000));
  if (minutes === 0) return "Just now";
  if (minutes < 60) return relativeTime.format(-minutes, "minute");
  if (minutes < 1_440) return relativeTime.format(-Math.floor(minutes / 60), "hour");
  return relativeTime.format(-Math.floor(minutes / 1_440), "day");
}

function Metric({ id, label, value, caption }: { id?: string; label: string; value: string; caption: string }) {
  return (
    <div id={id} className="metric">
      <dt>{label}</dt>
      <dd className="metric-value">{value}</dd>
      <dd className="metric-caption">{caption}</dd>
    </div>
  );
}

function HarnessDot({ harness }: { harness: Harness }) {
  return <span className="harness-dot" style={{ backgroundColor: chartColors[harness] }} aria-hidden="true" />;
}

function QuotaMeter({ quota }: { quota: QuotaWindow }) {
  return (
    <div className="quota-meter">
      <div className="quota-line">
        <span className="harness-label"><HarnessDot harness={quota.harness} />{harnessNames[quota.harness]}</span>
        <strong>{percentFormat.format(quota.usedPercent / 100)}</strong>
      </div>
      <Progress percent={quota.usedPercent} showInfo={false} strokeColor={chartColors[quota.harness]} />
      <p className="quota-reset">
        Resets <time dateTime={new Date(quota.resetsAt).toISOString()}>{dateTimeFormat.format(quota.resetsAt)}</time>
      </p>
    </div>
  );
}

export default function Overview() {
  const [{ range, harness }, setFilters] = useState(filtersFromUrl);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selectedSession, setSelectedSession] = useState<DemoSessionSummary | null>(null);
  const usagePanel = useRef<HTMLElement>(null);
  const data = useMemo(() => getOverview(range, harness), [range, harness]);
  const harnesses = harnessGroups[harness];
  const shortTermQuota = data.quota.filter((entry) => entry.window === "5h" || entry.window === "primary");
  const inputTotal = data.inputTokens + data.cacheReadTokens + data.cacheWriteTokens;
  const cacheShare = inputTotal > 0 ? percentFormat.format(data.cacheReadTokens / inputTotal) : "—";

  useEffect(() => {
    const restore = () => {
      setFilters(filtersFromUrl());
      setSelectedSession(null);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  useEffect(() => {
    if (!selectedSession) return;
    usagePanel.current?.focus({ preventScroll: true });
    usagePanel.current?.scrollIntoView({ block: "start" });
  }, [selectedSession]);

  function updateFilters(next: Filters) {
    const url = new URL(window.location.href);
    url.searchParams.set("range", next.range);
    url.searchParams.set("harness", next.harness);
    window.history.pushState(null, "", url);
    setFilters(next);
    setSelectedSession(null);
  }

  function isSelected(session: DemoSessionSummary) {
    return selectedSession?.id === session.id && selectedSession.harness === session.harness;
  }

  const sessionColumns: TableColumnsType<DemoSessionSummary> = [
    {
      title: "Session",
      key: "session",
      render: (_, session) => (
        <>
          <Button type="link" className="session-link" aria-pressed={isSelected(session)} aria-controls="overview-usage">
            {session.label}
          </Button>
          <span className="session-harness harness-label">
            <HarnessDot harness={session.harness} />{harnessNames[session.harness]}
          </span>
        </>
      ),
    },
    {
      title: "Calls",
      dataIndex: "callCount",
      align: "right",
      responsive: ["sm"],
      render: (value: number) => numberFormat.format(value),
    },
    {
      title: "Tokens",
      dataIndex: "totalTokens",
      align: "right",
      render: (value: number) => <span className="session-tokens">{compactFormat.format(value)}</span>,
    },
    {
      title: "Last active",
      dataIndex: "lastCallAt",
      align: "right",
      responsive: ["lg"],
      render: (value: number) => (
        <time dateTime={new Date(value).toISOString()} title={dateTimeFormat.format(value)}>{lastSeen(value)}</time>
      ),
    },
  ];

  return (
    <div className="dashboard-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="shell-header">
        <div className="wordmark">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>seeit<span className="wordmark-domain">.sh</span></span>
        </div>
        <span className="data-source"><span aria-hidden="true" />Synthetic data</span>
      </header>

      <div className="shell-body">
        <aside className="sidebar">
          <nav aria-label="Overview sections" className="side-nav">
            <a href="#main" aria-current="page"><span aria-hidden="true">▦</span>Overview</a>
            <a href="#sessions"><span aria-hidden="true">≡</span>Sessions</a>
            <a href="#cache"><span aria-hidden="true">◇</span>Cache</a>
            <a href="#quota"><span aria-hidden="true">◷</span>Quota</a>
          </nav>
          <div className="snapshot">
            <span>Ledger snapshot</span>
            <time dateTime={new Date(demoNow).toISOString()}>{dateTimeFormat.format(demoNow)}</time>
          </div>
        </aside>

        <main id="main" className="overview" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <h1>Overview</h1>
              <p>Token usage across Claude Code and Codex</p>
            </div>
            <div className="filters">
              <Segmented<HarnessFilter>
                aria-label="Harness"
                options={harnessOptions}
                value={harness}
                onChange={(value) => updateFilters({ range, harness: value })}
              />
              <Select<TimeRange>
                aria-label="Time range"
                className="range-select"
                options={rangeOptions}
                value={range}
                onChange={(value) => updateFilters({ range: value, harness })}
              />
            </div>
          </div>

          <dl className="metrics" aria-label="Usage summary">
            <Metric
              label="Tokens processed"
              value={compactFormat.format(data.totalTokens)}
              caption={compactFormat.format(data.outputTokens) + " output tokens"}
            />
            <Metric
              id="cache"
              label="Cache read share"
              value={cacheShare}
              caption={compactFormat.format(data.cacheReadTokens) + " cached input tokens"}
            />
            <Metric
              label="Model calls"
              value={numberFormat.format(data.callCount)}
              caption={numberFormat.format(data.sessionCount) + " sessions · " + numberFormat.format(data.interruptedCalls) + " interrupted"}
            />
          </dl>

          <section id="overview-usage" className="panel usage-panel" aria-labelledby="usage-heading" ref={usagePanel} tabIndex={-1}>
            {selectedSession ? (
              <div className="panel-heading">
                <div>
                  <h2 id="usage-heading">Session token allocation</h2>
                  <p>{selectedSession.label} · {numberFormat.format(selectedSession.totalTokens)} tokens</p>
                </div>
                <div className="chart-actions">
                  <Button onClick={() => setDetail({ kind: "session", session: selectedSession })}>Session details</Button>
                  <Button onClick={() => setSelectedSession(null)}>Back to usage</Button>
                </div>
              </div>
            ) : (
              <div className="panel-heading">
                <div>
                  <h2 id="usage-heading">Usage over time</h2>
                  <ul className="chart-legend" aria-label="Chart series">
                    {harnesses.map((item) => (
                      <li key={item} className="harness-label"><HarnessDot harness={item} />{harnessNames[item]}</li>
                    ))}
                  </ul>
                </div>
                <Button className="data-button" onClick={() => setDetail({ kind: "usage" })}>View data</Button>
              </div>
            )}
            <Suspense fallback={<div className="usage-chart" aria-busy="true" />}>
              {selectedSession
                ? <SessionAllocation key={selectedSession.harness + "/" + selectedSession.id} session={selectedSession} />
                : <UsageChart series={data.series} range={range} harnesses={harnesses} />}
            </Suspense>
          </section>

          <div className="lower-panels">
            <section id="sessions" className="panel sessions-panel" aria-labelledby="sessions-heading">
              <div className="panel-heading">
                <h2 id="sessions-heading">Recent sessions</h2>
              </div>
              <Table
                size="small"
                rowKey={(session) => session.harness + "/" + session.id}
                columns={sessionColumns}
                dataSource={data.sessions}
                onRow={(session) => ({ onClick: () => setSelectedSession(session) })}
                rowClassName={(session) => isSelected(session) ? "selected-session" : ""}
                pagination={false}
                locale={{ emptyText: "No sessions in this range." }}
              />
            </section>

            <section id="quota" className="panel quota-panel" aria-labelledby="quota-heading">
              <div className="panel-heading">
                <div>
                  <h2 id="quota-heading">Plan quota</h2>
                  <p>Latest short-term windows</p>
                </div>
              </div>
              <div className="quota-list">
                {shortTermQuota.length > 0
                  ? shortTermQuota.map((quota) => <QuotaMeter key={quota.harness} quota={quota} />)
                  : <p className="quota-reset">No quota observations for this harness.</p>}
              </div>
            </section>
          </div>
        </main>
      </div>

      <Drawer
        title={detail?.kind === "session" ? detail.session.label : "Usage chart data"}
        open={detail !== null}
        onClose={() => setDetail(null)}
        size="min(490px, 100vw)"
      >
        {detail?.kind === "session" && (
          <Descriptions size="small" column={1} items={[
            { key: "harness", label: "Harness", children: harnessNames[detail.session.harness] },
            { key: "model", label: "Model", children: detail.session.model },
            { key: "start", label: "Started", children: dateTimeFormat.format(detail.session.startedAt) },
            { key: "last", label: "Last active", children: dateTimeFormat.format(detail.session.lastCallAt) },
            { key: "tokens", label: "Tokens processed", children: numberFormat.format(detail.session.totalTokens) },
            { key: "cache", label: "Cached input tokens", children: numberFormat.format(detail.session.cacheReadTokens) },
            { key: "calls", label: "Model calls", children: numberFormat.format(detail.session.callCount) },
            { key: "turns", label: "Turns", children: numberFormat.format(detail.session.turnCount) },
            { key: "interruptions", label: "Interrupted calls", children: numberFormat.format(detail.session.interruptedCalls) },
            { key: "compactions", label: "Compactions", children: numberFormat.format(detail.session.compactions) },
          ]} />
        )}
        {detail?.kind === "usage" && (
          <Table
            size="small"
            rowKey="at"
            dataSource={data.series}
            pagination={false}
            columns={[
              { title: "Time", dataIndex: "at", render: (at: number) => dateTimeFormat.format(at) },
              ...harnesses.map((item) => ({
                title: harnessNames[item],
                dataIndex: item,
                align: "right" as const,
                render: (value: number) => numberFormat.format(value),
              })),
            ]}
          />
        )}
      </Drawer>
    </div>
  );
}
