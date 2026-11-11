import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Bubble from "@ant-design/x/es/bubble/index.js";
import Sender from "@ant-design/x/es/sender/index.js";
import Welcome from "@ant-design/x/es/welcome/index.js";
import { DeleteOutlined, PaperClipOutlined, SettingOutlined, UploadOutlined, SendOutlined } from "@ant-design/icons";
import { PanelLeft } from "lucide-react";
import Button from "antd/es/button";
import Input from "antd/es/input";
import Modal from "antd/es/modal";
import Sidebar from "./components/Sidebar.jsx";
import DocumentLibrary from "./components/DocumentLibrary.jsx";

const MarkdownRenderer = lazy(() => import("./MarkdownRenderer.jsx"));
const ConfidenceSlider = lazy(() => import("antd/es/slider"));
const DeferredProgress = lazy(() => import("antd/es/progress"));
const DeferredSpin = lazy(() => import("antd/es/spin"));

const API_DEFAULT = import.meta.env.VITE_API_BASE_URL || (
  ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? "http://127.0.0.1:8000"
    : `${window.location.protocol}//${window.location.hostname}:3000`
);
const STORAGE_KEY = "zhixu-rag-conversations-v1";
const WORKSPACES_KEY = "zhixu-rag-workspaces-v1";
const ACTIVE_WORKSPACE_KEY = "zhixu-rag-active-workspace-v1";
const ACTIVE_CONVERSATIONS_KEY = "kujie-rag-active-conversations-v1";
const SIDEBAR_COLLAPSED_KEY = "kujie-rag-sidebar-collapsed-v1";
const DEFAULT_WORKSPACE_ID = "campus-default";
const DEFAULT_WORKSPACE = { id: DEFAULT_WORKSPACE_ID, name: "校园知识库" };
const API_KEY = "zhixu-rag-api-base-v1";
const RERANK_RULES_KEY = "zhixu-rag-rerank-rules-v1";
const HALLUCINATION_THRESHOLD_KEY = "zhixu-rag-hallucination-threshold-v1";
const HALLUCINATION_THRESHOLD_MIGRATION_KEY = "zhixu-rag-hallucination-threshold-default-v1";
const ACCEPTED_FILES = ".pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff";
function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function nextUpdatedAt(conversations) {
  return Math.max(Date.now(), ...conversations.map((item) => Number(item.updatedAt) || 0)) + 1;
}

function readConversations() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (Array.isArray(saved)) return saved.map((item) => ({ ...item, workspaceId: item.workspaceId || DEFAULT_WORKSPACE_ID }));
  } catch {
    // Start with an empty history if browser storage is unavailable.
  }
  return [];
}

function readWorkspaces() {
  try {
    const saved = JSON.parse(localStorage.getItem(WORKSPACES_KEY) || "[]");
    if (Array.isArray(saved)) {
      const custom = saved.filter((item) => item && typeof item.id === "string" && typeof item.name === "string");
      return [DEFAULT_WORKSPACE, ...custom.filter((item) => item.id !== DEFAULT_WORKSPACE_ID)];
    }
  } catch {
    // Keep the default workspace if browser storage is unavailable.
  }
  return [DEFAULT_WORKSPACE];
}

function hasConversationContent(conversation) {
  return conversation.messages?.some((message) => message.role === "user" && message.text?.trim());
}

function readActiveConversationId(workspaceId = localStorage.getItem(ACTIVE_WORKSPACE_KEY) || DEFAULT_WORKSPACE_ID) {
  const available = readConversations().filter((item) => item.workspaceId === workspaceId && hasConversationContent(item));
  try {
    const selected = JSON.parse(localStorage.getItem(ACTIVE_CONVERSATIONS_KEY) || "{}");
    if (Object.hasOwn(selected, workspaceId)) return available.some((item) => item.id === selected[workspaceId]) ? selected[workspaceId] : null;
  } catch { /* Use the most recent conversation when old preferences cannot be read. */ }
  return available.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))[0]?.id || null;
}

function readRerankRules() {
  try {
    const saved = JSON.parse(localStorage.getItem(RERANK_RULES_KEY) || "{}");
    return {
      boostTerms: typeof saved.boostTerms === "string" ? saved.boostTerms : "",
      excludeTerms: typeof saved.excludeTerms === "string" ? saved.excludeTerms : "",
    };
  } catch {
    return { boostTerms: "", excludeTerms: "" };
  }
}

function readHallucinationThreshold() {
  let raw = localStorage.getItem(HALLUCINATION_THRESHOLD_KEY);
  if (localStorage.getItem(HALLUCINATION_THRESHOLD_MIGRATION_KEY) !== "done") {
    // The previous code converted a missing value to 0 and persisted it as the default.
    if (raw === null || raw === "0") {
      raw = "75";
      localStorage.setItem(HALLUCINATION_THRESHOLD_KEY, raw);
    }
    localStorage.setItem(HALLUCINATION_THRESHOLD_MIGRATION_KEY, "done");
  }
  const saved = raw === null || raw === "" ? 75 : Number(raw);
  return Number.isFinite(saved) ? Math.max(0, Math.min(95, Math.round(saved / 5) * 5)) : 75;
}

