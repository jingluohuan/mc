#!/usr/bin/env python3.11
"""QIUMC 原生插件静态校验：语法 / 清单 / 安全 / API 白名单 / 插件包完整性。"""
import json, re, subprocess, sys, zipfile, pathlib, tempfile

ALLOWED_API = {
    'plugin', 'register', 'defineBlock', 'defineItem', 'addTexture', 'addTextureAt',
    'addShaped', 'addShapeless', 'addSmelting', 'addRecipe', 'addCommand',
    'on', 'once', 'off', 'emit', 'intercept', 'method', 'config', 'setConfig',
    'storage', 'game', 'player', 'world', 'give', 'message', 'log', 'warn',
    'list', 'plugins', 'hookStats', 'events', 'commands', 'toggle', 'addUrl',
    'addKey', 'key', 'bindKey', 'onKey', 'isKeyDown', 'keybinds', 'scanKeys',
}
META_REQUIRED = ['id', 'name', 'version']
BAD_PATTERNS = [
    (r'https?://(?!127\.0\.0\.1|localhost)', '含外部 URL'),
    (r'//cdn\.', '含 CDN 引用'),
    (r'\bfetch\s*\(\s*[\'"`]https?://', '含外部 fetch'),
    (r'\bTODO\b|\bPLACEHOLDER\b|__PNG__|<占位|placeholder', '含占位符/TODO'),
    (r'\bOpusMC\b|bilibili|哔哩哔哩', '含旧品牌/外部平台字样'),
]

def check_js(path, errors, warnings, info):
    r = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True)
    if r.returncode != 0:
        errors.append('JS 语法错误：' + (r.stderr or '').strip().splitlines()[:1].__str__())
        return
    src = path.read_text(encoding='utf-8', errors='ignore')
    if 'QIUMC.plugin(' not in src and 'QIUMC.Plugins.register(' not in src:
        errors.append('缺少 QIUMC.plugin(...) 清单声明')
    for key in META_REQUIRED:
        if not re.search(r'\b%s\s*:' % re.escape(key), src):
            errors.append('清单缺少必填字段 %s' % key)
    if 'capabilities' not in src:
        warnings.append('建议声明 capabilities')
    for pat, msg in BAD_PATTERNS:
        if re.search(pat, src, re.I):
            errors.append(msg)
    for m in re.finditer(r'\bP\.([A-Za-z_][A-Za-z0-9_]*)\s*\(', src):
        name = m.group(1)
        if name not in ALLOWED_API:
            warnings.append('未知插件 API：P.%s（请核对 references/API.md）' % name)
    info['bytes'] = path.stat().st_size
    info['plugin_calls'] = src.count('QIUMC.plugin(') + src.count('QIUMC.Plugins.register(')
    info['hooks'] = len(re.findall(r"\bP\.on\s*\(", src))
    info['commands'] = len(re.findall(r'\bP\.addCommand\s*\(', src))
    info['keybinds'] = len(re.findall(r'\bP\.(?:addKey|key|bindKey|onKey)\s*\(', src))
    # 跨端按键：直接监听物理键盘的插件手机端会失效，给明确告警（不判失败，兼容老插件）
    clean = re.sub(r'/\*[\s\S]*?\*/', '', src)
    clean = re.sub(r'(^|[^:])//.*$', r'\1', clean, flags=re.M)
    if re.search(r"addEventListener\s*\(\s*['\"]key(?:down|up)|onkeydown\s*=", clean) and not info['keybinds']:
        warnings.append('直接监听了 keydown/keyup：手机端没有物理键盘会失效。'
                        '改用 P.addKey(id, { code, label, onDown, mode })，按住状态用 P.isKeyDown(id)'
                        '（见 references/KEYS.md）')
    if info['keybinds']:
        codes = re.findall(r"\bcode\s*:\s*['\"]([A-Za-z0-9]+)['\"]", src)
        for c in codes:
            if not re.match(r'^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|F(?:[1-9]|1[0-2])|Backquote|Space|Tab|Enter|Escape|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|Bracket(?:Left|Right)|Semicolon|Quote|Backslash|Comma|Period|Slash|Minus|Equal|Arrow(?:Up|Down|Left|Right)|Mouse[0-2])$', c):
                warnings.append('按键 code 不常见：%s（应为 KeyboardEvent.code，如 Backquote / KeyV / F6）' % c)

def check_pack(path, errors, warnings, info):
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            bad = z.testzip()
            if bad:
                errors.append('zip 内文件损坏：' + bad)
            info['entries'] = len(names)
            manifests = [n for n in names if re.search(r'(^|/)plugin\.json$', n, re.I)]
            info['manifests'] = manifests
            if not manifests:
                warnings.append('包内没有 plugin.json（QIUMC 只认这一种清单）')
            pj = [n for n in names if n.lower().endswith('plugin.json')]
            if pj:
                try:
                    meta = json.loads(z.read(pj[0]))
                    for key in META_REQUIRED:
                        if key not in meta:
                            errors.append('plugin.json 缺少 %s' % key)
                    info['plugin_id'] = meta.get('id')
                    if meta.get('main') and meta['main'] not in names and not any(n.endswith('/' + meta['main']) for n in names):
                        errors.append('plugin.json 的 main 指向的文件不存在：' + meta['main'])
                except Exception as e:
                    errors.append('plugin.json 无法解析：' + str(e))
            # 包内 JS 也做语法检查
            for n in names:
                if n.lower().endswith('.js'):
                    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as tmp:
                        tmp.write(z.read(n).decode('utf-8', 'ignore'))
                        tp = pathlib.Path(tmp.name)
                    r = subprocess.run(['node', '--check', str(tp)], capture_output=True, text=True)
                    if r.returncode != 0:
                        errors.append('包内 %s 语法错误' % n)
                    tp.unlink(missing_ok=True)
            info['textures'] = sum(1 for n in names if n.lower().endswith('.png'))
    except Exception as e:
        errors.append('无法读取包：' + str(e))

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'ok': False, 'errors': ['用法：validate_plugin.py <插件.js|.zip> [更多文件…]']}, ensure_ascii=False, indent=2))
        return 2
    errors, warnings, results = [], [], []
    for arg in sys.argv[1:]:
        p = pathlib.Path(arg)
        info = {'file': str(p)}
        if not p.exists():
            errors.append('文件不存在：' + str(p))
            continue
        if p.suffix.lower() == '.js':
            check_js(p, errors, warnings, info)
        elif p.suffix.lower() == '.zip':
            check_pack(p, errors, warnings, info)
        else:
            errors.append('不支持的文件类型：' + p.suffix)
        results.append(info)
    report = {'ok': not errors, 'api': '1.0', 'results': results,
              'errors': errors, 'warnings': warnings}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if not errors else 1

if __name__ == '__main__':
    sys.exit(main())
