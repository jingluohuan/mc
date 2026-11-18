'use strict';
// ---------------------------------------------------------------------------
// 离线版：B 站 Toy SDK 已整体移除。
// 这里保留原模块的全部同名接口，让截图、手机适配等模块继续正常工作，
// 但所有调用都在本地降级，绝不发起 postMessage / 网络请求 / 跳转。
// ---------------------------------------------------------------------------
class ToyError extends Error {
  constructor(type, message, code) {
    super(message || type || 'unsupported');
    this.type = type || 'unsupported';
    this.code = code;
  }
}

const Toy = {
  inToy: false,
  ready() { return Promise.resolve(false); },
  explain(e) { return (e && e.message) || '该功能需要 B 站 Toy 环境，离线版不可用'; },
  unsupported() { return Promise.reject(new ToyError('unsupported')); },
};

// SDK 的其余方法统一降级：返回 Promise<null>，调用方要么忽略、要么已包 try/catch。
// 不挂 then，避免对象被 await 时误判成 thenable。
for (const k of [
  'following', 'triple', 'unlocks', 'userInfo', 'profile', 'login', 'logout',
  'contentCheck', 'checkText', 'textCheck', 'share', 'sharePicture', 'saveImage',
  'qrCode', 'closeBrowser', 'containerState', 'setContainerMode',
  'onContainerChange', 'openVideo', 'follow', 'like', 'coin', 'favorite',
  'notify', 'pageClose', 'status', 'get', 'post', 'request', 'call', 'init',
]) {
  if (!(k in Toy)) Toy[k] = () => Promise.resolve(null);
}
