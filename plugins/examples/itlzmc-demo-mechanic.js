// ITLZMC 插件示例 2/3：修改机制（事件总线，可取消 / 可改参数）
ITLZMC.plugin({
  id: 'itlzmc-demo-mechanic',
  name: '示例·机制修改',
  version: '1.0.0',
  description: '演示 blockBreak 取消、dropItem 改数量、damage 改伤害、command 拦截、tick 计数',
  capabilities: ['mechanic'],
}, function (P) {
  var stat = { breaks: 0, drops: 0, hits: 0, cmds: 0, ticks: 0 };
  P.storage.set('stat', stat);

  // 机制事件：回调收到可变 ctx
  P.on('blockBreak', function (c) {
    stat.breaks++;
    // 演示可取消：让基岩以外的「石头」不可破坏（默认示例不加载，不会真的影响游戏）
    if (c.id === BID.stone) c.cancel();
  });

  P.on('dropItem', function (c) {
    stat.drops++;
    // 演示改参数：圆石掉落翻倍
    if (c.stack && c.stack.id === ITEM_KEY.cobblestone) {
      c.count = Math.min(64, (c.stack.count || 1) * 2);
    }
  });

  P.on('damage', function (c) {
    stat.hits++;
    if (c.entity === P.player()) c.amount = 0;   // 演示免疫伤害
  });

  P.on('command', function (c) {
    stat.cmds++;
    if (c.name === 'seed') { c.cancel(); c.result = true; }  // 演示拦截原版指令
  });

  // 生命周期事件：回调直接收到 game
  P.on('tick', function (g) {
    if (g && g.state === 'play') stat.ticks++;
    if (stat.ticks && stat.ticks % 200 === 0) P.storage.set('stat', stat);
  });

  P.setConfig('enabled', true);
  P.addCommand('qmstat', {
    description: '查看示例机制插件的事件计数',
    fn: function (ctx) {
      ctx.say('机制钩子的计数：' + JSON.stringify(stat));
    },
  });
  ITLZMC.__mechanicStat = stat;   // 供自动化验收直接读取真实计数
  P.log('已挂载 5 个机制钩子');
});
