"""Run with python3 tests/mobile.py and Chromium plus Python Playwright installed."""

import copy
import functools
import http.server
import json
import os
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ENDPOINT = 'https://script.google.com/macros/s/test-deployment/exec'
TOKEN = 'fake-token-' * 5


class QuietServer(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def main():
    directory = {
        'ok': True, 'apiVersion': 4, 'user': {'name': 'Приёмка', 'role': 'OFFICE'},
        'serverTime': '2026-01-02T12:00:00Z', 'records': [],
        'clients': [
            {'id': 'C006', 'shortName': 'Орешек', 'name': 'СПА Орешек', 'accountType': 'WEIGHT',
             'objects': [
                 {'id': 'OBJ-A', 'name': 'Самарская', 'address': 'Самарская, 165'},
                 {'id': 'OBJ-B', 'name': 'Солнечная', 'address': 'Солнечная, 20'}
             ]},
            {'id': 'C009', 'shortName': 'Владис', 'name': 'Владис', 'accountType': 'PIECE',
             'objects': [{'id': 'OBJ-C', 'name': 'Склад', 'address': 'Складская, 1'}]},
            {'id': 'C011', 'shortName': 'Орлова', 'name': 'Орлова Юлия', 'accountType': 'WEIGHT'},
            {'id': 'C023', 'shortName': 'Обережка', 'name': 'Обережка', 'accountType': 'WEIGHT'},
        ],
        'services': [{'clientId': 'C009', 'code': 'S1', 'name': 'Фартук', 'unit': 'шт'}]
    }
    all_objects = copy.deepcopy(directory['clients'][0]['objects'])
    submitted = {}
    posts = []
    browser_errors = []
    old_api_checks = []

    def respond(route):
        request = route.request
        query = parse_qs(urlparse(request.url).query)
        if request.method == 'POST':
            op = json.loads(parse_qs(request.post_data)['payload'][0])['ops'][0]
            posts.append(op)
            submitted[op['opId']] = op
            route.fulfill(status=200, body='{}')
            return
        action = query['action'][0]
        if action == 'bootstrap':
            body = directory
        elif action == 'version':
            if directory['apiVersion'] < 4:
                old_api_checks.append(action)
                body = {'ok': False, 'error': 'Неизвестное действие'}
            else:
                body = {'ok': True, 'apiVersion': 4}
        elif action == 'status':
            body = {'ok': True, 'ops': [
                {'id': op_id, 'status': 'APPLIED' if op_id in submitted else 'NOT_FOUND'}
                for op_id in query['ids']
            ]}
        elif action == 'summary':
            body = {'ok': True, 'clients': [{
                'name': 'Орешек', 'weightKg': 15.2, 'items': 0, 'receipts': 2,
                'objects': [{'name': 'Самарская', 'weightKg': 15.2, 'items': 0, 'receipts': 2}]
            }]}
        else:
            raise AssertionError(action)
        route.fulfill(content_type='application/javascript',
                      body=query['callback'][0] + '(' + json.dumps(body) + ');')

    handler = functools.partial(QuietServer, directory=ROOT)
    with http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler) as server, sync_playwright() as playwright:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = 'http://127.0.0.1:' + str(server.server_port) + '/'
        chromium = playwright.chromium.launch(executable_path=os.getenv('CHROMIUM', '/usr/bin/chromium'))
        context = chromium.new_context(**playwright.devices['Pixel 7'])
        context.route(ENDPOINT + '**', respond)
        page = context.new_page()
        page.on('pageerror', lambda error: browser_errors.append(str(error)))
        page.goto(url)
        page.locator('#endpoint').fill(ENDPOINT)
        page.locator('#token').fill(TOKEN)
        page.locator('#saveSetup').click()
        search = page.get_by_role('combobox', name='Клиент или объект')
        options = page.get_by_role('option')
        expect(search).to_be_visible()
        expect(search).to_have_value('')
        expect(page.locator('#officeSubmit')).to_be_disabled()
        search.fill('о')
        expect(options).to_have_count(4)
        search.fill('ОРЕ')
        expect(search).to_be_focused()
        expect(options).to_have_count(2)
        search.fill('165')
        expect(options).to_have_count(1)
        expect(options.first).to_contain_text('Орешек · Самарская')
        search.fill('лнеч')
        expect(options).to_have_count(1)
        search.press('ArrowDown')
        search.press('Enter')
        expect(search).to_have_value('Орешек · Солнечная')
        page.locator('#officeWeight').fill('8,2')

        directory['clients'][0]['shortName'] = 'СПА Орешек'
        page.locator('#refreshClientsBtn').click()
        expect(search).to_have_value('СПА Орешек · Солнечная')
        expect(page.locator('#officeWeight')).to_have_value('8,2')
        directory['clients'][0]['objects'].pop()
        page.locator('#refreshClientsBtn').click()
        expect(search).to_have_value('')
        expect(page.locator('#officeSubmit')).to_be_disabled()
        search.fill('Самарская')
        expect(options.first).to_have_text('СПА Орешек')
        options.first.tap()
        expect(page.locator('#officeWeight')).to_have_value('8,2')
        directory['clients'][0]['objects'] = copy.deepcopy(all_objects)
        page.locator('#refreshClientsBtn').click()
        expect(search).to_have_value('СПА Орешек · Самарская')

        page.evaluate('navigator.serviceWorker.ready')
        context.set_offline(True)
        page.locator('#officeSubmit').tap()
        expect(page.locator('#queueCount')).to_have_text('Очередь: 1')
        expect(search).to_have_value('')
        assert not posts
        page.reload()
        expect(search).to_be_visible()
        expect(page.locator('#queueCount')).to_have_text('Очередь: 1')
        search.fill('кладская')
        expect(options.first).to_have_text('Владис')
        options.first.tap()
        pieces = page.get_by_role('spinbutton', name='Количество: Фартук')
        pieces.fill('3')
        page.locator('#officeSubmit').tap()
        expect(page.locator('#queueCount')).to_have_text('Очередь: 2')
        assert not posts

        directory['apiVersion'] = 3
        context.set_offline(False)
        page.wait_for_function("document.querySelector('#syncBtn').disabled === false")
        page.locator('#refreshClientsBtn').click()
        expect(page.locator('#apiCompatibility')).to_be_visible()
        page.locator('#syncBtn').click()
        expect(page.locator('#message')).to_contain_text('Не отправлено')
        expect(page.locator('#queueCount')).to_have_text('Очередь: 2')
        assert old_api_checks and not posts
        directory['apiVersion'] = 4
        directory['clients'][0]['objects'].pop(0)
        page.locator('#syncBtn').click()
        expect(page.locator('#queueCount')).to_have_text('Очередь: 0')
        assert [(o['data']['clientId'], o['data']['objectId']) for o in submitted.values()] == [
            ('C006', 'OBJ-A'), ('C009', 'OBJ-C')
        ]
        assert len({o['recordId'] for o in submitted.values()}) == 2
        assert next(iter(submitted.values()))['data']['weight'] == 8.2
        assert list(submitted.values())[-1]['data']['items'] == [{'code': 'S1', 'qty': 3}]

        page.locator('#officeReport summary').click()
        page.get_by_role('button', name='Показать сводку').click()
        expect(page.locator('#reportResults')).to_contain_text('Самарская')
        expect(page.locator('#reportResults')).to_contain_text('15,2 кг')
        assert not browser_errors, browser_errors
        chromium.close()
        server.shutdown()
    print('PASS — мобильный Chrome: поиск, объекты, черновик, офлайн-перезапуск, очередь, API gate, сводка')


if __name__ == '__main__':
    main()
