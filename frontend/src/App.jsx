import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Bubble from "@ant-design/x/es/bubble/index.js";
import Conversations from "@ant-design/x/es/conversations/index.js";
import Sender from "@ant-design/x/es/sender/index.js";
import Button from "antd/es/button";
import Dropdown from "antd/es/dropdown";
import Input from "antd/es/input";
import Progress from "antd/es/progress";
import Spin from "antd/es/spin";
import "./iconfont.css";

const MarkdownRenderer = lazy(() => import("./MarkdownRenderer.jsx"));
const ConfidenceSlider = lazy(() => import("antd/es/slider"));
const DeferredModal = lazy(() => import("antd/es/modal"));

const API_DEFAULT = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";
const STORAGE_KEY = "zhixu-rag-conversations-v1";
const WORKSPACES_KEY = "zhixu-rag-workspaces-v1";
const ACTIVE_WORKSPACE_KEY = "zhixu-rag-active-workspace-v1";
const DEFAULT_WORKSPACE_ID = "campus-default";
const DEFAULT_WORKSPACE = { id: DEFAULT_WORKSPACE_ID, name: "校园知识库" };
const API_KEY = "zhixu-rag-api-base-v1";
const RERANK_RULES_KEY = "zhixu-rag-rerank-rules-v1";
const HALLUCINATION_THRESHOLD_KEY = "zhixu-rag-hallucination-threshold-v1";
const ACCEPTED_FILES = ".pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff";
const SUGGESTIONS = [
  { icon: "▤", title: "总结资料", text: "帮我提炼这批资料的核心知识点" },
  { icon: "⌕", title: "查找细节", text: "资料中关于主要概念的解释是什么？" },
  { icon: "✎", title: "生成练习", text: "根据已上传的资料生成几道复习题" },
  { icon: "▧", title: "理解图表", text: "解释资料里的图表和图片表达了什么" },
];

function Icon({ name, className = "" }) {
  return <span className={`iconfont-icon iconfont-${name} ${className}`.trim()} aria-hidden="true" />;
}

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

