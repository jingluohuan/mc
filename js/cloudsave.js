'use strict';
// ---------------------------------------------------------------------------
// 离线版：云存档已移除。存档只写本机 IndexedDB / localStorage，
// 这里保留同名接口，任何仍在调用的旧代码都不会报错或发请求。
// ---------------------------------------------------------------------------
const CloudSave = {
  enabled: false,
  list() { return Promise.resolve([]); },
  upload() { return Promise.resolve(null); },
  download() { return Promise.resolve(null); },
  remove() { return Promise.resolve(); },
  sync() { return Promise.resolve(); },
  status() { return Promise.resolve(null); },
};

class CloudScreen extends OfflineScreen {
  constructor(g) { super(g, '云存档', '离线版不上传存档，世界数据只保存在本机。'); }
}
class CloudConflictScreen extends OfflineScreen {
  constructor(g) { super(g, '存档冲突'); }
}
