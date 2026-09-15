'use client';

// ─────────────────────────────────────────────────────────────────────────────
// BoardLobby.tsx — 联机棋类的**大厅**：对战席位 + 观战台（五款棋共用）
//
// 【大厅只在没在对局中时是"大厅"】对局进行中这里退化成原来那条席位栏（两席 + 围观 N）：
// 席位上的人、轮次高亮、（掉线）标记照旧，观战台**整块不渲染** —— 服务端在对局中根本
// 不下发名单（见 board-shared.ts 的 RoomView.spectators），所以这里连判断都省了。
//
// 【谁坐哪儿是点出来的，不是排出来的】空席位就是一个写着「加入」的按钮：
//   • 观战台上的人点它 → 坐进去（头像从观战台移到席位）；
//   • 已经坐在另一席的人点它 → **换先**（原席位空出来）；
//   • 有人坐着的席位不是按钮 —— 与对手互换座位要挪动别人的头像，那是另一回事（没做）。
// 服务端侧见 board-room.ts 的 takeSeat / leaveSeat：对局进行中一律拒绝。
//
// 【头像与用户名都来自服务端下发的名单】`SeatView.id` 就是 userId，头像走站内既有的
// `/api/avatar/<id>`（永不 404，没传过头像的自动是 identicon）。所以这里一行数据请求都没有。
//
// 【类名是字符串，拼错既不报错也不让单测转红】改类名前先 grep 使用方；`.board-*` 的样式
// 全在 styles-scss/pages/game/_board.scss。
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from 'react';
import type { Player, RoomView, Seat, SeatView } from '@/lib/board-shared';
import { playerOfSeat } from '@/lib/board-shared';

export interface BoardLobbyProps {
  view: RoomView;
  /** 我的 userId —— 名单里那个「· 你」靠它认人（席位与观战台都可能是你）。 */
  myId: string | null;
  mySeat: Seat | null;
  /** 某一席显示成什么：五子棋是黑白子、井字棋是 X/O、走子类是「红方 / 白方」。 */
  seatLabel: (player: Player) => ReactNode;
  onTakeSeat: (seat: Seat) => void;
  onLeaveSeat: () => void;
}

const SEATS: readonly Seat[] = ['black', 'white'];

/** 一条名单项：头像 + 用户名 +（掉线）+「· 你」。席位与观战台共用。 */
function Person({
  entry,
  myId,
  className,
  avatarClass,
  dataSeat,
}: {
  entry: SeatView;
  myId: string | null;
  className: string;
  avatarClass: string;
  /** 席位 id（'black' / 'white'）。观战台上的人没有席位，不传。 */
  dataSeat?: Seat;
}) {
  return (
    <span className={className} data-seat={dataSeat} data-seat-id={entry.id}>
      {/* 站内头像接口：没传过头像就是确定性 identicon，永不碎图 */}
      <img className={avatarClass} src={`/api/avatar/${entry.id}`} alt="" />
      {entry.name}
      {!entry.connected && '（掉线）'}
      {entry.id === myId && ' · 你'}
    </span>
  );
}

export default function BoardLobby({
  view,
  myId,
  mySeat,
  seatLabel,
  onTakeSeat,
  onLeaveSeat,
}: BoardLobbyProps) {
  const playing = view.status === 'playing';

  return (
    <>
      <div className="board-seats">
        {SEATS.map((seat) => {
          const holder = view.seats[seat];
          // 轮到谁走：只在真正的对局中才有意义
          const active = playing && view.turn === playerOfSeat(seat);

          if (!holder) {
            return playing ? (
              // 对局中不可能有空席（房间层保证 playing ⇒ 两席都有人），兜个底不至于渲染成按钮
              <span key={seat} className="board-seat" data-seat={seat}>
                {seatLabel(playerOfSeat(seat))} · 空位
              </span>
            ) : (
              <button
                key={seat}
                type="button"
                className="board-seat board-seat--open"
                data-seat={seat}
                onClick={() => onTakeSeat(seat)}
              >
                {seatLabel(playerOfSeat(seat))} · {mySeat ? '换先' : '加入'}
              </button>
            );
          }

          return (
            <Person
              key={seat}
              entry={holder}
              myId={myId}
              className={`board-seat${active ? ' board-seat--active' : ''}`}
              avatarClass="board-seat__avatar"
              dataSeat={seat}
            />
          );
        })}

        {/* 围观人数：对局中才显示 —— 不在对局时观战台整块在旁边摆着，不必再报一次数 */}
        {playing && view.spectatorCount > 0 && (
          <span className="board-seat board-seat--spec">围观 {view.spectatorCount}</span>
        )}
      </div>

      {!playing && (
        <div className="board-bench">
          <div className="board-bench__head">
            <span className="board-hint">观战台</span>
            {mySeat && (
              <button type="button" className="board-btn board-btn--small" onClick={onLeaveSeat}>
                去观战台
              </button>
            )}
          </div>
          <div className="board-bench__list">
            {view.spectators.length === 0 ? (
              <span className="board-bench__empty">还没有人，把链接发给朋友吧</span>
            ) : (
              view.spectators.map((entry) => (
                <Person
                  key={entry.id}
                  entry={entry}
                  myId={myId}
                  className="board-bench__item"
                  avatarClass="board-bench__avatar"
                />
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
