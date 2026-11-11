import Button from "antd/es/button";
import Empty from "antd/es/empty";
import Input from "antd/es/input";
import List from "antd/es/list";
import Modal from "antd/es/modal";
import Slider from "antd/es/slider";
import Tabs from "antd/es/tabs";
import { FileText, Upload } from "lucide-react";
import TaskProgress from "./TaskProgress.jsx";

const filename = (value) => String(value || "").split(/[\\/]/).pop();

function Field({ label, id, help, children }) {
  return <div className="settings-field"><label htmlFor={id}>{label}</label>{children}{help && <small>{help}</small>}</div>;
}

export default function SettingsDialog({ summary, documentDelete, busy, onDeleteDocument, onAddDocuments, apiBase, onApiBaseChange, onRefresh, rerankRules, onRerankRulesChange, threshold, onThresholdChange, onClose }) {
  const documents = summary?.sources || [];
  const deleting = ["queued", "running"].includes(documentDelete?.status);
  return <Modal className="library-settings-modal" open centered width={760} title="服务设置" footer={null} closable={!deleting} mask={{ closable: !deleting }} onCancel={() => { if (!deleting) onClose(); }}>
    <Tabs items={[
      {
        key: "documents", label: "知识库资料", children: <>
          <div className="settings-toolbar"><span>{documents.length} 份资料 · {summary?.chunk_count ?? 0} 个片段</span><Button icon={<Upload size={16} />} onClick={onAddDocuments} disabled={busy || deleting}>添加资料</Button></div>
          <List dataSource={documents} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有资料" /> }} renderItem={(source) => <List.Item actions={[<Button key="delete" type="text" danger onClick={() => onDeleteDocument(source)} disabled={busy || deleting}>{deleting && documentDelete.source === source ? "删除中…" : "删除"}</Button>]}>
            <List.Item.Meta avatar={<FileText size={18} />} title={<span className="settings-document-name" title={source}>{filename(source)}</span>} />
          </List.Item>} />
          {documentDelete && <TaskProgress title={filename(documentDelete.source)} label={documentDelete.phase} percent={documentDelete.progress} kind={documentDelete.status === "failed" ? "error" : documentDelete.status === "completed" ? "success" : "working"} error={documentDelete.error} />}
        </>,
      },
      {
        key: "answers", label: "问答设置", children: <>
          {[
            { key: "boostTerms", label: "优先匹配关键词", placeholder: "例如：奖学金金额、申请条件" },
            { key: "excludeTerms", label: "排除关键词", placeholder: "例如：目录、封面" },
          ].map(({ key, label, placeholder }) => <Field key={key} label={label} id={key}>
            <Input.TextArea id={key} rows={3} value={rerankRules[key]} placeholder={placeholder} onChange={(event) => onRerankRulesChange((current) => ({ ...current, [key]: event.target.value }))} />
          </Field>)}
          <p className="settings-hint">关键词用逗号或换行分隔，每组最多 20 个。设置自动保存，对之后的问题生效。</p>
          <Field label={`答案最低可信度 · ${threshold}%`} id="hallucination-threshold" help="越低越宽松；0% 不按可信度拦截回答。">
            <Slider id="hallucination-threshold" min={0} max={95} step={5} value={threshold} onChange={onThresholdChange} aria-label="最低可信度" tooltip={{ formatter: (value) => `${value}%` }} />
          </Field>
        </>,
      },
      {
        key: "connection", label: "服务连接", children: <Field label="后端 API 地址" id="api-base" help="密钥在后端 .env 中配置。"><Input id="api-base" value={apiBase} onChange={(event) => onApiBaseChange(event.target.value)} onBlur={onRefresh} spellCheck={false} /></Field>,
      },
    ]} />
  </Modal>;
}
