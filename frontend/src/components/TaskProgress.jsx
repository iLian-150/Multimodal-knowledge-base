import { lazy, Suspense } from "react";

const Progress = lazy(() => import("antd/es/progress"));

export default function TaskProgress({ title, label, percent, indeterminate, kind = "working", error }) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  return <div className={`task-progress ${kind}`} role="status" aria-live="polite">
    {title && <div className="task-progress-title" title={title}>{title}</div>}
    <div className="task-progress-label"><span>{label}</span><span>{indeterminate ? "处理中" : `${value}%`}</span></div>
    <Suspense fallback={<div className="progress-placeholder" role="progressbar" aria-label="正在更新进度" />}>
      <Progress className={indeterminate ? "progress-indeterminate" : ""} percent={indeterminate ? 34 : value} showInfo={false} strokeColor={kind === "warning" ? "#d2a65d" : undefined} status={kind === "error" ? "exception" : kind === "success" ? "success" : "active"} />
    </Suspense>
    {error && <small className="task-progress-error">{error}</small>}
  </div>;
}
