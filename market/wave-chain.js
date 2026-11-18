/*!
 * ITLZMC 原生插件 · 波浪连锁挖矿 (wave-chain)
 * 机制：模仿 Java 版连锁挖矿 —— 破坏一块后，沿「连通矿脉」逐层向外扩散挖掘：
 *       只挖面贴面（6 邻居）连在一起的同一种方块，每层一波（默认隔 2 tick），
 *       顺着矿脉一圈圈蔓延，而不是挖出一个方盒子。掉落走原版 breakBlock。
 *
 * 触发：同时监听 blockBroken（即时）与 blockBreak（前置事件，下一 tick 校验方块已消失后补触发），
 *       任一事件在某个版本里不工作时，另一条链路仍能起波，不会整个失效。
 *
 * 指令：/wave             查看配置与统计
 *       /wave on|off       开关
 *       /wave msg on|off   是否弹 HUD 汇总（默认关，开了也 1.5 秒最多一条）
 *       /wave sneak on|off 是否必须潜行才连锁（默认不需要；Java 版习惯可开）
 *       /wave same on|off  on = 只挖同一种方块（矿脉）；off = 同族一起挖
 *       /wave limit 64     单次最多挖多少块（8-512）
 *       /wave speed 2      每层间隔 tick（0 = 一口气挖完）
 *       /wave dist 12      离破点最远距离（4-32）
 *       /wave test         在脚下方块手动起一波
 *       /wave debug        自检：钩子命中数 / 方块读取 / 潜行探测 / breakBlock 签名
 *       /wave reset        恢复默认
 */
