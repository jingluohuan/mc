ITLZMC.plugin({
  id: 'itlzmc-double-drops', name: '双倍掉落', version: '1.0.0',
  description: '所有方块掉落物数量翻倍', api: '1.0', capabilities: ['mechanic'],
}, function (P) {
  P.on('dropItem', function (c) {
    if (c.stack && c.stack.count) c.count = Math.min(64, c.stack.count * 2);
  });
  P.addCommand('drops', {
    description: '查看双倍掉落插件状态',
    fn: function (ctx) { ctx.say('双倍掉落已启用：所有掉落物数量 ×2'); },
  });
});
