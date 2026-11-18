'use strict';
// ---------------------------------------------------------------------------
// 离线版：公告板不再从房间服务拉取内容，也不在标题界面挂吊牌。
// 保留 NewsBoard.list / .open 等接口，供皮肤与装扮界面安全读取。
// ---------------------------------------------------------------------------
const NEWS_T = { swing: 0, drop: 0 };
function newsEase(t) { return t; }
function newsEaseIO(t) { return t; }

const NewsBoard = {
  list: [],
  items: [],
  lastFetch: 0,
  pending: null,
  fetch() { return Promise.resolve([]); },
  open() { },
  draw() { },
  tick() { },
  update() { },
};

class NewsScreen extends OfflineScreen { constructor(g) { super(g, '公告', '离线版没有在线公告。'); } }
class NewsEditScreen extends OfflineScreen { constructor(g) { super(g, '编辑公告'); } }