function readActiveConversationId() {
  const workspaceId = localStorage.getItem(ACTIVE_WORKSPACE_KEY) || DEFAULT_WORKSPACE_ID;
  return readConversations()
    .filter((item) => item.workspaceId === workspaceId)
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))[0]?.id || null;
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
  const saved = Number(localStorage.getItem(HALLUCINATION_THRESHOLD_KEY));
  return Number.isFinite(saved) ? Math.max(0, Math.min(95, Math.round(saved / 5) * 5)) : 75;
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
  const [apiBase, setApiBase] = useState(() => localStorage.getItem(API_KEY) || API_DEFAULT);
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
  const [dragging, setDragging] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [documentDelete, setDocumentDelete] = useState(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState(null);
  const fileInput = useRef(null);
  const textInput = useRef(null);
  const scrollArea = useRef(null);
  const draftConversationRef = useRef(null);
  const summaryRequestRef = useRef(0);

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
    scrollArea.current?.scrollTo({ top: "bottom", behavior: "smooth" });
  }, [messages, status.text]);

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
          title: firstUser ? firstUser.text.slice(0, 30) : item.title,
        };
      });
    });
  }

  function bumpConversation(conversationId) {
    setConversations((items) => {
      const updatedAt = nextUpdatedAt(items);
      return items.map((item) => item.id === conversationId ? { ...item, updatedAt } : item);
    });
  }

  function focusComposer() {
    if (typeof textInput.current?.focus === "function") textInput.current.focus();
    else document.querySelector(".chat-sender textarea")?.focus();
  }

  function createConversation() {
    if (busy) return;
    const reservedDraftId = draftConversationRef.current;
    if (reservedDraftId) {
      const reservedDraft = conversations.find((item) => item.id === reservedDraftId);
      if (!reservedDraft || !reservedDraft.messages?.length) {
        if (reservedDraft) bumpConversation(reservedDraftId);
        setActiveId(reservedDraftId);
        setQuestion("");
        setMobileNav(false);
        window.setTimeout(focusComposer, 0);
        return;
      }
      draftConversationRef.current = null;
    }
    const existingDraft = conversations.find((item) => item.workspaceId === activeWorkspaceId && !item.messages?.length);
    if (existingDraft) {
      bumpConversation(existingDraft.id);
      draftConversationRef.current = existingDraft.id;
      setActiveId(existingDraft.id);
      setQuestion("");
      setMobileNav(false);
      window.setTimeout(focusComposer, 0);
      return;
    }
    const conversation = { id: makeId(), title: "新对话", messages: [], updatedAt: Date.now(), workspaceId: activeWorkspaceId };
    draftConversationRef.current = conversation.id;
    setConversations((items) => [conversation, ...items]);
    setActiveId(conversation.id);
    setQuestion("");
    setMobileNav(false);
    window.setTimeout(focusComposer, 0);
  }

  function deleteConversation(conversationId) {
    if (busy) return;
    const conversation = conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    const title = conversation.title || "新对话";
    setDeleteConfirmation({ type: "conversation", conversationId, title });
  }

  function removeConversation(conversationId) {
    const remaining = conversations.filter((item) => item.id !== conversationId);
    setConversations(remaining);
    if (draftConversationRef.current === conversationId) draftConversationRef.current = null;
    if (activeId === conversationId) {
      const remainingInWorkspace = remaining
        .filter((item) => item.workspaceId === activeWorkspaceId)
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
      setActiveId(remainingInWorkspace[0]?.id || null);
      setQuestion("");
      setStatus({ kind: "idle", text: "" });
    }
  }

  function selectWorkspace(workspaceId) {
    if (busy) return;
    const workspaceConversations = conversations
      .filter((item) => item.workspaceId === workspaceId)
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
    summaryRequestRef.current += 1;
    setActiveWorkspaceId(workspaceId);
    setSummary(null);
    setActiveId(workspaceConversations[0]?.id || null);
    draftConversationRef.current = null;
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

  function openSettings() {
    if (["completed", "failed"].includes(documentDelete?.status)) setDocumentDelete(null);
    setShowSettings(true);
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
    else void executeDocumentDelete(confirmation.source, confirmation.workspaceId);
  }

  async function submitQuestion(event, submittedText) {
    event?.preventDefault();
    const text = (typeof submittedText === "string" ? submittedText : question).trim();
    if (!text || busy) return;
    const conversationId = activeId || makeId();
    if (draftConversationRef.current === conversationId) draftConversationRef.current = null;
    if (!activeId) {
      setActiveId(conversationId);
      setConversations((items) => [{ id: conversationId, title: "新对话", messages: [], updatedAt: Date.now(), workspaceId: activeWorkspaceId }, ...items]);
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
      const apply = (patch) => updateMessages(conversationId, (items) => items.map((message) =>
        message.id === answerId ? { ...message, ...patch } : message,
      ));
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
            apply({ text: answer, ...metadata, pending: true });
          }
          if (event === "error") failure = payload.reason || "问答服务暂时不可用";
          if (event === "done") answer = payload.answer || answer;
        }
        if (done) break;
      }
      if (failure) throw new Error(failure);
      apply({ text: answer || "资料中暂时没有找到足够的依据。", ...metadata, pending: false, status: "" });
      setStatus({ kind: "idle", text: "" });
    } catch (error) {
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
    const conversationId = activeId || makeId();
    if (draftConversationRef.current === conversationId) draftConversationRef.current = null;
    if (!activeId) {
      setActiveId(conversationId);
      setConversations((items) => [{ id: conversationId, title: "新对话", messages: [], updatedAt: Date.now(), workspaceId: activeWorkspaceId }, ...items]);
    }
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
    window.setTimeout(() => {
      setStatus((current) => current.kind === "success" ? { kind: "idle", text: "" } : current);
      setUploadProgress(null);
    }, 5000);
    if (fileInput.current) fileInput.current.value = "";
  }

  const sortedConversations = useMemo(
    () => conversations
      .filter((item) => item.workspaceId === activeWorkspaceId)
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)),
    [conversations, activeWorkspaceId],
  );
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) || DEFAULT_WORKSPACE;
  const docs = summary?.sources || [];

  return (
    <div className={`app-shell ${sidebarCollapsed && !mobileNav ? "sidebar-collapsed" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); uploadFiles(event.dataTransfer.files); }}>
      {mobileNav && <button className="mobile-scrim" aria-label="关闭侧栏" onClick={() => setMobileNav(false)} />}
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="sidebar-header">
          <button className="brand" onClick={createConversation} aria-label="新建对话" disabled={busy}>
            <span className="brand-symbol"><i /><i /><i /></span>
            <span className="brand-name">库解</span>
          </button>
          <button
            className="sidebar-collapse"
            type="button"
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
            aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          >{sidebarCollapsed ? "›" : "‹"}</button>
        </div>

        <Button className="new-chat" onClick={createConversation} disabled={busy} title="新建对话" icon={<span className="new-chat-icon"><Icon name="plus" /></span>}>
          <span className="new-chat-label">新建对话</span>
        </Button>

        <div className="history-label"><span>最近对话</span><Button type="text" title="新建对话" onClick={createConversation} disabled={busy}><Icon name="plus" /></Button></div>
        <nav className="conversation-list" aria-label="最近对话">
          {sortedConversations.length ? (
            <Conversations
              className="library-conversations"
              activeKey={activeId || undefined}
              items={sortedConversations.map((item) => ({ key: item.id, label: item.title || "新对话", icon: <Icon name="conversation" className="conversation-mark" /> }))}
              onActiveChange={(key) => { setActiveId(key); setMobileNav(false); }}
              menu={(conversation) => ({
                items: [{
                  key: "delete",
                  label: "删除对话",
                  danger: true,
                  onClick: () => deleteConversation(conversation.key),
                }],
              })}
            />
          ) : <p className="history-empty">你的对话会显示在这里</p>}
        </nav>

        <div className="sidebar-bottom">
          <Dropdown
            trigger={["click"]}
            placement="topLeft"
            disabled={busy}
            menu={{
              selectedKeys: [activeWorkspaceId],
              items: [
                { key: "workspace-heading", disabled: true, label: <strong>切换工作区域</strong> },
                ...workspaces.map((workspace) => ({
                  key: workspace.id,
                  label: workspace.name,
                  icon: <Icon name="workspace" />,
                })),
                { type: "divider" },
                { key: "workspace-permission", disabled: true, label: <small className="workspace-permission-note">资料与检索按工作区域隔离；账号授权后续接入。</small> },
                { type: "divider" },
                { key: "create-workspace", label: "新建工作区域", icon: <Icon name="plus" /> },
              ],
              onClick: ({ key }) => {
                if (key === "create-workspace") {
                  setWorkspaceName("");
                  setWorkspaceCreateOpen(true);
                } else if (key !== "workspace-heading" && key !== "workspace-permission") {
                  selectWorkspace(key);
                }
              },
            }}
          >
            <Button className="workspace-switcher-button" title={`工作区域：${activeWorkspace.name}`} disabled={busy}>
              <span className="workspace-switcher-icon"><Icon name="workspace" /></span>
              <span className="workspace-switcher-copy"><small>工作区域</small><strong>{activeWorkspace.name}</strong></span>
              <span className="workspace-switcher-chevron">⌄</span>
            </Button>
          </Dropdown>
          <button className="settings-toggle" onClick={openSettings} title="服务设置"><span><Icon name="settings" /></span><span className="settings-label">服务设置</span><span className="settings-chevron">›</span></button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <button className="mobile-menu" aria-label="打开侧栏" onClick={() => setMobileNav(true)}>☰</button>
        </header>

        <input ref={fileInput} type="file" className="visually-hidden" multiple accept={ACCEPTED_FILES} onChange={(event) => uploadFiles(event.target.files)} />
        {dragging && <div className="drop-overlay"><div><span>＋</span><strong>松开即可添加资料</strong><small>PDF、Word、PPT、图片与文本</small></div></div>}

        <section className={`conversation-stage ${visibleMessages.length ? "has-messages" : ""}`}>
          {visibleMessages.length === 0 ? (
            <div className="welcome-view">
              <div className="welcome-mark"><span className="brand-symbol"><i /><i /><i /></span></div>
              <div className="welcome-kicker">你的多模态学习空间</div>
              <h1>让每份资料，都能成为答案</h1>
              <p className="welcome-subtitle">上传文档、扫描件和图片，直接提问。每个回答都能回到原始资料。</p>
              <div className="welcome-cards">
                {SUGGESTIONS.map((item) => <Button key={item.title} className="suggestion-card" onClick={() => { setQuestion(item.text); focusComposer(); }}><span className="suggestion-icon">{item.icon}</span><span className="suggestion-copy"><b>{item.title}</b><small>{item.text}</small></span><span className="suggestion-arrow">↗</span></Button>)}
              </div>
            </div>
          ) : (
            <>
              <Bubble.List
                ref={scrollArea}
                className="message-list"
                items={visibleMessages.map(makeBubbleItem)}
                autoScroll
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
            onPasteFile={(files) => uploadFiles(files)}
            placeholder="向你的知识库提问…"
            submitType="enter"
            autoSize={{ minRows: 1, maxRows: 6 }}
            disabled={busy}
            prefix={<Button type="text" className="attach-button" title="添加资料" aria-label="添加资料" onClick={() => fileInput.current?.click()} disabled={busy}><Icon name="plus" /></Button>}
            suffix={<Button className="send-button" type="primary" shape="circle" aria-label="发送问题" disabled={!question.trim() || busy} icon={busy ? <Spin size="small" /> : <Icon name="send" />} onClick={() => void submitQuestion(null, question)} />}
          />
        </div>
      </main>

      <Suspense fallback={null}>
      {showSettings && <DeferredModal
        className="library-settings-modal"
        open
        centered
        width={820}
        style={{ height: "min(820px, calc(100dvh - 40px))" }}
        title={<div className="settings-modal-title"><span><Icon name="settings" /></span><div><h2>服务设置</h2><p>管理知识库资料与服务连接</p></div></div>}
        footer={null}
        closable={!isDeletingDocument}
        maskClosable={!isDeletingDocument}
        onCancel={() => { if (!isDeletingDocument) setShowSettings(false); }}
        styles={{ body: { padding: "0 20px 20px", overflowY: "auto" } }}
      >
            <div className="settings-modal-body">
              <section className="settings-section">
                <div className="settings-section-heading">
                  <div><h3>知识库资料</h3><p>删除后会同步移除对应知识片段和向量索引。</p></div>
                  <Button className="settings-add-document" onClick={() => { setShowSettings(false); fileInput.current?.click(); }} disabled={busy || isDeletingDocument}><span>＋</span> 添加资料</Button>
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
                    <Progress percent={Math.max(0, Math.min(100, Number(documentDelete.progress) || 0))} showInfo={false} status={documentDelete.status === "failed" ? "exception" : documentDelete.status === "completed" ? "success" : "active"} />
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
                      min="0"
                      max="95"
                      step="5"
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
      </DeferredModal>}

      {workspaceCreateOpen && <DeferredModal
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
      </DeferredModal>}

      {deleteConfirmation && <DeferredModal
        className="library-confirm-modal"
        open
        centered
        width={460}
        title={deleteConfirmation?.type === "document" ? "删除这份资料？" : "删除这段对话？"}
        onCancel={() => setDeleteConfirmation(null)}
        footer={[
          <Button key="cancel" onClick={() => setDeleteConfirmation(null)}>取消</Button>,
          <Button key="delete" danger type="primary" onClick={confirmDeletion}>确认删除</Button>,
        ]}
      >
        {deleteConfirmation && <p className="confirm-dialog-description">
          {deleteConfirmation.type === "document"
            ? `将从知识库删除“${deleteConfirmation.title}”，对应的知识片段和向量索引也会一起删除。`
            : `确定删除“${deleteConfirmation.title}”吗？删除后无法恢复。`}
          {deleteConfirmation.type === "document" && <><br /><small>此操作无法撤销</small></>}
        </p>}
      </DeferredModal>}
      </Suspense>
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
    variant: isUser ? "filled" : "borderless",
    shape: isUser ? "corner" : "default",
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
      <Progress className={progress.indeterminate ? "library-progress-indeterminate" : ""} percent={progress.indeterminate ? 34 : percent} showInfo={false} status={progress.kind === "error" ? "exception" : progress.kind === "success" ? "success" : "active"} />
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

