'use strict';
// 房间服务地址：默认与游戏页面同源 —— 一体化的 server.js 同时托管静态站点、
// 房间 REST 接口与 /p2p 本地房间信令，不需要任何第三方平台。
// 也可在地址栏用 ?rooms=<自己的服务地址> 覆盖（RoomService.base() 会读取）。
window.NET_CONFIG = {
  rooms: (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : '',
  share: '',
};
