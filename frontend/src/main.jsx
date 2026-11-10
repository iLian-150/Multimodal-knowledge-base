import React from "react";
import { createRoot } from "react-dom/client";
import ConfigProvider from "antd/es/config-provider";
import zhCN from "antd/es/locale/zh_CN";
import App from "./App.jsx";
import "antd/dist/reset.css";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  React.createElement(
    React.StrictMode,
    null,
    React.createElement(
      ConfigProvider,
      {
        locale: zhCN,
        theme: {
          token: {
            colorPrimary: "#6965ad",
            colorInfo: "#6965ad",
            colorError: "#b35f55",
            colorTextBase: "#28272d",
            colorBgLayout: "#fbfbfc",
            colorFillContent: "#f5f5f8",
            colorBorderSecondary: "#edecf1",
            borderRadius: 12,
            fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
            fontSize: 16,
          },
          components: {
            Button: { controlHeight: 40, borderRadius: 12 },
            Input: { controlHeight: 40, borderRadius: 10 },
            Card: { borderRadiusLG: 14 },
            Modal: { borderRadiusLG: 18, titleFontSize: 19 },
          },
        },
      },
      React.createElement(App),
    ),
  )
);
