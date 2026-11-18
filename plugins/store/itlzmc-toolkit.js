ITLZMC.plugin({
  id: 'itlzmc-toolkit', name: '插件工具箱', version: '1.0.0',
  description: '插件状态查询与给物品指令', api: '1.0', capabilities: ['command'],
}, function (P) {
  P.addCommand('itlzmc', {
    description: 'ITLZMC 插件系统状态',
    usage: '/itlzmc [plugins|events|commands|api]', aliases: ['qi'],
    fn: function (ctx, args) {
      var M = ITLZMC.Plugins, sub = (args[0] || 'plugins').toLowerCase();
      if (sub === 'plugins') {
        var names = M.list().map(function (r) { return r.name + (r.error ? '（失败）' : ''); });
        ctx.say('已加载 ' + names.length + ' 个插件：' + names.join('、'));
      } else if (sub === 'events') ctx.say('已挂载机制钩子：' + M.hookStats().join('、'));
      else if (sub === 'commands') ctx.say('插件指令：' + Object.keys(M.commands()).map(function (k) { return '/' + k; }).join('、'));
      else if (sub === 'api') ctx.say('插件 API ' + M.api + '（' + M.version + '）');
      else ctx.say('用法：/itlzmc [plugins|events|commands|api]');
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
