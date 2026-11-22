import { useEffect, useRef } from "react";
import { LineChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, TooltipComponent } from "echarts/components";
import { init, use, type EChartsCoreOption, type EChartsType } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import type { Harness, TimeRange } from "./demo-data.ts";
import { chartColors, compactFormat, harnessNames, numberFormat } from "./format.ts";

use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

type Props = {
  series: { at: number; claude: number; codex: number }[];
  range: TimeRange;
  harnesses: Harness[];
};

export default function UsageChart({ series, range, harnesses }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const instance = init(element);
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(element);

    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const dateFormat = new Intl.DateTimeFormat("en-US", {
      month: range === "24h" ? undefined : "short",
      day: range === "24h" ? undefined : "numeric",
      hour: range === "30d" ? undefined : "numeric",
      minute: range === "24h" ? "2-digit" : undefined,
    });
    const options: EChartsCoreOption = {
      color: harnesses.map((harness) => chartColors[harness]),
      textStyle: { fontFamily: "system-ui, sans-serif" },
      animation: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      grid: { top: 12, right: 19, bottom: 58, left: 45 },
      tooltip: {
        trigger: "axis",
        confine: true,
        backgroundColor: "#24272e",
        borderColor: "#45454b",
        textStyle: { color: "#f1efeb", fontSize: 12 },
        valueFormatter: (value: number) => numberFormat.format(value) + " tokens",
        axisPointer: { lineStyle: { color: "#83808a" } },
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: series.map((point) => dateFormat.format(point.at)),
        axisLine: { lineStyle: { color: "rgba(220, 219, 232, 0.14)" } },
        axisTick: { show: false },
        axisLabel: { color: "#a5a8b4", fontSize: 11, hideOverlap: true, margin: 11 },
      },
      yAxis: {
        type: "value",
        splitNumber: 4,
        splitLine: { lineStyle: { color: "rgba(220, 219, 232, 0.12)" } },
        axisLabel: { color: "#a5a8b4", fontSize: 11, formatter: (value: number) => compactFormat.format(value) },
      },
      dataZoom: [
        {
          type: "inside",
          minValueSpan: 2,
          zoomOnMouseWheel: "ctrl",
          moveOnMouseWheel: false,
          moveOnMouseMove: false,
        },
        {
          type: "slider",
          minValueSpan: 2,
          height: 16,
          bottom: 5,
          showDetail: false,
          showDataShadow: true,
          borderColor: "#41434b",
          backgroundColor: "#21232b",
          fillerColor: "rgba(246, 165, 108, 0.14)",
          handleStyle: { color: "#aa8a75", borderColor: "#eac9af" },
          dataBackground: {
            lineStyle: { color: "#747685" },
            areaStyle: { color: "#424753" },
          },
        },
      ],
      series: harnesses.map((harness) => ({
        name: harnessNames[harness],
        type: "line",
        data: series.map((point) => point[harness]),
        showSymbol: false,
        smooth: 0.22,
        lineStyle: {
          width: 2.5,
          shadowColor: "rgba(0, 0, 0, 0.72)",
          shadowBlur: 10,
          shadowOffsetY: 7,
        },
        areaStyle: { opacity: 0.09 },
        emphasis: { focus: "series" },
      })),
    };
    chart.current?.setOption(options, { notMerge: true });
  }, [series, range, harnesses]);

  return <div className="usage-chart" ref={container} aria-hidden="true" />;
}
