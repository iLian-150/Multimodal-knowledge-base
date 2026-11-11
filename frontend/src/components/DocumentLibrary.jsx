import { useEffect, useState } from "react";
import Button from "antd/es/button";
import Empty from "antd/es/empty";
import Modal from "antd/es/modal";
import Spin from "antd/es/spin";
import { Download, Eye, FileText, Upload } from "lucide-react";
import "./DocumentLibrary.css";

function documentName(source) {
  return String(source || "").replace(/\\/g, "/").split("/").pop() || String(source || "未命名文档");
}

function makeApiUrl(apiBase, path) {
  return `${String(apiBase || "").replace(/\/+$/, "")}${path}`;
}

export default function DocumentLibrary({ open, apiBase, workspaceId, documents = [], busy = false, onUpload, onClose }) {
  const [preview, setPreview] = useState(null);
  const [loadingSource, setLoadingSource] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setError("");
      setLoadingSource("");
    }
  }, [open, workspaceId]);

  async function viewDocument(source) {
    setLoadingSource(source);
    setError("");
    try {
      const query = new URLSearchParams({ source, workspace_id: workspaceId });
      const response = await fetch(makeApiUrl(apiBase, `/kb/documents/content?${query}`));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || `读取失败（${response.status}）`);
      setPreview(payload);
    } catch (requestError) {
      setError(requestError.message || "读取文档失败");
    } finally {
      setLoadingSource("");
    }
  }

  function downloadDocument(source) {
    const query = new URLSearchParams({ source, workspace_id: workspaceId });
    const link = document.createElement("a");
    link.href = makeApiUrl(apiBase, `/kb/documents/download?${query}`);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  const sources = [...new Set((documents || []).filter(Boolean))];

  return <>
    <Modal
      className="document-library-modal"
      open={open}
      title={<span className="document-library-title"><FileText size={19} />文档资料 <small>{sources.length} 份</small></span>}
      centered
      width={760}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      <div className="document-library-toolbar">
        <p>当前工作区域中的全部知识库文档</p>
        <Button type="primary" icon={<Upload size={16} />} onClick={onUpload} disabled={busy}>上传文档</Button>
      </div>
      {error && <div className="document-library-error" role="alert">{error}</div>}
      <div className="document-library-list">
        {sources.length ? sources.map((source) => (
          <div className="document-library-row" key={source}>
            <span className="document-library-file-icon"><FileText size={18} /></span>
            <span className="document-library-name" title={source}>{documentName(source)}</span>
            <div className="document-library-actions">
              <Button type="text" icon={<Eye size={16} />} loading={loadingSource === source} onClick={() => void viewDocument(source)}>查看</Button>
              <Button type="text" icon={<Download size={16} />} onClick={() => downloadDocument(source)}>下载</Button>
            </div>
          </div>
        )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前工作区域还没有文档" />}
      </div>
      <p className="document-library-note">旧文档若未保存原文件，下载时会导出知识库已解析的文本；新上传文档会保留原文件。</p>
    </Modal>

    <Modal
      className="document-preview-modal"
      open={Boolean(preview)}
      title={preview?.filename || "文档预览"}
      centered
      width={900}
      footer={[
        <Button key="close" onClick={() => setPreview(null)}>关闭</Button>,
        <Button key="download" type="primary" icon={<Download size={16} />} onClick={() => downloadDocument(preview?.source)}>下载</Button>,
      ]}
      onCancel={() => setPreview(null)}
      destroyOnHidden
    >
      {preview && <>
        {!preview.original_available && <div className="document-library-note document-library-preview-note">服务器没有保存这份文档的原始文件，以下内容来自知识库已解析文本。</div>}
        {preview.truncated && <div className="document-library-note document-library-preview-note">预览内容较长，当前显示前 15 万字；下载可获取完整解析文本。</div>}
        <div className="document-preview-body">{preview.content
          ? <pre>{preview.content}</pre>
          : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可预览的文本内容" />}</div>
      </>}
    </Modal>
    {loadingSource && <span className="visually-hidden" aria-live="polite"><Spin size="small" />正在读取文档</span>}
  </>;
}
