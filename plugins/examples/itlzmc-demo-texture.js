// ITLZMC 插件示例 1/3：渲染贴图 + 注册方块 + 配方
// 通过 ?plugin=plugins/examples/itlzmc-demo-texture.js 加载（也可放进 plugins/ 自动加载）
ITLZMC.plugin({
  id: 'itlzmc-demo-texture',
  name: '示例·贴图方块',
  version: '1.0.0',
  description: '注册一张内嵌 PNG 贴图、一个发光方块和一条合成配方',
  capabilities: ['texture'],
}, function (P) {
  var png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAW0lEQVR4nGMUimn6z0ABYGFgYGAQ8QkjS/ObLasYmCixHe4CGChwVidK04S9N+Fsil1AXS8gg0yRuyj86W+UaeOCgTcAZxjg8jPVXUBdLyCnMPq64M2WVWQbAAAQTRExDRZPSQAAAABJRU5ErkJggg==';
  var idx = P.addTexture('qiumc_demo_lamp', png);          // 返回图集索引
  P.defineBlock({
    key: 'qiumc_demo_lamp',
    cn: 'ITLZ 示例灯',
    tex: { side: 'qiumc_demo_lamp', top: 'qiumc_demo_lamp', bottom: 'qiumc_demo_lamp' },
    light: 15, hardness: 0.6, sound: 'glass',
  });
  P.addShapeless('qiumc_demo_lamp', 1, ['glowstone', 'stick']);
  P.log('方块 id =', BID.qiumc_demo_lamp, '贴图索引 =', idx);
});
