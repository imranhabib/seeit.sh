import type { Harness } from "./demo-data.ts";

export const harnessNames = {
  claude: "Claude Code",
  codex: "Codex",
} satisfies Record<Harness, string>;

export const chartColors = {
  claude: "#f6a56c",
  codex: "#91bafa",
} satisfies Record<Harness, string>;

export const numberFormat = new Intl.NumberFormat("en-US");
export const compactFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});
export const percentFormat = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});
export const dateTimeFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
