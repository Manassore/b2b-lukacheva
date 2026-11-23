const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('server/Code.gs', 'utf8');
const stringify = value => JSON.parse(JSON.stringify(value));
const token = 'test-only-'.repeat(5);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture() {
  const data = new Map();
  const master = new Map();
  const db = {
    getSheetByName(name) { return sheet(data.get(name)); }
  };
  const masterDb = {
    getSheetByName(name) { return sheet(master.get(name)); }
  };
  const sandbox = vm.createContext({
    Date, Logger: { log() {} },
    SpreadsheetApp: { openById: id => id === 'ВСТАВИТЬ_MASTER_ID' ? masterDb : db },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_, value) => [...Buffer.from(hash(value), 'hex')],
      formatDate: (value, timeZone) => value.toLocaleDateString('sv-SE', { timeZone })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json', JAVASCRIPT: 'js' },
      createTextOutput: content => ({ setMimeType: () => JSON.parse(content) })
    }
  });
  vm.runInContext(source, sandbox);
  const cols = vm.runInContext('RECORD_COLS', sandbox);
  data.set('Клиенты', [['client_id', 'master_id'], ['C006', 'M006'], ['C009', 'M009']]);
  data.set('Сотрудники', [['user_id', 'name', 'role', 'token_hash', 'active'],
    ['U1', 'Приёмка', 'OFFICE', hash(token), true],
    ['U2', 'Курьер', 'COURIER', hash(token + 'courier'), true]]);
  data.set('Поступления', [Array.from(cols)]);
  data.set('Операции', [['op_id', 'record_id', 'op_type', 'actor_id', 'device_at', 'server_at', 'payload_json', 'result', 'error']]);
  data.set('Номенклатура', [['service_code', 'name', 'unit', 'active'], ['S1', 'Фартук', 'шт', true]]);
  data.set('Тарифы', [['client_id', 'service_code', 'active', 'price_rub'], ['C009', 'S1', true, 100]]);
  data.set('Позиции', [['line_id']]);
  master.set('Клиенты', [
    ['Код клиента', 'Клиент', 'Вид сотрудничества', 'Статус', 'Способ расчёта', 'Канал учёта поступлений', 'Краткое название'],
    ['M006', 'СПА Орешек', 'B2B', 'Активный', 'За кг', '', 'Орешек'],
    ['M009', 'Владис', 'Спецодежда', 'Активный', 'Поштучно', 'Приложение', 'Владис'],
    ['M010', 'Прочие', 'B2B', 'Активный', 'За кг', 'Quick Resto', 'Прочие'],
    ['M011', 'Договор', 'Договорное обслуживание', 'Активный', 'За кг', '', 'Договор'],
    ['M012', 'Исключён', 'B2B', 'Активный', 'За кг', 'Не учитывать', 'Исключён'],
    ['M013', 'Архив', 'B2B', 'Неактивный', 'За кг', '', 'Архив'],
    ['M014', 'Новый', 'B2B', 'Активный', 'За кг', '', '']
  ]);
  master.set('Объекты', [
    ['ID объекта', 'Код клиента', 'Краткое название', 'Адрес', 'Активен'],
    ['OBJ-A', 'M006', 'Самарская', 'Самарская, 165', true],
    ['OBJ-B', 'M006', 'Солнечная', 'Солнечная, 20', true],
    ['OBJ-C', 'M009', 'Склад', 'Складская, 1', true],
    ['OBJ-D', 'M010', 'Другое', 'Другая, 2', true]
  ]);
  function get(action, params = {}, auth = token) {
    return stringify(sandbox.doGet({ parameter: { action, token: auth, ...params } }));
  }
  function post(...ops) {
    assert.equal(sandbox.doPost({ parameter: { payload: JSON.stringify({ token, ops }) } }).ok, true);
    return get('status', { ids: ops.map(op => op.opId).join(',') }).ops.map(op => op.status);
  }
  return { master, data, cols, get, post };
}

function sheet(data) {
  if (!data) return null;
  const width = () => Math.max(...data.map(row => row.length));
  function getRange(start, column, height, length) {
    return {
      getValues() {
        return Array.from({ length: height }, (_, i) => (
          Array.from({ length }, (_, j) => data[start - 1 + i]?.[column - 1 + j] ?? '')
        ));
      },
      setValues(rows) {
        rows.forEach((row, i) => row.forEach((value, j) => {
          data[start - 1 + i][column - 1 + j] = value;
        }));
      }
    };
  }
  return {
    getDataRange: () => getRange(1, 1, data.length, width()),
    getLastRow: () => data.length,
    getLastColumn: width,
    getRange,
    appendRow(row) { data.push(Array.from(row)); }
  };
}

function op(yearDay, properties = {}) {
  return {
    opId: crypto.randomUUID(), recordId: crypto.randomUUID(), type: 'DIRECT',
    at: '2026-01-' + yearDay + 'T21:00:00Z',
    data: { clientId: 'C006', objectId: 'OBJ-A', bags: 3, weight: 12.3, ...properties }
  };
}

