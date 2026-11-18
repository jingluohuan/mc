#!/usr/bin/env python3.11
# -*- coding: utf-8 -*-
"""
QIUMC 插件医生（静态版）：AI「改着改着插件就失效了」时，先跑这个定位原因。

与浏览器里 QIUMC.Plugins.doctorText() / 服务端 /api/plugins/validate 用同一套规则，
额外检查跨端按键写法。输出可以直接粘给 AI 让它照着修。

用法：
  python3.11 doctor.py my-plugin.js [更多插件…]
  python3.11 doctor.py /path/to/plugins/            # 传目录则扫描目录下所有 .js
"""
import json
import pathlib
import re
import sys

BANNED = [
    (r'https?://', '引用了外部网址', '贴图请用 data:image/png;base64 内嵌，不要写 http(s) 链接'),
    (r'\b(fetch|XMLHttpRequest|WebSocket|eval|require|importScripts|document\.write|localStorage\.clear)\s*\(',
     '用了被禁止的 API（网络 / 动态执行 / 清空存储）', '配置用 P.storage，日志用 P.log，贴图用 data:image'),
    (r'\bQIUMC\s*\.\s*Mods\b|\bForge\b|\bFabric\b|mods\.toml|fabric\.mod\.json|mcmod\.info|\.jar\b',
     '用了已删除的 Mod / 模组命名空间', 'QIUMC 只加载原生插件，注册入口是 QIUMC.plugin(...)'),
    (r'__PNG__|\bTODO\b|\bFIXME\b|placeholder',
     '源码里还有占位符 / TODO', '把模板里的 __PNG__ 换成真实 data:image，删掉 TODO'),
]
META_KEYS = [('id', 'meta.id 必填且全局唯一'), ('name', 'meta.name 必填'),
             ('version', 'meta.version 必填（如 1.0.0）'), ('api', 'meta.api 必填，写 "1.0"')]


def strip_comments(s):
    s = re.sub(r'/\*[\s\S]*?\*/', '', s)
    return re.sub(r'(^|[^:])//.*$', r'\1', s, flags=re.M)


def diagnose(src):
    clean = strip_comments(src)
    errors, warnings, hints = [], [], []
    add = lambda e, h='': (errors.append(e), hints.append(h) if h else None)

    if not src.strip():
        add('源码是空的', '把完整插件源码写进文件，不要只保存 meta 或片段')
        return {'ok': False, 'errors': errors, 'warnings': warnings, 'hints': hints}
    if not re.search(r'QIUMC\s*\.\s*(plugin|register)\s*\(', src):
        add('没有调用 QIUMC.plugin(meta, factory)',
            '所有注册必须包在 QIUMC.plugin({ id, name, version, api }, function (P) { ... }) 里')
    if re.search(r'^await\s', clean, re.M):
        add('顶层 await 不支持', '插件是普通脚本；把异步逻辑放进同步 factory 或 P.on(...) 回调')
    head = (re.search(r'QIUMC\s*\.\s*(?:plugin|register)\s*\(([\s\S]{0,700})', src) or [None, ''])[1] or ''
    if re.search(r',\s*async\b', head):
        add('factory 是 async 函数，注册不会执行',
            '改成同步 factory：function (P) { ... }；QIUMC 不 await 返回值')
    for pat, why, fix in BANNED:
        if re.search(pat, clean, re.I):
            add(why, fix)
    if re.search(r'QIUMC\s*\.\s*plugin\s*\(', src):
        for k, why in META_KEYS:
            if not re.search(r'\b%s\s*:' % k, src):
                add('meta 缺字段 ' + k, why)
    if len(src) > 64 * 1024:
        warnings.append('源码超过 64 KB，市场提交会被拒')

    # 是否注册了任何能力（纯 meta 插件等于没效果）
    registered = {
        'hooks': len(re.findall(r'\bP\.(?:on|once)\s*\(', clean)),
        'commands': len(re.findall(r'\bP\.addCommand\s*\(', clean)),
        'textures': len(re.findall(r'\bP\.addTexture(?:At)?\s*\(', clean)),
        'blocks': len(re.findall(r'\bP\.define(?:Block|Item)\s*\(', clean)),
        'recipes': len(re.findall(r'\bP\.add(?:Shaped|Shapeless|Smelting|Recipe)\s*\(', clean)),
        'keybinds': len(re.findall(r'\bP\.(?:addKey|key|bindKey|onKey)\s*\(', clean)),
    }
    if not any(registered.values()):
        warnings.append('没有注册任何东西（指令 / 钩子 / 贴图 / 方块 / 配方 / 按键都没有），等于没有效果；服务端会拒绝上架')

    # 跨端按键：直接监听 keydown 的插件在手机端必然失效
    if (re.search(r"addEventListener\s*\(\s*['\"]key(?:down|up)|onkeydown\s*=", clean)
            and not registered['keybinds']):
        warnings.append('直接监听了 keydown/keyup，手机端没有物理键盘会失效（客户端会自动检测并生成按钮，但这是兜底）')
        hints.append("改用 P.addKey('veinMine', { code:'Backquote', label:'连锁挖矿', mode:'hold', onDown: fn })；"
                     "按住状态用 P.isKeyDown('veinMine') 读取，详见 references/KEYS.md")
    if registered['keybinds']:
        hints.append('按键声明已识别；手机端会自动生成屏幕按钮，确认 label 是玩家看得懂的中文')

    return {'ok': not errors and not warnings, 'errors': errors,
            'warnings': warnings, 'hints': [h for h in hints if h], 'registered': registered}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'ok': False, 'errors': ['用法：doctor.py <插件.js|目录> [更多…]']},
                         ensure_ascii=False, indent=2))
        return 2
    files = []
    for arg in sys.argv[1:]:
        p = pathlib.Path(arg)
        if p.is_dir():
            files += sorted(p.rglob('*.js'))
        elif p.exists():
            files.append(p)
        else:
            print('文件不存在：' + arg)
    if not files:
        return 2
    report, all_ok = [], True
    for p in files:
        src = p.read_text(encoding='utf-8', errors='ignore')
        d = diagnose(src)
        d['file'] = str(p)
        report.append(d)
        all_ok = all_ok and d['ok']
    print(json.dumps({'ok': all_ok, 'total': len(report),
                      'failed': sum(1 for d in report if not d['ok']), 'plugins': report},
                     ensure_ascii=False, indent=2))
    if not all_ok:
        print('\n=== 给 AI 的修复提示（照着改） ===')
        for d in report:
            if d['ok']:
                continue
            print('\n' + d['file'])
            for e in d['errors']:
                print('  ✗ ' + e)
            for w in d['warnings']:
                print('  ⚠ ' + w)
            for h in d['hints']:
                print('  → ' + h)
    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main())
