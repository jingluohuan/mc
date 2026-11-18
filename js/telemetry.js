'use strict';
// ---------------------------------------------------------------------------
// 离线版：遥测 / 反馈上报已移除。全部计数与上报变成本地 no-op，不发任何请求。
// OfflineScreen 是各平台模块共用的安全占位界面（入口已移除，仅防止误触报错）。
// ---------------------------------------------------------------------------
const TELEMETRY_V = 1;
const GAME_BUILD = 'offline';

const Telemetry = {
  enabled: false,
  base() { return ''; },
  count() { },
  event() { },
  error() { },
  tick() { },
  flush() { return Promise.resolve(); },
  send() { return Promise.resolve(); },
  feedback() { return Promise.reject(new Error('离线版不提供在线反馈')); },
  init() { },
  start() { },
  stop() { },
};

const FEEDBACK_KINDS = [];
function feedbackShot() { return null; }

class OfflineScreen extends MenuScreen {
  constructor(game, title, note) {
    super(game, title || '离线版');
    this.note = note || '该功能需要在线服务，离线版已关闭。存档、皮肤与装扮都保存在本机。';
    this.pauses = false;
  }
  layout() {
    const u = this.game.ui;
    this.widgets = [
      { x: Math.floor(u.w / 2 - 100), y: Math.floor(u.h / 2 + 26), w: 200, h: 20, label: '返回', onClick: () => this.game.ui.close() },
    ];
  }
  drawExtra(ui) {
    const c = ui.ctx, cx = ui.w / 2, cy = ui.h / 2;
    Font.center(c, this.note, cx, cy - 18, '#A0A0A0');
    Font.center(c, '无需登录 · 完全离线', cx, cy, '#55FF55');
  }
}

class TelemetryScreen extends OfflineScreen {
  constructor(game, parent) { super(game, '遥测与统计', '离线版不收集也不上传任何数据。'); }
}
class FeedbackScreen extends OfflineScreen {
  constructor(game, parent, shot) { super(game, '反馈问题', '离线版没有在线反馈通道。'); }
}
