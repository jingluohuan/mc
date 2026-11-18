// 模板：增加自定义指令（含参数、说明、别名）
ITLZMC.plugin({
  id: 'myplugin-command',
  name: '我的指令插件',
  version: '1.0.0',
  description: '注册 /mycmd 与 /mygive',
  api: '1.0',
  capabilities: ['command'],
}, function (P) {
  P.addCommand('mycmd', {
    description: '示例指令',
    usage: '/mycmd <名字>',
    aliases: ['mc'],
    fn: function (ctx, args) {
      ctx.say('你好，' + (args[0] || 'ITLZMC') + '！当前插件数：' + ITLZMC.Plugins.list().length);
    },
  });
  P.addCommand('mygive', {
    description: '给自己一件物品',
    usage: '/mygive <key> [数量]',
    fn: function (ctx, args) {
      var key = args[0], n = parseInt(args[1] || '1', 10) || 1;
      if (!key) { ctx.say('用法：/mygive <key> [数量]'); return; }
      ctx.say(P.give(key, n) ? '已给予 ' + key + ' ×' + n : '找不到物品：' + key);
    },
  });
});
