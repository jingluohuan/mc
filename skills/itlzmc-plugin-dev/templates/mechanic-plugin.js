// 模板：修改游戏机制（掉落 / 破坏 / 伤害 / 指令拦截）
ITLZMC.plugin({
  id: 'myplugin-mechanic',
  name: '我的机制插件',
  version: '1.0.0',
  description: '圆石掉落翻倍、基岩不可破坏、玩家免伤',
  api: '1.0',
  capabilities: ['mechanic'],
}, function (P) {
  var stat = { drops: 0, breaks: 0, hits: 0 };
  P.storage.set('stat', stat);

  P.on('dropItem', function (c) {
    if (c.stack && c.stack.id === ITEM_KEY.cobblestone) {
      stat.drops++;
      c.count = Math.min(64, (c.stack.count || 1) * 2);
    }
  });
  P.on('blockBreak', function (c) {
    stat.breaks++;
    if (c.id === BID.bedrock) c.cancel();
  });
  P.on('damage', function (c) {
    stat.hits++;
    if (c.entity === P.player()) c.amount = 0;
  });

  P.addCommand('mystat', {
    description: '查看机制钩子计数',
    fn: function (ctx) { ctx.say('计数：' + JSON.stringify(P.storage.get('stat', {}))); },
  });
});
