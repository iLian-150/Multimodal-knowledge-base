import React from "react";
import { createRoot } from "react-dom/client";
import ConfigProvider from "antd/es/config-provider";
import zhCN from "antd/es/locale/zh_CN";
import App from "./App.jsx";
import "antd/dist/reset.css";
import "./styles.css";

const theme = {
  token: {
    colorPrimary: "#3b63c7",
    colorInfo: "#3b63c7",
    colorError: "#bf5654",
    colorTextBase: "#20212a",
    colorBgLayout: "#f7f7f9",
    colorFillContent: "#f2f2f6",
    colorBorderSecondary: "#e9e9ee",
    borderRadius: 10,
    fontFamily: "var(--font-ui)",
    fontSize: 16,
  },
  components: { Button: { controlHeight: 40 }, Input: { controlHeight: 40 }, Modal: { borderRadiusLG: 16, titleFontSize: 18 } },
};

createRoot(document.getElementById("root")).render(
  <React.StrictMode><ConfigProvider locale={zhCN} theme={theme}><App /></ConfigProvider></React.StrictMode>,
);
