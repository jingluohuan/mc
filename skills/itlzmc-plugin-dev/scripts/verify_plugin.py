#!/usr/bin/env python3.11
"""用真实浏览器（Playwright + Xvfb/WebGL2）验收插件是否加载生效。

用法：
  python3.11 verify_plugin.py --url http://127.0.0.1:8092/ --plugin plugins/examples/xxx.js
可与项目自带 diag/verify 脚本配合做更深入的像素/机制验证。
"""
import argparse, json, sys
from playwright.sync_api import sync_playwright

ARGS = [
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ozone-platform=x11', '--enable-webgl', '--ignore-gpu-blocklist',
]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:8092/')
    ap.add_argument('--plugin', action='append', default=[])
    ap.add_argument('--sharecode', default='')
    a = ap.parse_args()

    url = a.url
    sep = '&' if '?' in url else '?'
    parts = []
    for p in a.plugin:
        parts.append('plugin=' + p)
    if a.sharecode:
        parts.append('sharecode=' + a.sharecode)
    if parts:
        url += sep + '&'.join(parts)

    errs, failed, external = [], [], []
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=ARGS)
        pg = b.new_page(viewport={'width': 1280, 'height': 800})
        pg.on('console', lambda m: errs.append(m.text[:200]) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)[:200]))
        pg.on('requestfailed', lambda r: failed.append(r.url[:200]))
        pg.on('request', lambda r: external.append(r.url[:160])
              if r.url.startswith('http') and a.url.split('/')[2] not in r.url else None)
        pg.goto(url, wait_until='load', timeout=90000)
        try:
            pg.wait_for_function("() => window.QIUMC && window.QIUMC.Plugins && window.QIUMC.Plugins.list", timeout=30000)
        except Exception:
            pass
        pg.wait_for_timeout(2500)
        out = pg.evaluate("""() => {
          const M = window.QIUMC && window.QIUMC.Plugins;
          if (!M) return { api: null };
          return {
            api: M.api, version: M.version,
            hooks: M.hookStats(),
            plugins: M.plugins().map(p => p.manifest),
            records: M.list().map(r => ({ id:r.id, name:r.name, kind:r.kind,
              error:r.error, caps:r.capabilities, hooks:r.hooks,
              commands:r.commands, blocks:r.blocks, textures:r.textures,
              metaSource:r.metaSource })),
            commands: Object.keys(M.commands()),
            game: window.game ? window.game.state : null,
            boot: (() => { const b=document.getElementById('boot'); return b ? getComputedStyle(b).display : 'none'; })(),
          };
        }""")
        out['consoleErrors'] = errs[:12]
        out['failedRequests'] = failed[:12]
        out['externalRequests'] = external[:12]
        out['url'] = url
        print(json.dumps(out, ensure_ascii=False, indent=2))
        b.close()
    ok = (out.get('api') == '1.0'
          and not any(r.get('error') for r in out.get('records', []))
          and not out['consoleErrors'] and not out['failedRequests'])
    return 0 if ok else 1

if __name__ == '__main__':
    sys.exit(main())
