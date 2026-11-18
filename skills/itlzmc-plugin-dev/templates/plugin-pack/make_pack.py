#!/usr/bin/env python3.11
"""从 assets.js 导出一份 QIUMC 原生插件包模板（含图集空位贴图）。"""
import base64, io, json, re, sys, zipfile
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
s = open(src, encoding='utf-8').read()
m = re.search(r'"tiles":\s*\{(.*?)\}\s*,\s*"', s, re.S)
pairs = [(k, int(v)) for k, v in re.findall(r'"([^"]+)":\s*(\d+)', m.group(1))]
strip = re.search(r'"strip":"data:image/png;base64,([^"]+)"', s).group(1)
im = Image.open(io.BytesIO(base64.b64decode(strip))).convert('RGBA')
cols = 64
named = {idx for _, idx in pairs}
max_idx = max(named)

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.writestr('plugin.json', json.dumps({
        'id': 'qiumc-texture-pack', 'name': 'QIUMC 贴图插件包', 'version': '1.0.0',
        'description': '从游戏图集导出的原生插件包模板，改 PNG 后重新打包即可生效',
        'api': '1.0', 'capabilities': ['texture'],
    }, ensure_ascii=False, indent=2))
    z.writestr('README.txt', '改 PNG 后重新打包，放进 plugins/ 或用 ?plugin=<路径> 加载即可生效。\n')
    for name, idx in pairs:
        x, y = (idx % cols) * 16, (idx // cols) * 16
        if y + 16 > im.size[1]:
            continue
        b = io.BytesIO(); im.crop((x, y, x + 16, y + 16)).save(b, format='PNG')
        folder = 'item' if name.startswith('i_') else 'block'
        z.writestr('assets/minecraft/textures/%s/%s.png' % (folder, name), b.getvalue())
    holes = 0
    for idx in range(max_idx + 1):
        if idx in named:
            continue
        x, y = (idx % cols) * 16, (idx // cols) * 16
        if y + 16 > im.size[1]:
            break
        b = io.BytesIO(); im.crop((x, y, x + 16, y + 16)).save(b, format='PNG')
        z.writestr('assets/qiumc/atlas/%d.png' % idx, b.getvalue())
        holes += 1
print('已生成', out, '命名贴图', len(pairs), '空位', holes)
