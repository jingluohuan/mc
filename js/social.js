'use strict';
// ---------------------------------------------------------------------------
// 离线版：内容审核 / 邀请卡 / 平台公告已移除。
// 服务器公告（若误入联机消息）改成一条本地提示，不弹平台界面。
// ---------------------------------------------------------------------------
function showAnnounce(g, m) {
  try {
    const text = m && (m.text || m.msg || m.message);
    if (text && g && g.ui && typeof g.ui.message === 'function') g.ui.message(String(text), '#FFFF55');
  } catch (e) { }
}

class InviteCardScreen extends OfflineScreen {
  constructor(g) { super(g, '邀请卡', '离线版没有在线房间邀请。'); }
}
