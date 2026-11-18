ITLZMC.plugin({
  id: 'itlzmc-peaceful-night', name: '安宁之夜', version: '1.0.0',
  description: '阻止常见敌对生物生成', api: '1.0', capabilities: ['mechanic'],
}, function (P) {
  P.on('entitySpawn', function (c) {
    var t = c.entity && c.entity.type;
    if (/^(zombie|creeper|skeleton|spider|enderman|witch|pillager|husk|stray|drowned)$/.test(t || '')) c.cancel();
  });
  P.addCommand('peace', {
    description: '查看安宁之夜插件状态',
    fn: function (ctx) { ctx.say('安宁之夜已启用：敌对生物不再生成'); },
  });
});
