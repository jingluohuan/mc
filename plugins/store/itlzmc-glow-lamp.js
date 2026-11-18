ITLZMC.plugin({
  id: 'itlzmc-glow-lamp', name: 'ITLZ 发光灯', version: '1.0.0',
  description: '内嵌贴图 + 发光方块 + 合成配方', api: '1.0', capabilities: ['texture', 'recipe'],
}, function (P) {
  var png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAW0lEQVR4nGMUimn6z0ABYGFgYGAQ8QkjS/ObLasYmCixHe4CGChwVidK04S9N+Fsil1AXS8gg0yRuyj86W+UaeOCgTcAZxjg8jPVXUBdLyCnMPq64M2WVWQbAAAQTRExDRZPSQAAAABJRU5ErkJggg==';
  P.addTexture('qiumc_glow_lamp_tex', png);
  P.defineBlock({
    key: 'qiumc_glow_lamp', cn: 'ITLZ 发光灯',
    tex: { side: 'qiumc_glow_lamp_tex', top: 'qiumc_glow_lamp_tex', bottom: 'qiumc_glow_lamp_tex' },
    light: 15, hardness: 0.6, sound: 'glass',
  });
  P.addShapeless('qiumc_glow_lamp', 1, ['glowstone', 'stick']);
  P.log('发光灯方块已注册');
});