function readApiBase() {
  const saved = localStorage.getItem(API_KEY)?.trim();
  const oldDefaults = ["http://127.0.0.1:8000", "http://localhost:8000"];
  return !saved || (oldDefaults.includes(saved) && saved !== API_DEFAULT) ? API_DEFAULT : saved;
}

function parseRerankTerms(value) {
  return [...new Set(String(value || "").split(/[\n,，;；]+/).map((term) => term.trim()).filter(Boolean))].slice(0, 20);
}

function joinApi(base, path) {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.detail;
    const message = typeof detail === "string" ? detail : detail?.reason || payload?.message;
    throw new Error(message || `请求失败（${response.status}）`);
  }
  return payload;
}

function postJsonWithProgress(url, body, onProgress, onUploaded) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.setRequestHeader("Content-Type", "application/json");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.upload.addEventListener("load", onUploaded, { once: true });
    request.addEventListener("load", () => {
      let payload = {};
      try {
        payload = JSON.parse(request.responseText || "{}");
      } catch {
        payload = {};
      }
      if (request.status < 200 || request.status >= 300) {
        const detail = payload?.detail;
        const message = typeof detail === "string" ? detail : detail?.reason || payload?.message;
        reject(new Error(message || `请求失败（${request.status}）`));
        return;
      }
      resolve(payload);
    });
    request.addEventListener("error", () => reject(new Error("网络连接失败，请检查后端服务")), { once: true });
    request.addEventListener("abort", () => reject(new Error("导入已取消")), { once: true });
    request.send(JSON.stringify(body));
  });
}

function sourceTitle(source) {
  return source.source_path || source.source || source.filename || source.document_id || "资料来源";
}

function documentDisplayName(source) {
  return String(source || "").split(/[\\/]/).pop() || String(source || "未命名资料");
}

