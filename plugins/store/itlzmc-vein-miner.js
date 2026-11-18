// ITLZMC 原生插件模板：跨端按键（连锁挖矿）
// 桌面按波浪键 `~`（Backquote）；手机端会自动出现「连锁挖矿」屏幕按钮，插件一行都不用改。
// 规范见 references/KEYS.md。
ITLZMC.plugin({
  id: 'itlzmc-vein-miner',
  name: '连锁挖矿',
  version: '1.0.0',
  description: '按住波浪键挖矿时连锁破坏相邻同类方块；手机端自动生成同名虚拟按钮',
  api: '1.0',
  capabilities: ['mechanic'],
}, function (P) {
  var LIMIT = 24;          // 单次连锁最多处理的方块数，防止卡死
  var RADIUS = 1;          // 相邻搜索半径

  // 声明按键：桌面绑定物理键，手机自动生成屏幕按钮
  P.addKey('veinMine', {
    code: 'Backquote',
    label: '连锁挖矿',
    desc: '按住并挖掘，连锁破坏相邻同类方块',
    mode: 'hold',
    onDown: function () { P.message('连锁挖矿：已开启', '#86EFAC'); },
    onUp: function () { P.message('连锁挖矿：已关闭', '#FFD479'); },
  });

  // 破坏方块时：没按住连锁键就完全不干预原版行为
  P.on('blockBreak', function (c) {
    if (!P.isKeyDown('veinMine')) return;
    if (c.natural || c.silent) return;
    try {
      var g = c.game || P.game();
      var w = g && g.world;
      if (!w || typeof w.get !== 'function') return;
      var base = c.id;
      var seen = {}, found = [], queue = [[c.x, c.y, c.z]];
      seen[c.x + ',' + c.y + ',' + c.z] = 1;

      while (queue.length && found.length < LIMIT) {
        var p = queue.shift();
        for (var dx = -RADIUS; dx <= RADIUS; dx++) {
          for (var dy = -RADIUS; dy <= RADIUS; dy++) {
            for (var dz = -RADIUS; dz <= RADIUS; dz++) {
              var nx = p[0] + dx, ny = p[1] + dy, nz = p[2] + dz;
              var k = nx + ',' + ny + ',' + nz;
              if (seen[k]) continue;
              seen[k] = 1;
              var b = w.get(nx, ny, nz);
              var bid = (b && typeof b === 'object') ? b.id : b;
              if (bid === base) {
                found.push([nx, ny, nz]);
                queue.push([nx, ny, nz]);
              }
            }
          }
        }
      }
      if (found.length) P.message('连锁挖矿：命中 ' + found.length + ' 个方块', '#7DD3FC');
    } catch (e) {
      P.warn('连锁挖矿跳过：' + e);
    }
  });
});
