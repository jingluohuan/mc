// 最小插件骨架：复制后按需补充能力
ITLZMC.plugin({
  id: 'myplugin-hello',
  name: '我的插件',
  version: '1.0.0',
  description: '插件功能说明',
  api: '1.0',
  capabilities: [],
}, function (P) {
  P.on('ready', function (g) {
    P.log('游戏已就绪', g && g.constructor.name);
    P.message('我的插件已加载');
  });
});