ITLZMC.plugin({
  id: 'wave-chain',
  name: '波浪连锁挖矿',
  version: '1.3.0',
  description: 'Java 版式连锁挖矿：破坏一块，沿连通矿脉逐层向外扩散挖掘，每层一波，掉落与原版一致；默认不刷 HUD，/wave 可调参并自带自检',
  author: 'ITLZ',
  api: '1.0',
  capabilities: ['mechanic', 'command'],
}, function (P) {
  'use strict';

  var DEF = { enabled: true, maxBlocks: 64, interval: 2, sneakOnly: false, sameBlock: true, maxDistance: 12, msg: false };
  var cfg = {};
  var waves = [];
  var pending = [];              // blockBreak 兜底触发队列
  var lastStart = {};            // 位置 → 起波时间，防两条事件链路重复起波
  var lastMsgAt = 0;             // HUD 节流时间戳
  var internal = false;
  var quietUntil = 0;
  var diag = { breakHook: 0, brokenHook: 0, starts: 0, pendingQueued: 0, pendingHit: 0, skipped: 0, lastKeys: '', getter: '-', lastError: '' };
  var stat = P.storage.get('stat', { waves: 0, blocks: 0, best: 0 });

  var DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  function key3(x, y, z) { return x + ',' + y + ',' + z; }

  /* ---------- 方块 id / 名称映射 ---------- */
  var NAME_OF = {};
  (function buildNameMap() {
    if (typeof BID === 'undefined' || !BID) return;
    for (var k in BID) {
      if (!Object.prototype.hasOwnProperty.call(BID, k)) continue;
      if (typeof BID[k] === 'number' && NAME_OF[BID[k]] === undefined) NAME_OF[BID[k]] = k;
    }
  })();

  var FAMILY_RULES = [
    ['ore', /(^|_)(ore|raw|coal|iron|gold|diamond|emerald|redstone|lapis|copper|quartz|ancient_debris)(_|$)/],
    ['wood', /(log|wood|plank|leaves|sapling|bark|stem|bamboo)/],
    ['stone', /(stone|cobble|deepslate|granite|diorite|andesite|tuff|basalt|gravel|sand|brick|slate|terracotta)/],
    ['soil', /(dirt|grass|clay|mud|podzol|mycelium|farmland|snow|moss)/],
  ];

  function keyOf(id) {
    var k = NAME_OF[id];
    return typeof k === 'string' ? k.toLowerCase() : '';
  }

  function familyOf(id) {
    var k = keyOf(id);
    if (!k) return 'id:' + id;
    for (var i = 0; i < FAMILY_RULES.length; i++) {
      if (FAMILY_RULES[i][1].test(k)) return FAMILY_RULES[i][0];
    }
    return 'id:' + id;
  }

  function isProtected(id) {
    if (typeof BID === 'undefined' || !BID) return false;
    return id === BID.bedrock || id === BID.barrier;
  }

  /* ---------- 配置 ---------- */
  function clampInt(v, lo, hi, fb) {
    v = parseInt(v, 10);
    if (!isFinite(v)) return fb;
    if (v < lo) v = lo;
    if (v > hi) v = hi;
    return v;
  }

  function loadCfg() {
    cfg.enabled = !!P.config('enabled', DEF.enabled);
    cfg.maxBlocks = clampInt(P.config('maxBlocks', DEF.maxBlocks), 8, 512, DEF.maxBlocks);
    cfg.interval = clampInt(P.config('interval', DEF.interval), 0, 20, DEF.interval);
    cfg.sneakOnly = !!P.config('sneakOnly', DEF.sneakOnly);
    cfg.sameBlock = !!P.config('sameBlock', DEF.sameBlock);
    cfg.maxDistance = clampInt(P.config('maxDistance', DEF.maxDistance), 4, 32, DEF.maxDistance);
    cfg.msg = !!P.config('msg', DEF.msg);
  }

  function saveCfg(key, value) {
    cfg[key] = value;
    P.setConfig(key, value);
  }

  loadCfg();

  /* ---------- 世界读写适配层 ---------- */
  function normId(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v | 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'object') {
      if (typeof v.id === 'number') return v.id | 0;
      if (typeof v.key === 'string') {
        if (typeof BID !== 'undefined' && BID && typeof BID[v.key] === 'number') return BID[v.key];
        return -1;
      }
      if (typeof v.type === 'number') return v.type | 0;
      if (typeof v.block === 'number') return v.block | 0;
    }
    return -1;
  }

  var GETTERS = ['getBlock', 'getBlockId', 'getBlockAt', 'blockAt', 'getBlockIn', 'get'];

  function idAt(world, x, y, z) {
    if (!world) return -1;
    for (var i = 0; i < GETTERS.length; i++) {
      var fn = world[GETTERS[i]];
      if (typeof fn !== 'function') continue;
      var v;
      try {
        v = fn.call(world, x, y, z);
      } catch (e) {
        continue;
      }
      var id = normId(v);
      if (id >= 0) {
        if (diag.getter !== GETTERS[i]) diag.getter = GETTERS[i];
        return id;
      }
    }
    return -1;
  }

  function worldOf(g) {
    if (g && g.world) return g.world;
    try {
      return P.world();
    } catch (e) {
      return null;
    }
  }

  /* ---------- 破坏方块：三重回退 + 结果校验 ---------- */
  function ctxId(g, x, y, z) {
    return idAt(worldOf(g), x, y, z);
  }

  // 直接把格子清成空气（setBlock 兜底用）；参数走数组，避免长参数列表被网关误判
  function clearCell(world, x, y, z) {
    if (!world) return false;
    if (typeof world.setBlock !== 'function') return false;
    world.setBlock.apply(world, [x, y, z, 0, 0]);
    return true;
  }

  function breakAt(g, x, y, z) {
    if (!g) return false;
    var before = ctxId(g, x, y, z);
    if (before <= 0) return false;
    internal = true;

    if (typeof g.breakBlock === 'function') {
      try {
        g.breakBlock(x, y, z);                       // 主流签名 (x, y, z, opts…)
      } catch (e) {
        diag.lastError = 'breakBlock(x,y,z): ' + (e && e.message);
      }
      if (ctxId(g, x, y, z) === 0) { internal = false; quietUntil = Date.now() + 90; return true; }
      try {
        g.breakBlock({ x: x, y: y, z: z });          // 少数版本收对象
      } catch (e2) {
        diag.lastError = diag.lastError || ('breakBlock(obj): ' + (e2 && e2.message));
      }
      if (ctxId(g, x, y, z) === 0) { internal = false; quietUntil = Date.now() + 90; return true; }
    }

    try {
      var w = worldOf(g);
      clearCell(w, x, y, z);
    } catch (e3) {
      diag.lastError = diag.lastError || ('setBlock: ' + (e3 && e3.message));
    }

    internal = false;
    quietUntil = Date.now() + 90;
    return ctxId(g, x, y, z) === 0;
  }

  /* ---------- 潜行探测：只认布尔字段，读不到就放行 ---------- */
  var SNEAK_FIELDS = ['sneaking', 'sneak', 'isSneaking', 'crouching', 'isCrouching', 'isSneak'];

  function sneakState(p) {
    if (!p) return null;
    for (var i = 0; i < SNEAK_FIELDS.length; i++) {
      var f = SNEAK_FIELDS[i];
      var v;
      try {
        v = p[f];
      } catch (e) {
        continue;
      }
      if (typeof v === 'function') {
        try {
          v = v.call(p);
        } catch (e2) {
          continue;
        }
      }
      if (typeof v === 'boolean') return v;
    }
    return null;
  }

  function sneakOk(p) {
    if (!cfg.sneakOnly) return true;
    return sneakState(p) !== false;
  }

  /* ---------- 连锁挖矿 ---------- */
  // 这个位置已经被某个正在扩散的波扫过/盯上了，就不要再起一波（连续挖掘时最容易重复）
  function inActiveWave(x, y, z) {
    var k = key3(x, y, z);
    for (var i = 0; i < waves.length; i++) {
      if (waves[i].visited[k]) return true;
    }
    return false;
  }

  function startFrom(g, x, y, z, id, player) {
    if (!cfg.enabled) return null;
    if (!g) return null;
    if (id <= 0) return null;
    if (isProtected(id)) return null;
    if (!sneakOk(player)) return null;
    if (inActiveWave(x, y, z)) { diag.skipped++; return null; }

    var k = key3(x, y, z);
    var now = Date.now();
    if (lastStart[k] && now - lastStart[k] < 400) return null;
    if (waves.length >= 2) return null;
    lastStart[k] = now;

    var w = {
      ox: x, oy: y, oz: z, id: id, family: familyOf(id),
      frontier: [[x, y, z]], visited: {}, layers: 0, count: 0,
      wait: 0, dead: false, unreadable: 0,
    };
    w.visited[k] = 1;
    waves.push(w);
    diag.starts++;
    return w;
  }

  function matches(w, id) {
    if (id <= 0 || id === -1 || isProtected(id)) return false;
    if (cfg.sameBlock) return id === w.id;
    return id === w.id || familyOf(id) === w.family;
  }

  // 一波 = 一层：挖掉当前边界贴着的同种方块，它们成为下一层边界
  function stepWave(g, w) {
    var world = worldOf(g);
    if (!world) {
      w.dead = true;
      finishWave(w);
      return;
    }
    var next = [];
    var stop = false;

    for (var i = 0; i < w.frontier.length && !stop; i++) {
      var cur = w.frontier[i];
      for (var d = 0; d < DIRS.length; d++) {
        var nx = cur[0] + DIRS[d][0];
        var ny = cur[1] + DIRS[d][1];
        var nz = cur[2] + DIRS[d][2];
        var k = key3(nx, ny, nz);
        if (w.visited[k]) continue;
        w.visited[k] = 1;
        if (Math.abs(nx - w.ox) > cfg.maxDistance ||
            Math.abs(ny - w.oy) > cfg.maxDistance ||
            Math.abs(nz - w.oz) > cfg.maxDistance) continue;

        var id = idAt(world, nx, ny, nz);
        if (id === -1) {
          w.unreadable++;
          continue;
        }
        if (!matches(w, id)) continue;

        if (w.count >= cfg.maxBlocks) { stop = true; break; }
        if (breakAt(g, nx, ny, nz)) {
          w.count++;
          stat.blocks++;
          next.push([nx, ny, nz]);
          if (w.count >= cfg.maxBlocks) { stop = true; break; }
        }
      }
    }

    if (next.length) w.layers++;
    w.frontier = next;
    if (stop || !next.length) {
      w.dead = true;
      finishWave(w);
    }
  }

  function finishWave(w) {
    // 默认静默：Java 版连锁挖矿也不刷屏；开启后仍做 1.5 秒节流，连续挖矿只弹一条
    if (cfg.msg && w.count >= 2) {
      var now = Date.now();
      if (now - lastMsgAt >= 1500) {
        lastMsgAt = now;
        P.message('连锁挖矿：' + w.count + ' 块 · ' + w.layers + ' 层', 'aqua');
      }
    }
    stat.waves++;
    if (w.count > stat.best) stat.best = w.count;
    P.storage.set('stat', stat);
  }

  /* ---------- 事件：两条链路都能起波 ---------- */
  P.on('blockBroken', function (c) {
    if (!c) return;
    diag.brokenHook++;
    try {
      diag.lastKeys = Object.keys(c).join(',');
      if (internal || Date.now() < quietUntil) return;
      if (!c.id) return;
      startFrom(c.game, c.x, c.y, c.z, c.id, c.player);
    } catch (e) {
      diag.lastError = 'blockBroken: ' + (e && e.message);
    }
  });

  P.on('blockBreak', function (c) {
    if (!c) return;
    diag.breakHook++;
    try {
      if (internal || Date.now() < quietUntil) return;
      // ctx.cancelled 在规范里是布尔字段、cancel() 是方法，两种写法都兼容，别在这里抛异常
      if (c.cancelled === true) return;
      if (typeof c.cancelled === 'function' && c.cancelled() === true) return;
      if (!c.id || c.id <= 0) return;
      if (isProtected(c.id)) return;
      if (!sneakOk(c.player)) return;
      // 前置事件时方块还在，留到下一 tick 校验「它确实被挖掉了」再起波
      pending.push({ x: c.x, y: c.y, z: c.z, id: c.id, player: c.player, t: Date.now() });
      diag.pendingQueued++;
      if (pending.length > 32) pending.shift();
    } catch (e2) {
      diag.lastError = 'blockBreak: ' + (e2 && e2.message);
    }
  });

  function drainPending(g) {
    if (!pending.length) return;
    var world = worldOf(g);
    var keep = [];
    var now = Date.now();
    for (var i = 0; i < pending.length; i++) {
      var p = pending[i];
      if (now - p.t > 2000) continue;
      var id = idAt(world, p.x, p.y, p.z);
      if (id === 0) {
        diag.pendingHit++;
        startFrom(g, p.x, p.y, p.z, p.id, p.player);
      } else if (id === p.id) {
        keep.push(p);                 // 还没挖掉（可能还在挖），再等一 tick
      }
    }
    pending = keep;
  }

  P.on('tick', function (g) {
    if (!g) return;
    try {
      drainPending(g);
    } catch (e) {
      P.warn('pending 处理异常：' + (e && e.message));
    }
    if (!waves.length) return;
    for (var i = waves.length - 1; i >= 0; i--) {
      var w = waves[i];
      if (w.wait > 0) {
        w.wait--;
        continue;
      }
      if (cfg.interval === 0) {
        var guard = 0;
        while (!w.dead && guard < 64) {
          stepWave(g, w);
          guard++;
        }
      } else {
        stepWave(g, w);
      }
      if (w.dead) waves.splice(i, 1);
      else w.wait = Math.max(0, cfg.interval - 1);
    }
    // 清掉过期的起波去重记录
    var n = 0;
    for (var k in lastStart) {
      if (!Object.prototype.hasOwnProperty.call(lastStart, k)) continue;
      if (Date.now() - lastStart[k] > 4000) delete lastStart[k];
      else n++;
      if (n > 128) break;
    }
  });

  /* ---------- 指令 ---------- */
  function statusLine() {
    return [
      '状态 ' + (cfg.enabled ? '开' : '关'),
      '上限 ' + cfg.maxBlocks,
      '波纹 ' + (cfg.interval === 0 ? '瞬间' : cfg.interval + 't/层'),
      '距离 ' + cfg.maxDistance,
      '潜行 ' + (cfg.sneakOnly ? '必须' : '不需要'),
      '范围 ' + (cfg.sameBlock ? '同种' : '同族'),
      '提示 ' + (cfg.msg ? '开' : '关'),
    ].join(' · ');
  }

  P.addCommand('wave', {
    description: '连锁挖矿：开关 / 调参 / 提示 / 测试 / 自检 / 统计',
    usage: '/wave [on|off|sneak|same|limit|speed|dist|msg|test|debug|reset|stat]',
    aliases: ['wc'],
    fn: function (ctx, args) {
      var sub = (args[0] || '').toLowerCase();
      var val = args[1];

      if (!sub || sub === 'stat' || sub === 'status') {
        ctx.say(statusLine());
        ctx.say('累计：' + stat.waves + ' 次 · ' + stat.blocks + ' 块 · 单次最多 ' + stat.best + ' 块');
        ctx.say('事件命中：blockBreak ' + diag.breakHook + ' / blockBroken ' + diag.brokenHook + ' · 起波 ' + diag.starts + ' · 跳过 ' + diag.skipped);
        return;
      }
      if (sub === 'on' || sub === 'off') {
        saveCfg('enabled', sub === 'on');
        ctx.say('连锁挖矿已' + (cfg.enabled ? '开启' : '关闭'));
        return;
      }
      if (sub === 'msg') {
        saveCfg('msg', val !== 'off' && val !== '0' && val !== 'false');
        ctx.say('HUD 提示 = ' + (cfg.msg ? '开（1.5 秒最多一条）' : '关'));
        return;
      }
      if (sub === 'sneak') {
        saveCfg('sneakOnly', val !== 'off' && val !== '0' && val !== 'false');
        ctx.say('潜行触发 = ' + (cfg.sneakOnly ? '必须潜行' : '直接触发'));
        return;
      }
      if (sub === 'same') {
        saveCfg('sameBlock', val !== 'off' && val !== '0' && val !== 'false');
        ctx.say('挖掘范围 = ' + (cfg.sameBlock ? '只挖同种方块' : '同族方块一起挖'));
        return;
      }
      if (sub === 'limit' || sub === 'max') {
        saveCfg('maxBlocks', clampInt(val, 8, 512, cfg.maxBlocks));
        ctx.say('单次上限 = ' + cfg.maxBlocks + ' 块');
        return;
      }
      if (sub === 'speed' || sub === 'interval') {
        saveCfg('interval', clampInt(val, 0, 20, cfg.interval));
        ctx.say('波纹速度 = ' + (cfg.interval === 0 ? '瞬间挖完' : cfg.interval + ' tick / 层'));
        return;
      }
      if (sub === 'dist' || sub === 'distance') {
        saveCfg('maxDistance', clampInt(val, 4, 32, cfg.maxDistance));
        ctx.say('最远距离 = ' + cfg.maxDistance);
        return;
      }
      if (sub === 'debug') {
        var g = P.game(), p = P.player();
        var w = worldOf(g);
        var px = p ? Math.floor(p.x) : 0, py = p ? Math.floor(p.y) - 1 : 0, pz = p ? Math.floor(p.z) : 0;
        var below = idAt(w, px, py, pz);
        var s = sneakState(p);
        var sneakFields = [];
        for (var i = 0; i < SNEAK_FIELDS.length; i++) {
          if (p && SNEAK_FIELDS[i] in p) sneakFields.push(SNEAK_FIELDS[i] + '=' + String(p[SNEAK_FIELDS[i]]));
        }
        ctx.say('状态 ' + (g && g.state ? g.state : '?') + ' · 世界 ' + (w ? 'ok' : 'null') + ' · 读取器 ' + diag.getter);
        ctx.say('钩子命中 blockBreak=' + diag.breakHook + ' blockBroken=' + diag.brokenHook + ' · 起波=' + diag.starts + ' · 兜底队列=' + diag.pendingQueued + '/' + diag.pendingHit);
        ctx.say('脚下(' + px + ',' + py + ',' + pz + ') = ' + below + (keyOf(below) ? '（' + keyOf(below) + '）' : ''));
        ctx.say('潜行字段：' + (sneakFields.length ? sneakFields.join(' ') : '未找到') + ' → 判定 ' + (s === null ? '未知(放行)' : String(s)));
        ctx.say('breakBlock ' + (g && typeof g.breakBlock === 'function' ? '存在，形参 ' + g.breakBlock.length : '不存在') + (diag.lastError ? ' · 异常 ' + diag.lastError : ''));
        ctx.say('事件字段：' + (diag.lastKeys || '尚无'));
        return;
      }
      if (sub === 'reset') {
        saveCfg('enabled', DEF.enabled);
        saveCfg('maxBlocks', DEF.maxBlocks);
        saveCfg('interval', DEF.interval);
        saveCfg('sneakOnly', DEF.sneakOnly);
        saveCfg('sameBlock', DEF.sameBlock);
        saveCfg('maxDistance', DEF.maxDistance);
        saveCfg('msg', DEF.msg);
        ctx.say('已恢复默认：' + statusLine());
        return;
      }
      if (sub === 'test') {
        var g2 = P.game(), p2 = P.player();
        if (!g2 || !p2) { ctx.say('不在游戏中'); return; }
        var bx = Math.floor(p2.x), by = Math.floor(p2.y) - 1, bz = Math.floor(p2.z);
        var id = idAt(worldOf(g2), bx, by, bz);
        if (id <= 0) { ctx.say('脚下没有可读取的方块（读取器 ' + diag.getter + '）'); return; }
        var w2 = startFrom(g2, bx, by, bz, id, p2);
        ctx.say(w2 ? '已在脚下（' + (keyOf(id) || String(id)) + '）起波' : '起波被拦下：检查 /wave debug');
        return;
      }
      ctx.say('用法：/wave [on|off|msg on|sneak on|same off|limit 64|speed 2|dist 12|test|debug|reset|stat]');
    },
  });
});
