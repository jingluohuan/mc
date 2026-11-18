#!/usr/bin/env python3.11
# -*- coding: utf-8 -*-
"""
QIUMC 插件市场发布 CLI（零依赖，只用标准库）。

【关键】本站部署在分享网关后面，每个 API 请求的 URL 都必须带 ?sharecode=，
否则会被 403 拦截。本脚本自动给所有 URL 拼好 sharecode，不用手动加。

用法：
  python3.11 publish_plugin.py register --user mydev --pass secret123
  python3.11 publish_plugin.py login    --user mydev --pass secret123
  python3.11 publish_plugin.py docs
  python3.11 publish_plugin.py validate my-plugin.js
  python3.11 publish_plugin.py submit   my-plugin.js [--changelog "说明"]
  python3.11 publish_plugin.py mine
  python3.11 publish_plugin.py withdraw --id qiumc-vein-miner

可选全局参数（放在子命令前或后都行）：
  --base   站点根地址，默认 https://a23dc3393acb531d3.app.workbuddy.host
  --share  分享码，默认 4AK3QS2M26（用户给的线上地址不同就换成那个值）
  --key    直接指定 API Key（默认读 ~/.qiumc_market_key）
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = 'https://a23dc3393acb531d3.app.workbuddy.host'
DEFAULT_SHARE = '4AK3QS2M26'
KEY_FILE = os.path.expanduser('~/.qiumc_market_key')


def make_url(base, share, name):
    """拼出带 sharecode 的完整 API 地址——每个请求都要走这里。"""
    q = '?sharecode=' + urllib.parse.quote(str(share), safe='')
    return base.rstrip('/') + '/api/' + name.lstrip('/') + q


def request(url, method='GET', body=None, key=None, timeout=30):
    data = None
    headers = {'Accept': 'application/json'}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    if key:
        headers['X-QIUMC-Key'] = key
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode('utf-8', 'replace')
            status = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        status = e.code
    except Exception as e:
        return {'ok': False, '__network': True,
                'error': '请求失败：%s（确认 --base / --share 是否正确）' % e}
    try:
        out = json.loads(raw)
    except Exception:
        return {'ok': False, '__status': status,
                'error': '返回的不是 JSON（HTTP %s）。若 URL 漏了 sharecode 会被网关 403 拦截。'
                         % status, 'raw': raw[:300]}
    if isinstance(out, dict):
        out['__status'] = status
    return out


def load_key(cli_key):
    if cli_key:
        return cli_key
    try:
        d = json.loads(open(KEY_FILE, encoding='utf-8').read())
        return d.get('apiKey') or ''
    except Exception:
        return ''


def save_key(username, api_key):
    try:
        with open(KEY_FILE, 'w', encoding='utf-8') as f:
            json.dump({'username': username, 'apiKey': api_key}, f, ensure_ascii=False, indent=2)
        os.chmod(KEY_FILE, 0o600)
        print('Key 已保存到 ' + KEY_FILE)
    except Exception as e:
        print('（Key 没能写入文件，请手动保存：%s）' % e)


def show(title, out):
    print('\n=== %s ===' % title)
    print(json.dumps({k: v for k, v in out.items() if not k.startswith('__')},
                     ensure_ascii=False, indent=2)[:4000])
    if out.get('ok'):
        print('结果：成功')
    else:
        print('结果：失败  ' + str(out.get('error') or ''))
    if out.get('warnings'):
        for w in out['warnings']:
            print('  ⚠ ' + str(w))
    return bool(out.get('ok'))


def main():
    ap = argparse.ArgumentParser(description='QIUMC 插件市场发布（自动带 sharecode）')
    ap.add_argument('cmd', choices=['register', 'login', 'docs', 'validate', 'submit', 'mine', 'withdraw', 'market', 'key'])
    ap.add_argument('file', nargs='?', help='插件 .js 文件（validate / submit 用）')
    ap.add_argument('--user', default='')
    ap.add_argument('--pass', dest='password', default='')
    ap.add_argument('--id', default='')
    ap.add_argument('--changelog', default='')
    ap.add_argument('--base', default=os.environ.get('QIUMC_BASE', DEFAULT_BASE))
    ap.add_argument('--share', default=os.environ.get('QIUMC_SHARE', DEFAULT_SHARE))
    ap.add_argument('--key', default='')
    a = ap.parse_args()

    key = load_key(a.key)
    U = lambda name: make_url(a.base, a.share, name)
    print('站点：%s   sharecode：%s' % (a.base, a.share))
    print('提交地址：' + U('plugins/submit'))

    if a.cmd == 'docs':
        return 0 if show('API 文档', request(U('docs'))) else 1
    if a.cmd == 'market':
        return 0 if show('已上架插件', request(U('market'))) else 1
    if a.cmd == 'key':
        print('当前 Key：' + (key[:16] + '…' if key else '（没有，请先 register / login）'))
        return 0 if key else 1
    if a.cmd in ('register', 'login'):
        if not a.user or not a.password:
            print('需要 --user 和 --pass'); return 2
        out = request(U('auth/' + a.cmd),
                      'POST', {'username': a.user, 'password': a.password})
        ok = show('注册' if a.cmd == 'register' else '登录', out)
        if ok and out.get('apiKey'):
            save_key(out.get('username') or a.user, out['apiKey'])
            print('\n把这枚 Key 和上面「提交地址」一起交给 AI 即可（地址已带 sharecode）。')
        return 0 if ok else 1
    if a.cmd in ('validate', 'submit'):
        if not a.file:
            print('需要插件 .js 文件路径'); return 2
        try:
            code = open(a.file, encoding='utf-8').read()
        except Exception as e:
            print('读不到文件：%s' % e); return 2
        if a.cmd == 'validate':
            return 0 if show('自检（不上架）', request(U('plugins/validate'), 'POST', {'code': code})) else 1
        if not key:
            print('没有 API Key：先跑 register / login，或用 --key 指定'); return 2
        body = {'code': code}
        if a.changelog:
            body['changelog'] = a.changelog
        if a.id:
            body['id'] = a.id
        out = request(U('plugins/submit'), 'POST', body, key)
        ok = show('提交上架', out)
        if not ok and out.get('errors'):
            print('\n需要改的地方：')
            for e in out['errors']:
                print('  ✗ ' + str(e))
        return 0 if ok else 1
    if a.cmd == 'mine':
        if not key:
            print('没有 API Key：先跑 register / login'); return 2
        return 0 if show('我上架的插件', request(U('plugins/mine'), 'GET', None, key)) else 1
    if a.cmd == 'withdraw':
        if not key or not a.id:
            print('需要 --id 和 API Key'); return 2
        return 0 if show('下架', request(U('plugins/withdraw'), 'POST', {'id': a.id}, key)) else 1
    return 2


if __name__ == '__main__':
    sys.exit(main())
