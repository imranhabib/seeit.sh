import { useEffect, useMemo, useRef, useState } from "react";
import { PieChart, type PieSeriesOption } from "echarts/charts";
import { TooltipComponent, type TooltipComponentOption } from "echarts/components";
import { format, graphic, init, use, type ComposeOption, type EChartsType } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { getSessionAllocation, type AllocationCategoryId, type DemoSessionSummary } from "./demo-data.ts";
import { numberFormat, percentFormat } from "./format.ts";

use([PieChart, TooltipComponent, CanvasRenderer]);

type SliceTone = { tint: string; shade: string };

const categoryStyle = {
  tools: { tint: "#d89563", shade: "#845036", chartLabel: "Tool\ncalls" },
  context: { tint: "#aa9683", shade: "#64574f", chartLabel: "Accumulated\ncontext" },
  instructions: { tint: "#ae8da0", shade: "#68505e", chartLabel: "Instructions\n& schemas" },
  messages: { tint: "#a5a378", shade: "#5c6046", chartLabel: "New\nmessages" },
  output: { tint: "#c58a78", shade: "#774b48", chartLabel: "Model\noutput" },
} satisfies Record<AllocationCategoryId, SliceTone & { chartLabel: string }>;

const sliceTones: SliceTone[] = [
  { tint: "#e4a46f", shade: "#9b5936" },
  { tint: "#b7828e", shade: "#754454" },
  { tint: "#c5a06c", shade: "#80663e" },
  { tint: "#aa91ae", shade: "#695471" },
  { tint: "#bf8873", shade: "#814f43" },
  { tint: "#9f9e79", shade: "#555b44" },
  { tint: "#b59a83", shade: "#705949" },
  { tint: "#d59283", shade: "#8b514a" },
];

function gradient({ tint, shade }: SliceTone) {
  return new graphic.LinearGradient(0, 0, 1, 1, [
    { offset: 0, color: tint },
    { offset: 1, color: shade },
  ]);
}

function ColorDot({ color }: { color: string }) {
  return <span className="harness-dot" style={{ backgroundColor: color }} aria-hidden="true" />;
}

