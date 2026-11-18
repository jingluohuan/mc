// 模板：注册一张内嵌 PNG 贴图 + 一个发光方块 + 一条配方
// 16x16 PNG 请换成自己的 base64（不要留 __PNG__ 占位符）
ITLZMC.plugin({
  id: 'myplugin-texture',
  name: '我的贴图插件',
  version: '1.0.0',
  description: '新增一个自定义贴图的发光方块',
  api: '1.0',
  capabilities: ['texture', 'recipe'],
}, function (P) {
  var png = 'data:image/png;base64,__PNG__';
  var idx = P.addTexture('myplugin_lamp', png);           // 返回图集索引
  P.defineBlock({
    key: 'myplugin_lamp',
    cn: '我的灯',
    textures: { side: png, top: png, bottom: png },    // 自动注册并映射
    light: 15, hardness: 0.6, sound: 'glass',
  });
  P.addShapeless('myplugin_lamp', 1, ['glowstone', 'stick']);
  P.log('方块 id =', BID.myplugin_lamp, '贴图索引 =', idx);
});
