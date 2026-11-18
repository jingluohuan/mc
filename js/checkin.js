'use strict';
// ---------------------------------------------------------------------------
// 离线版：签到活动与 /api/event 请求已移除。奖励全部默认解锁，
// 保留 Checkin.st / .shown 等接口供装扮界面读取。
// ---------------------------------------------------------------------------
const CHK_PENGUIN = null;
const CHK_PAL = null;
const CHK_BOX = null;
function chkRnd(n) { return Math.floor(Math.random() * (n || 1)); }

const Checkin = {
  st: { event: { rewards: [] }, today: false, day: 0, logged: false },
  busy: null,
  err: '',
  shown() { return false; },
  fetch() { return Promise.resolve(this.st); },
  quiet() { return Promise.resolve(this.st); },
  took() { return this.st; },
  notify() { },
  open() { },
};

class CheckinScreen extends OfflineScreen {
  constructor(g) { super(g, '签到', '离线版所有签到奖励已默认解锁。'); }
}
