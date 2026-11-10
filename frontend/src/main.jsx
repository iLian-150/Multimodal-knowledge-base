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
            colorPrimary: "#625fd5",
            colorInfo: "#625fd5",
            colorError: "#bf5654",
            colorTextBase: "#20212a",
            colorBgLayout: "#f7f7f9",
            colorFillContent: "#f2f2f6",
            colorBorderSecondary: "#e9e9ee",
            borderRadius: 12,
            fontFamily: 'Inter, "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif',
            fontSize: 16,
          },
          components: {
            Button: { controlHeight: 42, borderRadius: 12 },
            Input: { controlHeight: 42, borderRadius: 10 },
            Card: { borderRadiusLG: 15 },
            Modal: { borderRadiusLG: 20, titleFontSize: 19 },
          },
        },
      },
      React.createElement(App),
    ),
  )
);