function App() {
  const [apiBase, setApiBase] = useState(readApiBase);
  const [rerankRules, setRerankRules] = useState(readRerankRules);
  const [hallucinationThreshold, setHallucinationThreshold] = useState(readHallucinationThreshold);
  const [conversations, setConversations] = useState(readConversations);
  const [activeId, setActiveId] = useState(readActiveConversationId);
  const [workspaces, setWorkspaces] = useState(readWorkspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => {
    const savedId = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
    return readWorkspaces().some((workspace) => workspace.id === savedId) ? savedId : DEFAULT_WORKSPACE_ID;
  });
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceCreateOpen, setWorkspaceCreateOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [summary, setSummary] = useState(null);
  const [status, setStatus] = useState({ kind: "idle", text: "" });
  const [uploadProgress, setUploadProgress] = useState(null);
  const [busy, setBusy] = useState(false);
  const [workspaceDeleting, setWorkspaceDeleting] = useState(false);
  const [documentListVersion, setDocumentListVersion] = useState(0);
  const [isConversationScrolling, setIsConversationScrolling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
  const [showSettings, setShowSettings] = useState(false);
  const [showDocuments, setShowDocuments] = useState(false);
  const [documentDelete, setDocumentDelete] = useState(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState(null);
  const fileInput = useRef(null);
  const textInput = useRef(null);
  const scrollArea = useRef(null);
  const summaryRequestRef = useRef(0);
  const scrollIdleTimerRef = useRef(null);
  const closeMobileNav = useCallback(() => setMobileNav(false), []);

  useEffect(() => () => window.clearTimeout(scrollIdleTimerRef.current), []);

  function handleConversationScroll() {
    setIsConversationScrolling(true);
    window.clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollIdleTimerRef.current = null;
      setIsConversationScrolling(false);
    }, 650);
  }

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeId && item.workspaceId === activeWorkspaceId) || null,
    [conversations, activeId, activeWorkspaceId],
  );
  const messages = activeConversation?.messages || [];
  const visibleMessages = messages.filter((message) => !message.fileProgress);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces));
  }, [workspaces]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspaceId);
  }, [activeWorkspaceId]);

  useEffect(() => {
    try {
      const selected = JSON.parse(localStorage.getItem(ACTIVE_CONVERSATIONS_KEY) || "{}");
      localStorage.setItem(ACTIVE_CONVERSATIONS_KEY, JSON.stringify({ ...selected, [activeWorkspaceId]: activeId }));
    } catch { /* Keep navigation usable if browser preferences are unavailable. */ }
  }, [activeId, activeWorkspaceId]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem(API_KEY, apiBase);
  }, [apiBase]);

  useEffect(() => {
    localStorage.setItem(RERANK_RULES_KEY, JSON.stringify(rerankRules));
  }, [rerankRules]);

  useEffect(() => {
    localStorage.setItem(HALLUCINATION_THRESHOLD_KEY, String(hallucinationThreshold));
  }, [hallucinationThreshold]);

  const refreshStatus = useCallback(async () => {
    const api = apiBase.trim();
    if (!api) return;
    const requestId = ++summaryRequestRef.current;
    try {
      const workspace = encodeURIComponent(activeWorkspaceId);
      const nextSummary = await fetch(joinApi(api, `/kb/summary?workspace_id=${workspace}`)).then(parseResponse);
      if (requestId === summaryRequestRef.current) setSummary(nextSummary);
    } catch {
      if (requestId === summaryRequestRef.current) setSummary(null);
    }
  }, [apiBase, activeWorkspaceId]);

  useEffect(() => {
    refreshStatus();
    const timer = window.setInterval(refreshStatus, 30000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      scrollArea.current?.scrollTo({ top: "bottom", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeId, activeConversation?.messages]);

  const isDeletingDocument = ["queued", "running"].includes(documentDelete?.status);

  function updateMessages(conversationId, transform) {
    setConversations((items) => {
      const updatedAt = nextUpdatedAt(items);
      return items.map((item) => {
        if (item.id !== conversationId) return item;
        const updated = transform(item.messages || []);
        const firstUser = updated.find((message) => message.role === "user");
        return {
          ...item,
          messages: updated,
          updatedAt,
          title: !item.customTitle && firstUser ? firstUser.text.slice(0, 30) : item.title,
        };
      });
    });
  }

  const focusComposer = useCallback(() => {
    if (typeof textInput.current?.focus === "function") textInput.current.focus();
    else document.querySelector(".chat-sender textarea")?.focus();
  }, []);

  const createConversation = useCallback(() => {
    if (busy) return;
    setActiveId(null);
    setQuestion("");
    setMobileNav(false);
    setStatus({ kind: "idle", text: "" });
    window.setTimeout(focusComposer, 0);
  }, [busy, focusComposer]);

  const selectConversation = useCallback((conversationId) => {
    if (!conversations.some((item) => item.id === conversationId && item.workspaceId === activeWorkspaceId)) return;
    setActiveId(conversationId);
    setQuestion("");
    setMobileNav(false);
  }, [conversations, activeWorkspaceId]);

  const renameConversation = useCallback((conversationId, title) => {
    if (busy || !title.trim()) return;
    setConversations((items) => items.map((item) => item.id === conversationId ? { ...item, title: title.trim(), customTitle: true } : item));
  }, [busy]);

  const deleteConversation = useCallback((conversationId) => {
    if (busy) return;
    const conversation = conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    const title = conversation.title || "新对话";
    setDeleteConfirmation({ type: "conversation", conversationId, title });
  }, [busy, conversations]);

  function removeConversation(conversationId) {
    const remaining = conversations.filter((item) => item.id !== conversationId);
    setConversations(remaining);
    if (activeId === conversationId) {
      const remainingInWorkspace = remaining
        .filter((item) => item.workspaceId === activeWorkspaceId && hasConversationContent(item))
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
      setActiveId(remainingInWorkspace[0]?.id || null);
      setQuestion("");
      setStatus({ kind: "idle", text: "" });
    }
  }

  function selectWorkspace(workspaceId) {
    if (busy) return;
    summaryRequestRef.current += 1;
    setActiveWorkspaceId(workspaceId);
    setSummary(null);
    setActiveId(readActiveConversationId(workspaceId));
    setQuestion("");
    setStatus({ kind: "idle", text: "" });
    setWorkspaceCreateOpen(false);
    setWorkspaceName("");
    setMobileNav(false);
  }

  function createWorkspace(event) {
    event?.preventDefault();
    const name = workspaceName.trim();
    if (!name) return;
    const existing = workspaces.find((workspace) => workspace.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing) {
      selectWorkspace(existing.id);
      return;
    }
    const workspace = { id: makeId(), name };
    setWorkspaces((items) => [...items, workspace]);
    selectWorkspace(workspace.id);
  }

  function requestWorkspaceDelete(workspaceId) {
    if (!workspaceId || workspaceId === DEFAULT_WORKSPACE_ID || busy || workspaceDeleting) return;
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (workspace) setDeleteConfirmation({ type: "workspace", workspaceId, title: workspace.name });
  }

  async function executeWorkspaceDelete(workspaceId) {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace || workspaceId === DEFAULT_WORKSPACE_ID || busy) return;

    setWorkspaceDeleting(true);
    setBusy(true);
    setStatus({ kind: "working", text: `正在删除“${workspace.name}”…` });
    try {
      await fetch(joinApi(apiBase, `/workspaces/${encodeURIComponent(workspaceId)}`), {
        method: "DELETE",
      }).then(parseResponse);

      setWorkspaces((items) => items.filter((item) => item.id !== workspaceId));
      setConversations((items) => items.filter((item) => item.workspaceId !== workspaceId));
      try {
        const selected = JSON.parse(localStorage.getItem(ACTIVE_CONVERSATIONS_KEY) || "{}");
        delete selected[workspaceId];
        localStorage.setItem(ACTIVE_CONVERSATIONS_KEY, JSON.stringify(selected));
      } catch {
        localStorage.removeItem(ACTIVE_CONVERSATIONS_KEY);
      }

      if (activeWorkspaceId === workspaceId) {
        summaryRequestRef.current += 1;
        setActiveWorkspaceId(DEFAULT_WORKSPACE_ID);
        setActiveId(readActiveConversationId(DEFAULT_WORKSPACE_ID));
        setSummary(null);
        setQuestion("");
      }
      setStatus({ kind: "success", text: `“${workspace.name}”已删除` });
    } catch (error) {
      setStatus({ kind: "error", text: error.message || "工作区删除失败，请稍后重试" });
    } finally {
      setBusy(false);
      setWorkspaceDeleting(false);
    }
  }

  function openDocuments() {
    setShowDocuments(true);
    setMobileNav(false);
    refreshStatus();
  }

  function openSettings() {
    if (["completed", "failed"].includes(documentDelete?.status)) setDocumentDelete(null);
    setShowSettings(true);
    setMobileNav(false);
    refreshStatus();
  }

  async function deleteDocument(source) {
    if (busy || isDeletingDocument) return;
    setDeleteConfirmation({ type: "document", source, workspaceId: activeWorkspaceId, title: documentDisplayName(source) });
  }

  async function executeDocumentDelete(source, workspaceId) {
    setDocumentDelete({ source, status: "queued", progress: 0, phase: "等待删除", error: "" });
    try {
      let job = await fetch(joinApi(apiBase, "/kb/documents/delete"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, workspace_id: workspaceId }),
      }).then(parseResponse);
      setDocumentDelete(job);

      while (["queued", "running"].includes(job.status)) {
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        job = await fetch(joinApi(apiBase, `/kb/documents/delete/${encodeURIComponent(job.job_id)}`)).then(parseResponse);
        setDocumentDelete(job);
      }
      if (job.status === "failed") throw new Error(job.error || "删除失败，请稍后重试");
      await refreshStatus();
    } catch (error) {
      setDocumentDelete({ source, status: "failed", progress: 0, phase: "删除失败", error: error.message });
    }
  }

  function confirmDeletion() {
    if (!deleteConfirmation) return;
    const confirmation = deleteConfirmation;
    setDeleteConfirmation(null);
    if (confirmation.type === "conversation") removeConversation(confirmation.conversationId);
    else if (confirmation.type === "workspace") void executeWorkspaceDelete(confirmation.workspaceId);
    else void executeDocumentDelete(confirmation.source, confirmation.workspaceId);
  }

  async function submitQuestion(event, submittedText) {
    event?.preventDefault();
    const text = (typeof submittedText === "string" ? submittedText : question).trim();
    if (!text || busy) return;
    const conversationId = activeId || makeId();
    if (!activeId) {
      setActiveId(conversationId);
      setConversations((items) => [{ id: conversationId, title: "新对话", messages: [], updatedAt: Date.now(), workspaceId: activeWorkspaceId }, ...items]);
    } else {
      window.requestAnimationFrame(() => {
        scrollArea.current?.scrollTo({ top: "bottom", behavior: "smooth" });
      });
    }
    const answerId = makeId();
    updateMessages(conversationId, (items) => [
      ...items,
      { id: makeId(), role: "user", text },
      { id: answerId, role: "assistant", text: "", sources: [], notices: [], pending: true, status: "正在识别问题类型…" },
    ]);
    setQuestion("");
    setBusy(true);
    setStatus({ kind: "working", text: "正在识别问题类型…" });
    let cancelQueuedAnswerUpdate = () => {};
    try {
      const response = await fetch(joinApi(apiBase, "/answer/stream"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          question: text,
          session_id: conversationId,
          workspace_id: activeWorkspaceId,
          rerank_rules: {
            boost_terms: parseRerankTerms(rerankRules.boostTerms),
            exclude_terms: parseRerankTerms(rerankRules.excludeTerms),
          },
          hallucination_threshold: hallucinationThreshold / 100,
        }),
      });
      if (!response.ok || !response.body) await parseResponse(response);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      let metadata = {};
      let failure = "";
      let answerRenderTimer = null;
      const apply = (patch) => updateMessages(conversationId, (items) => items.map((message) =>
        message.id === answerId ? { ...message, ...patch } : message,
      ));
      const flushAnswer = () => {
        answerRenderTimer = null;
        apply({ text: answer, ...metadata, pending: true });
      };
      const scheduleAnswerRender = () => {
        if (answerRenderTimer === null) answerRenderTimer = window.setTimeout(flushAnswer, 32);
      };
      cancelQueuedAnswerUpdate = () => {
        if (answerRenderTimer !== null) window.clearTimeout(answerRenderTimer);
        answerRenderTimer = null;
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          const event = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim();
          const dataLine = frame.match(/^data:\s*(.*)$/m)?.[1];
          if (!event || dataLine === undefined) continue;
          const payload = JSON.parse(dataLine || "{}");
          if (event === "metadata") metadata = payload;
          if (event === "status") {
            const message = payload.message || "正在处理，请稍候…";
            apply({ status: message });
            setStatus({ kind: "working", text: message });
          }
          if (event === "token") {
            answer += payload.text || "";
            scheduleAnswerRender();
          }
          if (event === "error") failure = payload.reason || "问答服务暂时不可用";
          if (event === "done") answer = payload.answer || answer;
        }
        if (done) break;
      }
      if (failure) throw new Error(failure);
      cancelQueuedAnswerUpdate();
      apply({ text: answer || "资料中暂时没有找到足够的依据。", ...metadata, pending: false, status: "" });
      setStatus({ kind: "idle", text: "" });
    } catch (error) {
      cancelQueuedAnswerUpdate();
      updateMessages(conversationId, (items) => items.map((message) => message.id === answerId
        ? { ...message, text: `暂时无法完成回答：${error.message}`, error: true, pending: false }
        : message,
      ));
      setStatus({ kind: "error", text: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || busy) return;
    setBusy(true);
    for (const file of files) {
      setUploadProgress({ filename: file.name, phase: "准备文件", percent: 0, indeterminate: true, kind: "working" });
      const updateFileProgress = (progress) => setUploadProgress((current) => ({
        ...(current || {}),
        filename: file.name,
        ...progress,
      }));
      setStatus({ kind: "working", text: `正在处理 ${file.name}` });
      try {
        if (file.size > 10 * 1024 * 1024) throw new Error("单个文件不能超过 10 MB");
        updateFileProgress({ phase: "读取文件", indeterminate: true });
        const encoded = bytesToBase64(await file.arrayBuffer());
        updateFileProgress({ phase: "上传文件", percent: 0, indeterminate: false });
        await postJsonWithProgress(
          joinApi(apiBase, "/kb/document"),
          { filename: file.name, content_base64: encoded, mode: "append", workspace_id: activeWorkspaceId, max_pages: 0, render_dpi: 150 },
          (percent) => updateFileProgress({ phase: "上传文件", percent, indeterminate: false }),
          () => updateFileProgress({ phase: "后端解析文档", percent: 100, indeterminate: true }),
        );
        let finalProgress = { phase: "导入完成", percent: 100, indeterminate: false, kind: "success" };
        updateFileProgress({ phase: "建立向量索引", percent: 0, indeterminate: true });
        try {
          await fetch(joinApi(apiBase, "/vector/ingest"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "append" }),
          }).then(parseResponse);
        } catch {
          finalProgress = { phase: "资料已保存，向量待同步", percent: 100, indeterminate: false, kind: "warning" };
        }
        updateFileProgress(finalProgress);
        setStatus({ kind: "success", text: `${file.name} 已加入知识库` });
      } catch (error) {
        updateFileProgress({ phase: "导入失败", detail: error.message, indeterminate: false, kind: "error" });
        setStatus({ kind: "error", text: error.message });
      }
    }
    setBusy(false);
    await refreshStatus();
    setDocumentListVersion((version) => version + 1);
    window.setTimeout(() => {
      setStatus((current) => current.kind === "success" ? { kind: "idle", text: "" } : current);
      setUploadProgress(null);
    }, 5000);
    if (fileInput.current) fileInput.current.value = "";
  }

  const sortedConversations = useMemo(
    () => conversations
      .filter((item) => item.workspaceId === activeWorkspaceId && hasConversationContent(item))
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)),
    [conversations, activeWorkspaceId],
  );
  return (
    <div className={`app-shell ${sidebarCollapsed && !mobileNav ? "sidebar-collapsed" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); uploadFiles(event.dataTransfer.files); }}>
      <Sidebar
        conversations={sortedConversations}
        activeId={activeId}
        busy={busy}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
        mobileOpen={mobileNav}
        onCloseMobile={closeMobileNav}
        onNewChat={createConversation}
        onSelectConversation={selectConversation}
        onRenameConversation={renameConversation}
        onDeleteConversation={deleteConversation}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={selectWorkspace}
        onCreateWorkspace={() => { setWorkspaceName(""); setWorkspaceCreateOpen(true); setMobileNav(false); }}
        onOpenSettings={openSettings}
        onOpenDocuments={openDocuments}
        workspaceDeleting={workspaceDeleting}
        defaultWorkspaceId={DEFAULT_WORKSPACE_ID}
        onDeleteWorkspace={requestWorkspaceDelete}
      />

      <main className="main-panel">
        <header className="topbar">
          <Button className="mobile-menu" type="text" aria-label="打开侧栏" icon={<PanelLeft size={20} strokeWidth={1.75} />} onClick={() => setMobileNav(true)} />
        </header>

        <input ref={fileInput} type="file" className="visually-hidden" multiple accept={ACCEPTED_FILES} onChange={(event) => uploadFiles(event.target.files)} />
        {dragging && <div className="drop-overlay"><div><UploadOutlined /><strong>松开即可添加资料</strong><small>PDF、Word、PPT、图片与文本</small></div></div>}

        <section className={`conversation-stage ${visibleMessages.length ? "has-messages" : ""} ${isConversationScrolling ? "is-scrolling" : ""}`} onScrollCapture={handleConversationScroll}>
          {visibleMessages.length === 0 ? (
            <div className="welcome-view">
              <Welcome
                variant="borderless"
                icon={<span className="brand-symbol"><i /><i /><i /></span>}
                title="让每份资料，都能成为答案"
                description="上传文档、扫描件和图片，直接提问。每个回答都能回到原始资料。"
                style={{ alignItems: "center", textAlign: "center" }}
                styles={{ icon: { height: "auto", marginBottom: 12 }, title: { fontSize: "clamp(28px, 3vw, 38px)", fontWeight: 650, letterSpacing: "-0.035em" }, description: { maxWidth: 600, color: "#858793", fontSize: 16, lineHeight: 1.8 } }}
              />
            </div>
          ) : (
            <>
              <Bubble.List
                ref={scrollArea}
                className="message-list"
                items={visibleMessages.map(makeBubbleItem)}
                autoScroll={false}
              />
              {busy && !visibleMessages.some((message) => message.pending) && !uploadProgress && <div className="thinking"><span /><span /><span />正在思考</div>}
            </>
          )}
        </section>

        <div className="composer-zone">
          {uploadProgress && (
            <div className="composer-upload-progress" aria-live="polite">
              <div className="composer-upload-filename" title={uploadProgress.filename}>{uploadProgress.filename}</div>
              <UploadProgress progress={uploadProgress} />
            </div>
          )}
          {status.text && !uploadProgress && <div className={`inline-status ${status.kind}`}><span>{status.kind === "working" ? "◌" : status.kind === "error" ? "!" : "✓"}</span>{status.text}</div>}
          <Sender
            ref={textInput}
            className="chat-sender"
            value={question}
            onChange={setQuestion}
            onSubmit={(text) => void submitQuestion(null, text)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const nativeEvent = event.nativeEvent;
              if (nativeEvent.isComposing || nativeEvent.keyCode === 229) return false;
              if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) return;
              if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              void submitQuestion(null, event.currentTarget.value);
              return false;
            }}
            onPasteFile={(files) => uploadFiles(files)}
            placeholder="向你的知识库提问…"
            submitType="enter"
            autoSize={{ minRows: 1, maxRows: 6 }}
            disabled={busy}
            prefix={<Button type="text" className="attach-button" title="添加资料" aria-label="添加资料" onClick={() => fileInput.current?.click()} disabled={busy}><PaperClipOutlined /></Button>}
            suffix={<Button className="send-button" type="primary" shape="circle" aria-label="发送问题" disabled={!question.trim() || busy} icon={busy ? <Suspense fallback={<SendOutlined />}><DeferredSpin size="small" /></Suspense> : <SendOutlined />} onClick={() => void submitQuestion(null, question)} />}
          />
        </div>
      </main>

      {showSettings && <Modal
        className="library-settings-modal"
        open
        centered
        width={820}
        title={<div className="settings-modal-title"><span><SettingOutlined /></span><div><h2>服务设置</h2><p>管理知识库资料与服务连接</p></div></div>}
        footer={null}
        closable={!isDeletingDocument}
        mask={{ closable: !isDeletingDocument }}
        onCancel={() => { if (!isDeletingDocument) setShowSettings(false); }}
      >
            <div className="settings-modal-body">
              <section className="settings-section">
                <div className="settings-section-heading">
                  <div><h3>知识库资料</h3><p>删除后会同步移除对应知识片段和向量索引。</p></div>
                  <Button className="settings-add-document" onClick={() => { setShowSettings(false); fileInput.current?.click(); }} disabled={busy || isDeletingDocument}><UploadOutlined /> 添加资料</Button>
                </div>
                <div className="settings-stats">
                  <div><strong>{docs.length}</strong><span>份资料</span></div>
                  <div><strong>{summary?.chunk_count ?? 0}</strong><span>个知识片段</span></div>
                </div>
                {docs.length ? (
                  <div className="managed-document-list">
                    {docs.map((source) => (
                      <div className="managed-document" key={source}>
                        <span className="managed-document-icon">▤</span>
                        <span className="managed-document-name" title={source}>{documentDisplayName(source)}</span>
                        <Button type="text" danger className="managed-document-delete" onClick={() => deleteDocument(source)} disabled={busy || isDeletingDocument}>
                          {isDeletingDocument && documentDelete.source === source ? "删除中…" : "删除"}
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : <div className="managed-documents-empty">知识库中还没有资料</div>}

                {documentDelete && (
                  <div className={`document-delete-progress ${documentDelete.status}`} role="status" aria-live="polite">
                    <div className="document-delete-progress-label"><span>{documentDelete.phase}{documentDelete.source ? ` · ${documentDisplayName(documentDelete.source)}` : ""}</span><span>{Math.max(0, Math.min(100, Number(documentDelete.progress) || 0))}%</span></div>
                    <Suspense fallback={<div className="library-progress-placeholder" role="progressbar" aria-label="正在更新进度" />}>
                      <DeferredProgress percent={Math.max(0, Math.min(100, Number(documentDelete.progress) || 0))} showInfo={false} status={documentDelete.status === "failed" ? "exception" : documentDelete.status === "completed" ? "success" : "active"} />
                    </Suspense>
                    {documentDelete.error && <small>{documentDelete.error}</small>}
                  </div>
                )}
              </section>

              <section className="settings-section">
                <div className="settings-section-heading"><div><h3>服务连接</h3><p>设置当前使用的后端 API 地址。</p></div></div>
                <label className="settings-api-label" htmlFor="api-base">后端 API 地址</label>
                <Input className="settings-api-input" id="api-base" value={apiBase} onChange={(event) => setApiBase(event.target.value)} onBlur={refreshStatus} spellCheck="false" />
                <small className="settings-api-help">API 密钥保存在后端环境变量中。</small>
              </section>

              <section className="settings-section">
                <div className="settings-section-heading"><div><h3>检索重排规则</h3><p>规则自动保存在当前浏览器，并应用于之后的新问题。</p></div></div>
                <label className="settings-api-label" htmlFor="rerank-boost-terms">优先匹配关键词</label>
                <Input.TextArea
                  className="settings-rule-textarea"
                  id="rerank-boost-terms"
                  value={rerankRules.boostTerms}
                  onChange={(event) => setRerankRules((current) => ({ ...current, boostTerms: event.target.value }))}
                  placeholder="例如：奖学金金额、申请条件"
                  rows={3}
                />
                <small className="settings-api-help">候选资料命中这些词时会提高排序。每行一个，也可用逗号分隔。</small>

                <label className="settings-api-label settings-rule-secondary-label" htmlFor="rerank-exclude-terms">排除关键词</label>
                <Input.TextArea
                  className="settings-rule-textarea"
                  id="rerank-exclude-terms"
                  value={rerankRules.excludeTerms}
                  onChange={(event) => setRerankRules((current) => ({ ...current, excludeTerms: event.target.value }))}
                  placeholder="例如：目录、封面"
                  rows={3}
                />
                <small className="settings-api-help">候选资料命中这些词时会从本次答案的依据中排除。最多设置 20 个关键词。</small>
              </section>

              <section className="settings-section">
                <div className="settings-section-heading"><div><h3>答案幻觉校验</h3><p>设置答案通过来源核验所需的最低置信度。</p></div></div>
                <label className="settings-api-label" htmlFor="hallucination-threshold">最低可信度</label>
                <div className="threshold-control">
                  <Suspense fallback={<div className="slider-loading" role="status">加载设置项…</div>}>
                    <ConfidenceSlider
                      className="threshold-range"
                      id="hallucination-threshold"
                      min={0}
                      max={95}
                      step={5}
                      value={hallucinationThreshold}
                      onChange={setHallucinationThreshold}
                      aria-label="最低可信度"
                      tooltip={{ formatter: (value) => `${value}%` }}
                    />
                  </Suspense>
                  <strong className="threshold-value">{hallucinationThreshold}%</strong>
                </div>
                <div className="threshold-scale"><span>宽松</span><span>严格</span></div>
                <small className="settings-api-help">阈值越低越宽松。设为 0% 时，只要检索到资料，就不会因校验置信度拦截回答；低阈值可能放过依据不足的内容，请核对参考资料。设置仅保存在当前浏览器，并应用于之后的新问题。</small>
              </section>
            </div>
      </Modal>}

      {workspaceCreateOpen && <Modal
        className="library-workspace-modal"
        open
        centered
        width={440}
        title="新建工作区域"
        onCancel={() => { setWorkspaceCreateOpen(false); setWorkspaceName(""); }}
        footer={[
          <Button key="cancel" onClick={() => { setWorkspaceCreateOpen(false); setWorkspaceName(""); }}>取消</Button>,
          <Button key="create" type="primary" disabled={!workspaceName.trim()} onClick={createWorkspace}>创建</Button>,
        ]}
      >
        <Input
          autoFocus
          value={workspaceName}
          onChange={(event) => setWorkspaceName(event.target.value)}
          onPressEnter={createWorkspace}
          maxLength={32}
          placeholder="输入工作区域名称"
          aria-label="工作区域名称"
        />
      </Modal>}

      <DocumentLibrary
        open={showDocuments}
        apiBase={apiBase}
        workspaceId={activeWorkspaceId}
        reloadToken={documentListVersion}
        busy={busy}
        onUpload={() => fileInput.current?.click()}
        onClose={() => setShowDocuments(false)}
      />

      {deleteConfirmation && <Modal
        className="library-confirm-modal"
        open
        centered
        width={460}
        title={deleteConfirmation?.type === "workspace" ? "删除这个工作区？" : deleteConfirmation?.type === "document" ? "删除这份资料？" : "删除这段对话？"}
        onCancel={() => setDeleteConfirmation(null)}
        footer={[
          <Button key="cancel" onClick={() => setDeleteConfirmation(null)}>取消</Button>,
          <Button key="delete" danger type="primary" onClick={confirmDeletion}>确认删除</Button>,
        ]}
      >
        {deleteConfirmation && <p className="confirm-dialog-description">
          {deleteConfirmation.type === "workspace"
            ? `将删除“${deleteConfirmation.title}”及其全部会话、原始文档和向量索引，此操作不可撤销。`
            : deleteConfirmation.type === "document"
              ? `将从知识库删除“${deleteConfirmation.title}”，对应的知识片段和向量索引也会一起删除。`
              : `确定删除“${deleteConfirmation.title}”吗？删除后无法恢复。`}
          {deleteConfirmation.type !== "workspace" && deleteConfirmation.type === "document" && <><br /><small>此操作无法撤销</small></>}
        </p>}
      </Modal>}
    </div>
  );
}

function MessageContent({ message }) {
  const sources = Array.isArray(message.sources) ? message.sources : [];
  const isUser = message.role === "user";
  return (
    <div className={`message-text ${!isUser ? "assistant-markdown" : ""}`}>
      {!isUser && message.text
        ? <Suspense fallback={<span className="markdown-loading">正在渲染回答…</span>}><MarkdownRenderer>{message.text}</MarkdownRenderer></Suspense>
        : isUser ? message.text : null}
      {message.pending && message.text && <span className="cursor-blink" />}
      {!isUser && message.hallucination_check?.passed && (message.hallucination_check.issues || []).some((issue) => issue.startsWith("当前阈值已放宽来源校验")) && (
        <div className="answer-review-note" role="note">当前校验设置较宽松，建议核对参考资料。</div>
      )}
      {sources.length > 0 && (
        <details className="sources-block">
          <summary className="sources-heading"><span>▤</span> 参考资料 <small>{sources.length}</small><span className="sources-chevron">⌄</span></summary>
          <div className="source-list">{sources.map((source, index) => <div className="source-card" key={`${source.document_id || sourceTitle(source)}-${index}`}><span className="source-number">{index + 1}</span><span className="source-name">{sourceTitle(source)}</span>{source.page && <span className="source-page">第 {source.page} 页</span>}</div>)}</div>
        </details>
      )}
    </div>
  );
}

function makeBubbleItem(message) {
  const isUser = message.role === "user";
  return {
    key: message.id,
    role: message.role,
    className: `library-chat-bubble ${isUser ? "user-bubble" : "assistant-bubble"} ${message.error ? "message-error" : ""}`,
    placement: isUser ? "end" : "start",
    variant: "filled",
    shape: isUser ? "corner" : "default",
    styles: { content: { background: isUser ? "#f4f4f7" : "transparent", paddingInline: isUser ? 18 : 0, paddingBlock: isUser ? 13 : 0, fontSize: 16, lineHeight: 1.85 } },
    avatar: <div className={`message-avatar ${isUser ? "user-avatar" : "assistant-avatar"}`}>{isUser ? "我" : <span className="brand-symbol"><i /><i /><i /></span>}</div>,
    header: !isUser && <div className="message-author">库解{message.pending && <span className="pending-label"><i />{message.status || "正在处理，请稍候…"}</span>}</div>,
    content: <MessageContent message={message} />,
    loading: Boolean(message.pending && !message.text),
    streaming: Boolean(message.pending),
  };
}

function UploadProgress({ progress }) {
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  return (
    <div className={`upload-progress ${progress.kind || "working"}`} role="status">
      <div className="upload-progress-label"><span>{progress.phase}</span><span>{progress.indeterminate ? "处理中" : `${percent}%`}</span></div>
      <Suspense fallback={<div className="library-progress-placeholder" role="progressbar" aria-label="正在更新进度" />}>
        <DeferredProgress className={progress.indeterminate ? "library-progress-indeterminate" : ""} percent={progress.indeterminate ? 34 : percent} showInfo={false} status={progress.kind === "error" ? "exception" : progress.kind === "success" ? "success" : "active"} />
      </Suspense>
      {progress.detail && <div className="upload-progress-detail">{progress.detail}</div>}
    </div>
  );
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) binary += String.fromCharCode(...bytes.subarray(index, index + step));
  return btoa(binary);
}

export default App;
