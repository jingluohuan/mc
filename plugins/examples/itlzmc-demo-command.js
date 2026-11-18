// ITLZMC 插件示例 3/3：增加指令（带说明、用法、别名、参数）
ITLZMC.plugin({
  id: 'itlzmc-demo-command',
  name: '示例·自定义指令',
  version: '1.0.0',
  description: '注册 /itlzmc 系列指令，展示插件清单、事件、指令与运行时 API',
  capabilities: ['command'],
}, function (P) {
  P.addCommand('itlzmc', {
    description: 'ITLZMC 插件系统状态',
    usage: '/itlzmc [plugins|events|commands|api]',
    aliases: ['qi'],
    fn: function (ctx, args) {
      var M = ITLZMC.Plugins, sub = (args[0] || 'plugins').toLowerCase();
      if (sub === 'plugins') {
        var names = M.list().map(function (r) { return r.name + (r.error ? '（失败）' : ''); });
        ctx.say('已加载 ' + names.length + ' 个插件：' + names.join('、'));
      } else if (sub === 'events') {
        ctx.say('已挂载机制钩子：' + M.hookStats().join('、'));
      } else if (sub === 'commands') {
        var cmds = M.commands();
        ctx.say('插件指令：' + Object.keys(cmds).map(function (k) { return '/' + k; }).join('、'));
      } else if (sub === 'api') {
        ctx.say('插件 API ' + M.api + '（' + M.version + '）');
      } else {
        ctx.say('用法：' + '/itlzmc [plugins|events|commands|api]');
      }
    },
  });

  P.addCommand('qmgive', {
    description: '给自己一件物品：/qmgive <key> [数量]',
    fn: function (ctx, args) {
      var key = args[0], n = parseInt(args[1] || '1', 10) || 1;
      if (!key) { ctx.say('用法：/qmgive <key> [数量]'); return; }
      ctx.say(P.give(key, n) ? '已给予 ' + key + ' ×' + n : '找不到物品：' + key);
    },
  });
});