export default function SessionAllocation({ session }: { session: DemoSessionSummary }) {
  const [activeId, setActiveId] = useState<AllocationCategoryId>("tools");
  const [chartWidth, setChartWidth] = useState(0);
  const categories = useMemo(() => getSessionAllocation(session), [session]);
  const active = categories.find((category) => category.id === activeId) ?? categories[0];
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const instance = init(element);
    chart.current = instance;

    const resize = () => {
      setChartWidth(element.clientWidth);
      instance.resize();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    instance.on("click", { seriesId: "categories" }, ({ dataIndex }) => {
      const category = categories[dataIndex];
      if (category) setActiveId(category.id);
    });

    return () => {
      chart.current = null;
      observer.disconnect();
      instance.dispose();
    };
  }, [categories]);

  useEffect(() => {
    if (!active || chartWidth === 0) return;
    const narrow = chartWidth < 510;
    const wide = chartWidth >= 700;
    const labelWidth = narrow ? 51 : wide ? 118 : 83;
    const labelFontSize = narrow ? 10 : 12;
    // Reserve room for both label columns in a narrow pane.
    const outerRadius = Math.min(105, Math.max(30, Math.round((chartWidth - 176) / 2)));
    const options: ComposeOption<PieSeriesOption | TooltipComponentOption> = {
      animation: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      animationDuration: 320,
      animationDurationUpdate: 220,
      tooltip: {
        trigger: "item",
        confine: true,
        className: "allocation-tooltip",
        backgroundColor: "#2e2728",
        borderColor: "#695347",
        padding: [9, 12],
        textStyle: { color: "#f5e9dd", fontSize: 12 },
        formatter: (params) => {
          const item = Array.isArray(params) ? params[0] : params;
          if (!item) return "";
          const isCategory = item.seriesIndex === 0;
          const entry = isCategory ? categories[item.dataIndex] : active.slices[item.dataIndex];
          if (!entry) return "";
          const detail = "detail" in entry ? entry.detail : undefined;
          const total = isCategory ? session.totalTokens : active.tokens;
          const shareOf = isCategory ? "session" : active.label;
          return "<strong>" + format.encodeHTML(entry.label) + "</strong>"
            + (detail ? "<div>" + format.encodeHTML(detail) + "</div>" : "")
            + "<div>" + numberFormat.format(entry.tokens) + " tokens</div>"
            + "<small>" + percentFormat.format(entry.tokens / total)
            + " of " + format.encodeHTML(shareOf) + "</small>";
        },
      },
      series: [
        {
          id: "categories",
          name: "Session allocation",
          type: "pie",
          radius: [0, narrow ? Math.round(outerRadius * 0.54) : "41%"],
          padAngle: 0.9,
          label: {
            position: "inside",
            color: "#fff0e3",
            textShadowColor: "rgba(19, 12, 11, 0.9)",
            textShadowBlur: 3,
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            fontWeight: 650,
            lineHeight: 14,
          },
          emphasis: { scale: false },
          data: categories.map((category) => {
            const share = category.tokens / session.totalTokens;
            const small = share < 0.10;
            return {
              name: category.label,
              value: category.tokens,
              cursor: "pointer",
              label: {
                formatter: categoryStyle[category.id].chartLabel,
                show: share >= (narrow ? 0.34 : 0.075) || (category.id === "tools" && (!narrow || outerRadius >= 65)),
                fontSize: small ? 9 : narrow ? 10 : 12,
                lineHeight: small || narrow ? 11 : 14,
              },
              itemStyle: {
                color: gradient(categoryStyle[category.id]),
                borderColor: category.id === active.id ? "#f3cda8" : "#271f20",
                borderWidth: category.id === active.id ? 2 : 1,
                shadowColor: "rgba(8, 5, 6, 0.55)",
                shadowBlur: 8,
                shadowOffsetY: 4,
              },
            };
          }),
        },
        {
          id: "breakdown",
          name: active.label,
          type: "pie",
          radius: narrow ? [Math.round(outerRadius * 0.75), outerRadius] : ["60%", "79%"],
          avoidLabelOverlap: true,
          label: {
            position: "outside",
            alignTo: wide ? "none" : "edge",
            edgeDistance: narrow ? 6 : 8,
            bleedMargin: 8,
            distanceToLabelLine: 3,
            backgroundColor: "#352a29",
            borderColor: "#695144",
            borderWidth: 1,
            borderRadius: 5,
            padding: narrow ? [3, 4] : [4, 7],
            shadowColor: "rgba(8, 5, 6, 0.55)",
            shadowBlur: 8,
            shadowOffsetY: 3,
            formatter: ({ dataIndex }) => {
              const slice = active.slices[dataIndex];
              const toolCall = active.id === "tools" ? slice.detail : undefined;
              const detail = toolCall && !narrow ? "\n{detail|" + toolCall + "}" : "";
              const count = "\n{tokens|" + numberFormat.format(slice.tokens) + "}";
              const callNumber = toolCall && narrow ? " {call|" + toolCall.replace("Model call ", "#") + "}" : "";
              const share = narrow ? "" : "  {share|" + percentFormat.format(slice.tokens / active.tokens) + "}";
              const name = format.truncateText(slice.label, labelWidth, "650 " + labelFontSize + "px system-ui, sans-serif", "…");
              return "{name|" + name + "}" + detail + count + callNumber + share;
            },
            rich: {
              name: {
                width: narrow ? undefined : labelWidth,
                color: "#f4e5d8",
                fontFamily: "system-ui, sans-serif",
                fontSize: labelFontSize,
                fontWeight: 650,
                lineHeight: narrow ? 13 : 16,
              },
              detail: { color: "#cbb9ad", fontSize: 10, lineHeight: 14 },
              tokens: { color: "#e4d2c4", fontSize: narrow ? 10 : 11, lineHeight: narrow ? 13 : 16 },
              call: { color: "#d8b99f", fontSize: 9 },
              share: { color: "#f9dfc4", backgroundColor: "#5b4337", borderRadius: 3, padding: [2, 4], fontSize: 10 },
            },
          },
          labelLine: { length: narrow ? 7 : 16, length2: narrow ? 5 : 14 },
          itemStyle: {
            borderColor: "#282022",
            borderWidth: 1,
            shadowColor: "rgba(8, 5, 6, 0.6)",
            shadowBlur: 9,
            shadowOffsetY: 4,
          },
          emphasis: { scaleSize: 3 },
          data: active.slices.map((slice, index) => {
            const tone = sliceTones[index % sliceTones.length];
            return {
              name: slice.label,
              value: slice.tokens,
              itemStyle: { color: gradient(tone) },
              labelLine: { lineStyle: { color: tone.tint, opacity: 0.8 } },
            };
          }),
        },
      ],
    };
    chart.current?.setOption(options);
  }, [active, categories, chartWidth, session.totalTokens]);

  if (!active) return <p className="allocation-empty">Session token allocation is unavailable.</p>;

  return (
    <div className="allocation-layout">
      <div className="allocation-chart" ref={container} aria-hidden="true" />
      <div className="allocation-inspector">
        <ul className="allocation-categories" aria-label="Token categories">
          {categories.map((category) => (
            <li key={category.id}>
              <button
                type="button"
                className="allocation-option"
                aria-pressed={category.id === active.id}
                onClick={() => setActiveId(category.id)}
              >
                <span className="harness-label">
                  <ColorDot color={categoryStyle[category.id].tint} />{category.label}
                </span>
                <span>{percentFormat.format(category.tokens / session.totalTokens)}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="allocation-breakdown">
          <div className="allocation-caption" aria-live="polite">
            <h3 id="breakdown-heading">{active.label} breakdown</h3>
            <strong>{numberFormat.format(active.tokens)} tokens</strong>
          </div>
          <p>{active.description}</p>
          <ul className="allocation-slices" key={active.id} aria-labelledby="breakdown-heading" tabIndex={0}>
            {active.slices.map((slice, index) => (
              <li key={slice.label + "/" + (slice.detail ?? "")}>
                <ColorDot color={sliceTones[index % sliceTones.length].tint} />
                <span>
                  {slice.label}
                  {slice.detail && <small>{slice.detail}</small>}
                </span>
                <strong>{numberFormat.format(slice.tokens)}</strong>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
