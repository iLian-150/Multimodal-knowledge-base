import { useEffect, useMemo, useRef, useState } from "react";
import Conversations from "@ant-design/x/es/conversations/index.js";
import Button from "antd/es/button";
import Drawer from "antd/es/drawer";
import Dropdown from "antd/es/dropdown";
import Empty from "antd/es/empty";
import Input from "antd/es/input";
import Modal from "antd/es/modal";
import Tooltip from "antd/es/tooltip";
import { ChevronsUpDown, LibraryBig, MessageSquare, MoreHorizontal, FolderOpen, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Search, Settings2, SquarePen, Trash2, X } from "lucide-react";
import styles from "./Sidebar.module.css";

const iconProps = { size: 18, strokeWidth: 1.75, "aria-hidden": true };

const normalize = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase();

export default function Sidebar({ conversations, activeId, busy, collapsed, onToggleCollapsed, mobileOpen, onCloseMobile, onNewChat, onSelectConversation, onRenameConversation, onDeleteConversation, workspaces, activeWorkspaceId, onSelectWorkspace, onCreateWorkspace, onOpenSettings, onOpenDocuments, workspaceDeleting, defaultWorkspaceId, onDeleteWorkspace }) {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 700px)").matches);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [resultIndex, setResultIndex] = useState(0);
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const searchInput = useRef(null);
  const searchResults = useRef(null);
  const rail = collapsed && !mobile;
  const workspace = workspaces.find((item) => item.id === activeWorkspaceId) || workspaces[0];

  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => { setMobile(media.matches); if (!media.matches) onCloseMobile(); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [onCloseMobile]);

  useEffect(() => {
    const handleKey = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return;
      if (Array.from(document.querySelectorAll('.ant-modal-wrap')).some((element) => element.getClientRects().length > 0)) return;
      if (!event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setQuery(""); setResultIndex(0); setSearchOpen(true);
      } else if (event.shiftKey && event.key.toLowerCase() === "o" && !busy) {
        event.preventDefault();
        onNewChat();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [busy, onNewChat]);

  useEffect(() => {
    setSearchOpen(false); setRenaming(null); setQuery("");
  }, [activeWorkspaceId]);

  const items = useMemo(() => conversations.map((conversation) => ({
    key: conversation.id,
    title: conversation.title || "新对话",
    label: <Button
      type="text"
      className={styles.conversationTitle}
      title={conversation.title || "新对话"}
      aria-current={activeId === conversation.id ? "page" : undefined}
      onClick={(event) => { event.stopPropagation(); onSelectConversation(conversation.id); }}
    >{conversation.title || "新对话"}</Button>,
  })), [conversations, activeId, onSelectConversation]);

  const results = useMemo(() => {
    const term = normalize(query.trim());
    return conversations.flatMap((conversation) => {
      const message = term && conversation.messages?.find((item) => !item.fileProgress && normalize(item.text).includes(term));
      if (term && !normalize(conversation.title).includes(term) && !message) return [];
      return [{ ...conversation, snippet: message ? String(message.text).replace(/\s+/g, " ").slice(0, 100) : "" }];
    });
  }, [conversations, query]);

  useEffect(() => {
    searchResults.current?.querySelector(`[data-result-index="${resultIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [resultIndex]);

  function openSearch() {
    setQuery(""); setResultIndex(0); setSearchOpen(true);
  }

  function selectResult(conversation) {
    if (!conversation) return;
    setSearchOpen(false);
    onSelectConversation(conversation.id);
  }

  function beginRename(id) {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return;
    setRenaming(id); setRenameValue(conversation.title || "新对话");
  }

  function finishRename() {
    if (!renaming || !renameValue.trim() || busy) return;
    onRenameConversation(renaming, renameValue.trim());
    setRenaming(null);
  }

  const navigation = <aside className={`${styles.sidebar} ${rail ? styles.rail : ""}`} aria-label="主导航">
    <div className={styles.header}>
      {!rail && <button className={styles.brand} onClick={onNewChat} disabled={busy} aria-label="库解，开始新对话">
        <img className={styles.brandLogo} src="/logo.png" alt="" aria-hidden="true" />
      </button>}
      <Tooltip title={mobile ? "关闭侧栏" : rail ? "展开侧栏" : "收起侧栏"} placement="right">
        <Button type="text" className={styles.iconButton} aria-label={mobile ? "关闭侧栏" : rail ? "展开侧栏" : "收起侧栏"} onClick={mobile ? onCloseMobile : onToggleCollapsed} icon={mobile ? <X {...iconProps} /> : rail ? <PanelLeftOpen {...iconProps} /> : <PanelLeftClose {...iconProps} />} />
      </Tooltip>
    </div>

    <div className={styles.actions}>
      <Tooltip title={rail ? "新建对话" : null} placement="right">
        <Button className={styles.newChat} type="text" onClick={onNewChat} disabled={busy} aria-label="新建对话" icon={<SquarePen {...iconProps} />}>{!rail && "新建对话"}</Button>
      </Tooltip>
      <Tooltip title={rail ? "文档资料" : null} placement="right">
        <Button className={styles.action} type="text" onClick={onOpenDocuments} aria-label="文档资料" icon={<FolderOpen {...iconProps} />}>{!rail && "文档资料"}</Button>
      </Tooltip>
      <Tooltip title={rail ? "搜索对话" : null} placement="right">
        <Button className={styles.action} type="text" onClick={openSearch} aria-label="搜索对话" icon={<Search {...iconProps} />}>{!rail && "搜索对话"}</Button>
      </Tooltip>
    </div>

    {!rail && <nav className={styles.history} aria-label="历史对话">
      {items.length ? <Conversations
        className={styles.conversations}
        activeKey={activeId || undefined}
        items={items}
        onActiveChange={onSelectConversation}
        menu={(conversation) => ({
          trigger: <Button className={styles.menuTrigger} type="text" size="small" aria-label={`管理对话：${conversation.title}`} icon={<MoreHorizontal size={17} strokeWidth={1.8} aria-hidden />} />,
          items: [
            { key: "rename", label: "重命名", icon: <Pencil size={15} />, disabled: busy, onClick: () => beginRename(conversation.key) },
            { type: "divider" },
            { key: "delete", label: "删除对话", icon: <Trash2 size={15} />, danger: true, disabled: busy, onClick: () => onDeleteConversation(conversation.key) },
          ],
        })}
      /> : <div className={styles.emptyHistory}><span>还没有历史对话</span></div>}
    </nav>}

    <div className={styles.footer}>
      <Tooltip title={rail ? "服务设置" : null} placement="right">
        <Button type="text" className={styles.action} onClick={onOpenSettings} aria-label="服务设置" icon={<Settings2 {...iconProps} />}>{!rail && "服务设置"}</Button>
      </Tooltip>
      <Dropdown trigger={["click"]} placement="topLeft" disabled={busy} menu={{
        selectedKeys: [activeWorkspaceId],
        items: [
          { key: "heading", label: "切换工作区域", disabled: true },
          ...workspaces.map((item) => ({
            key: item.id,
            label: <div className={styles.workspaceMenuItem}>
              <span className={styles.workspaceMenuName}>{item.name}</span>
              {item.id !== defaultWorkspaceId && <Button
                type="text"
                size="small"
                className={styles.workspaceMenuDelete}
                aria-label={`删除工作区：${item.name}`}
                title={`删除工作区：${item.name}`}
                icon={<Trash2 size={14} />}
                disabled={busy || workspaceDeleting}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onDeleteWorkspace(item.id);
                }}
              />}
            </div>,
            icon: <LibraryBig size={16} />,
          })),
          { type: "divider" },
          { key: "create", label: "新建工作区域", icon: <Plus size={16} /> },
        ],
        onClick: ({ key }) => { if (key === "create") onCreateWorkspace(); else if (key !== "heading") onSelectWorkspace(key); },
      }}>
        <Button type="text" className={`${styles.action} ${styles.workspace}`} disabled={busy} aria-label={`切换工作区域，当前：${workspace.name}`} title={rail ? workspace.name : undefined}>
          <span className={styles.workspaceIcon}><LibraryBig {...iconProps} /></span>
          {!rail && <span className={styles.workspaceCopy} title="工作区域">{workspace.name}</span>}
          {!rail && <ChevronsUpDown size={15} strokeWidth={1.6} className={styles.workspaceChevron} aria-hidden />}
        </Button>
      </Dropdown>
    </div>
  </aside>;

  return <>
    {mobile ? <Drawer open={mobileOpen} onClose={onCloseMobile} placement="left" size={280} closable={false} styles={{ body: { padding: 0 } }} aria-label="导航菜单">{navigation}</Drawer> : navigation}

    <Modal open={searchOpen} onCancel={() => setSearchOpen(false)} title="搜索对话" footer={null} centered width={600} destroyOnHidden afterOpenChange={(open) => { if (open) searchInput.current?.focus(); }}>
      <Input ref={searchInput} className={styles.searchInput} size="large" prefix={<Search {...iconProps} />} placeholder="搜索标题或对话内容" aria-label="搜索标题或对话内容" value={query} allowClear onChange={(event) => { setQuery(event.target.value); setResultIndex(0); }} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setResultIndex((index) => results.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length : 0); }
        if (event.key === "Enter") { event.preventDefault(); selectResult(results[resultIndex]); }
      }} />
      <p className={styles.searchScope}>{workspace.name} · {results.length} 段对话</p>
      <div className={styles.searchResults} ref={searchResults}>
        {results.length ? results.map((conversation, index) => <button key={conversation.id} data-result-index={index} className={`${styles.searchResult} ${index === resultIndex ? styles.searchResultSelected : ""}`} onClick={() => selectResult(conversation)}>
          <MessageSquare {...iconProps} /><span><strong>{conversation.title || "新对话"}</strong>{conversation.snippet && <small>{conversation.snippet}</small>}</span>
        </button>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query.trim() ? "没有找到相关对话" : "当前工作区域还没有对话"} />}
      </div>
    </Modal>

    <Modal open={Boolean(renaming)} title="重命名对话" centered width={420} onCancel={() => setRenaming(null)} onOk={finishRename} okText="保存" cancelText="取消" okButtonProps={{ disabled: !renameValue.trim() || busy }} destroyOnHidden>
      <Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onPressEnter={finishRename} maxLength={60} aria-label="对话名称" placeholder="输入对话名称" />
    </Modal>
  </>;
}
