ITLZMC.plugin({
  id: 'itlzmc-ui-coords', name: 'UI 坐标提示', version: '1.2.0',
  description: '一条 /uicoords 指令，演示 AI 通过 API 提交并自动上架', api: '1.0',
  capabilities: ['command', 'mechanic'],
}, function (P) {
  P.addCommand('uicoords', {
    description: '显示当前坐标', usage: '/uicoords',
    fn: function (ctx) { ctx.say('坐标：/uicoords'); },
  });
  P.on('tick', function (c) { /* 机制钩子 */ });
});