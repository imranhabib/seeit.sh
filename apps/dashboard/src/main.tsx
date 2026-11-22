import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, theme } from "antd";
import "antd/dist/reset.css";
import Overview from "./Overview.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider
      theme={{
        algorithm: [theme.darkAlgorithm, theme.compactAlgorithm],
        token: {
          colorPrimary: "#f6a56c",
          colorBgContainer: "#262830",
          colorBgElevated: "#292b33",
          colorText: "#f1efeb",
          colorTextSecondary: "#b6b5bf",
          colorBorder: "#45454c",
          colorBorderSecondary: "#3a3b43",
          borderRadius: 8,
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          controlHeight: 35,
        },
        components: {
          Table: {
            borderColor: "rgba(227, 220, 225, 0.13)",
            cellPaddingBlockSM: 11,
            cellPaddingInlineSM: 10,
            headerBg: "transparent",
            headerColor: "#a9a8b4",
            rowHoverBg: "rgba(255, 255, 255, 0.04)",
          },
          Drawer: { paddingLG: 24 },
          Segmented: {
            trackBg: "#1c1f27",
            itemSelectedBg: "#3b3e48",
            itemSelectedColor: "#f1efeb",
          },
        },
      }}
    >
      <Overview />
    </ConfigProvider>
  </StrictMode>,
);