test('bootstrap retains legacy IDs; excludes Quick Resto, contract service and inactive clients', () => {
  const app = fixture();
  const result = app.get('bootstrap');
  assert.equal(result.apiVersion, 4);
  assert.deepEqual(result.clients.map(c => c.id).sort(), ['C006', 'C009', 'M014']);
  const client = result.clients.find(c => c.id === 'C006');
  assert.equal(client.shortName, 'Орешек');
  assert.equal(client.name, 'СПА Орешек');
  assert.deepEqual(client.objects.map(o => o.id), ['OBJ-A', 'OBJ-B']);
  assert.deepEqual(app.get('version'), { ok: true, apiVersion: 4 });
});

test('separate receipts, idempotent retries, Samara dates, legacy rows and totals', () => {
  const app = fixture();
  const records = app.data.get('Поступления');
  const old = [...app.cols].slice(0, 24).map(
    column => ({ record_id: 'old-record', client_id: 'M006', client_name: 'СПА Орешек',
      status: 'WEIGHED', weight_kg: 2.5, account_date: '2026-01-03' }[column] ?? '')
  );
  records.push(old);
  const pending = [...app.cols].map(column => ({ record_id: 'unweighed-duplicate', client_id: 'C006',
    status: 'DISCREPANCY', discrepancy: true, weight_kg: 80, account_date: '2026-01-03' }[column] ?? ''));
  records.push(pending);
  const first = op('02');
  const second = op('02', { objectId: 'OBJ-B', weight: 10.2 });
  const third = op('02', { weight: 0.1 });
  const next = op('03', { objectId: 'OBJ-B', weight: 9.1 });
  const pieces = op('03', { clientId: 'C009', objectId: 'OBJ-C', items: [{ code: 'S1', qty: 7 }] });
  const v12 = op('02', { objectId: undefined, weight: 1.3 });
  assert.deepEqual(app.post(first, second, third, next, pieces, v12, first), Array(7).fill('APPLIED'));
  assert.equal(records.length, 9);
  assert.equal(new Set(records.slice(1).map(r => r[0])).size, 8);
  assert.equal(records[1], old);
  assert.equal(old.length, 24);
  assert.deepEqual(records.slice(3, 7).map(r => [r[1], r[12], r[24]]), [
    ['C006', '2026-01-03', 'OBJ-A'], ['C006', '2026-01-03', 'OBJ-B'],
    ['C006', '2026-01-03', 'OBJ-A'], ['C006', '2026-01-04', 'OBJ-B']
  ]);
  assert.equal(records.at(-1)[24], '');
  records.push(records[3].slice());
  const partial = records[3].slice();
  partial[0] = 'partial-receipt';
  partial[21] = 'pending-operation';
  records.push(partial);
  app.data.get('Операции').push(['pending-operation', 'partial-receipt', 'DIRECT', 'U1', '', '', '', 'PENDING']);
  const summary = app.get('summary', { from: '2026-01-01', to: '2026-01-04' });
  assert.equal(summary.ok, true);
  const client = summary.clients.find(c => c.id === 'C006');
  assert.equal(client.receipts, 6);
  assert.equal(client.weightKg, 35.5);
  assert.deepEqual(Object.fromEntries(client.objects.map(o => [o.id, o.weightKg])), {
    'OBJ-A': 12.4, 'OBJ-B': 19.3, '': 3.8
  });
  assert.equal(summary.clients.find(c => c.id === 'C009').items, 7);
  assert.equal(app.data.get('Позиции').length, 2);
  assert.equal(app.get('summary', { from: '2026-01-04', to: '2026-01-04' })
    .clients.find(c => c.id === 'C006').weightKg, 9.1);
});

test('objects are updated, while pending offline receipts can still reference an inactive object', () => {
  const app = fixture(), objects = app.master.get('Объекты');
  const pending = op('02', { objectId: 'OBJ-B' });
  objects[2][4] = false;
  app.master.get('Клиенты')[1][6] = 'Орешек СПА';
  let client = app.get('bootstrap').clients.find(c => c.id === 'C006');
  assert.equal(client.shortName, 'Орешек СПА');
  assert.deepEqual(client.objects.map(o => o.id), ['OBJ-A']);
  assert.deepEqual(app.post(pending, op('02', { objectId: 'OBJ-C' }), op('02', { objectId: 'missing' })),
    ['APPLIED', 'REJECTED', 'REJECTED']);
  assert.equal(app.data.get('Поступления').at(-1)[24], 'OBJ-B');
  objects[2][4] = true;
  objects.push(['OBJ-E', 'M014', 'Склад', 'Новая, 7', true]);
  const updated = app.get('bootstrap').clients;
  client = updated.find(c => c.id === 'C006');
  assert.deepEqual(client.objects.map(o => o.id), ['OBJ-A', 'OBJ-B']);
  assert.deepEqual(updated.find(c => c.id === 'M014').objects.map(o => o.id), ['OBJ-E']);
});

test('reports honor existing roles and version is unavailable before the journal migration', () => {
  const app = fixture();
  assert.equal(app.get('summary', { from: '2026-01-01', to: '2026-01-31' }, token + 'courier').ok, false);
  assert.equal(app.get('summary', { from: '2026-02-30', to: '2026-03-01' }).ok, false);
  app.data.get('Поступления')[0].splice(24);
  assert.equal(app.get('version').ok, false);
  assert.equal(app.get('bootstrap').ok, false);
});
