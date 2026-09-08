'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatSidebar.tsx — 会话列表侧栏（大区 + 私聊，含未读徽标 / 静音标记 / 折叠）
//
// 纯展示 + 回调：数据与状态都在 ChatApp。侧栏行包了 memo —— 对账每 60 秒整表
// 替换一次 channels 数组，未变化的行不该重渲染。
//
// 每行右侧的「⋯」按钮打开 ChatChannelMenu（静音 / 删除会话）。行本身是 <button>，
// 所以菜单按钮放在**兄弟节点**而不是嵌套（button 里套 button 是非法 HTML）。
// ─────────────────────────────────────────────────────────────────────────────

import { memo, useState } from 'react';
import { MessageCircle, MoreHorizontal, VolumeX } from 'lucide-react';
import { CHAT_FOCUS_BLOCKED_TITLE, type ChatChannelDTO } from '@/lib/chat-shared';
import ChatChannelMenu, { type ChannelMenuAnchor } from './ChatChannelMenu';

const SidebarRow = memo(function SidebarRow({
  ch,
  active,
  onClick,
  onMenu,
}: {
  ch: ChatChannelDTO;
  active: boolean;
  onClick: () => void;
  onMenu: (ch: ChatChannelDTO, el: HTMLButtonElement) => void;
}) {
  const isLobby = ch.kind === 'lobby';
  const disabled = !!ch.disabled;
  return (
    <div className="chat-chan-wrap">
      <button
        type="button"
        className={`chat-chan${active ? ' is-active' : ''}${ch.unread_count > 0 ? ' has-unread' : ''}${disabled ? ' is-disabled' : ''}`}
        // 专注模式禁用行：不用 disabled attribute（Chrome 对 disabled 元素不弹原生 title），
        // 用 aria-disabled + tabIndex=-1 + onClick 置空；行保留（title/预览由服务端置空）。
        onClick={disabled ? undefined : onClick}
        title={disabled ? CHAT_FOCUS_BLOCKED_TITLE : ch.title}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : undefined}
      >
        {isLobby ? (
          <span className="chat-chan__icon" aria-hidden="true">
            <MessageCircle />
          </span>
        ) : (
          <span className="chat-chan__avatar">
            <img src={`/api/avatar/${ch.peer?.id ?? ''}`} alt="" loading="lazy" />
          </span>
        )}
        <span className="chat-chan__main">
          <span className="chat-chan__title">
            {ch.muted && (
              <VolumeX className="chat-chan__muted" aria-label="已静音" />
            )}
            {ch.title}
          </span>
          <span className="chat-chan__preview">
            {disabled
              ? CHAT_FOCUS_BLOCKED_TITLE
              : ch.last_message
                ? `${ch.last_message.author_name ? ch.last_message.author_name + '：' : ''}${ch.last_message.content}`
                : isLobby
                  ? '来聊聊吧'
                  : '开始对话'}
          </span>
        </span>
        {ch.unread_count > 0 && (
          <span className="chat-chan__badge">{ch.unread_count > 99 ? '99+' : ch.unread_count}</span>
        )}
      </button>
      {!disabled && (
        <button
          type="button"
          className="chat-chan__more"
          onClick={(e) => onMenu(ch, e.currentTarget)}
          aria-label={`${ch.title} 的更多操作`}
          title="更多操作"
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
      )}
    </div>
  );
});

export default function ChatSidebar({
  channels,
  activeId,
  collapsed,
  onToggleCollapse,
  onSelect,
  onNewChat,
  onMute,
  onHide,
}: {
  channels: ChatChannelDTO[];
  activeId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onMute: (ch: ChatChannelDTO, muted: boolean) => void;
  onHide: (ch: ChatChannelDTO) => void;
}) {
  const [menu, setMenu] = useState<{ ch: ChatChannelDTO; anchor: ChannelMenuAnchor } | null>(null);

  return (
    <aside className="chat-sidebar" aria-label="会话列表">
      <div className="chat-sidebar__head">
        <span className="chat-sidebar__title">聊天</span>
        <button
          type="button"
          className="chat-sidebar__collapse"
          onClick={onToggleCollapse}
          aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      <div className="chat-sidebar__list">
        {channels.map((c) => (
          <SidebarRow
            key={c.id}
            ch={c}
            active={c.id === activeId}
            onClick={() => onSelect(c.id)}
            onMenu={(ch, el) => setMenu({ ch, anchor: { rect: el.getBoundingClientRect() } })}
          />
        ))}
        {channels.length === 0 && <div className="chat-sidebar__empty">加载中…</div>}
      </div>

      <div className="chat-sidebar__foot">
        <button type="button" className="chat-new-btn" onClick={onNewChat}>
          <span aria-hidden="true">＋</span>
          {!collapsed && <span>发起私聊</span>}
        </button>
      </div>

      {menu && (
        <ChatChannelMenu
          channel={menu.ch}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          onMute={(muted) => {
            const ch = menu.ch;
            setMenu(null);
            onMute(ch, muted);
          }}
          onHide={() => {
            const ch = menu.ch;
            setMenu(null);
            onHide(ch);
          }}
        />
      )}
    </aside>
  );
}
