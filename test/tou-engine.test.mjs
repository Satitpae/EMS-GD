import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseTou, analyzeTou} from '../web/tou-engine.mjs';

const slot = (day, hour = 0, minute = 0) => (day - 1) * 96 + hour * 4 + minute / 15;

// Independent oracle: a constant 10 kW load adds exactly 2.5 kWh each quarter hour.
function constantMeter({year = 2026, month = 9, days = 30} = {}) {
  const bytes = new Uint8Array(64 + (days * 96 + 1) * 16);
  bytes.set(new TextEncoder().encode('TOUReg\0\0'));
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 64, true);
  bytes.set(new TextEncoder().encode('01/10/202600:00:00'), 10);
  for (let i = 0; i <= days * 96; i++) {
    view.setFloat64(64 + i * 16, 10, true);
    view.setFloat64(72 + i * 16, 100000 + i * 2.5, true);
  }
  const monthName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1];
  return {bytes, view, filename: `ORACLE_${monthName}${String(year).slice(-2)}.tou`};
}

const parse = fixture => parseTou(fixture.bytes.buffer, fixture.filename);
const clear = (fixture, index) => {
  fixture.view.setFloat64(64 + index * 16, 0, true);
  fixture.view.setFloat64(72 + index * 16, 0, true);
};
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} ≠ ${expected}`);

test('browser parser exposes nominal meter times and retains next-month closing reading', () => {
  const data = parse(constantMeter());
  assert.equal(data.meter, 'ORACLE');
  assert.equal(data.period, '2026-09');
  assert.equal(data.rows.length, 2880);
  assert.equal(data.allRows.length, 2881);
  assert.equal(data.outside, 1);
  assert.deepEqual([data.rows[0].date, data.rows[0].time, data.rows[1].demand, data.rows[1].energy], ['2026-09-01', '00:00', 10, 100002.5]);
  assert.equal(data.allRows.at(-1).date, '2026-10-01');
  assert.equal(data.rows[0].missing, false);
});

test('independent 10 kW September oracle matches all published TOU totals', () => {
  const report = analyzeTou(parse(constantMeter()));
  assert.deepEqual(report.energy, {offpeak: 2417.5, onpeak: 2860, holiday: 1920, total: 7197.5});
  assert.equal(report.days[0].offpeak, 107.5);
  assert.equal(report.days[1].offpeak, 110);
  assert.equal(report.days[0].onpeak, 130);
  assert.equal(report.days[4].holiday, 240);
  assert.equal(report.peakDemand, 10);
  assert.equal(report.peakAt, '2026-09-01 00:00');
  assert.equal(report.validDays, 30);
  assert.equal(report.incompleteDays, 0);
  assert.equal(report.missingReadings, 0);
});

test('demand includes shared 09:00, 22:00, and next-midnight boundaries', () => {
  const fixture = constantMeter();
  fixture.view.setFloat64(64 + slot(1, 9) * 16, 100, true);
  fixture.view.setFloat64(64 + slot(1, 22) * 16, 200, true);
  fixture.view.setFloat64(64 + slot(2) * 16, 300, true);
  const report = analyzeTou(parse(fixture));
  assert.equal(report.days[0].peakOff, 300);
  assert.equal(report.days[0].peakOn, 200);
  assert.equal(report.peakAt, '2026-09-02 00:00');
});

test('interior gaps preserve energy while switching gaps move the shared split backwards', () => {
  const fixture = constantMeter();
  clear(fixture, slot(8, 12, 15));
  clear(fixture, slot(9, 8, 45));
  clear(fixture, slot(9, 9));
  clear(fixture, slot(10, 22));
  const report = analyzeTou(parse(fixture));
  assert.equal(report.days[7].total, 240);
  assert.equal(report.days[7].status, 'gaps');
  assert.equal(report.days[8].status, 'boundary-fallback');
  assert.equal(report.days[8].offpeak, 105);
  assert.equal(report.days[8].onpeak, 135);
  assert.match(report.days[8].issues.join(' '), /08:30/);
  assert.equal(report.days[9].offpeak, 112.5);
  assert.equal(report.days[9].onpeak, 127.5);
  assert.equal(report.missingReadings, 4);
});

test('missing midnight invalidates both neighboring days and never falls back', () => {
  const fixture = constantMeter();
  clear(fixture, slot(15));
  const report = analyzeTou(parse(fixture));
  for (const index of [13, 14]) {
    assert.equal(report.days[index].total, null);
    assert.equal(report.days[index].offpeak, null);
    assert.equal(report.days[index].onpeak, 130);
    assert.equal(report.days[index].status, 'incomplete');
  }
  assert.equal(report.missingReadings, 1);
});

test('a counter reset invalidates its segment even when the register later recovers', () => {
  const fixture = constantMeter();
  fixture.view.setFloat64(72 + slot(18, 14, 30) * 16, 200, true);
  const day = analyzeTou(parse(fixture)).days[17];
  assert.equal(day.offpeak, 110);
  assert.equal(day.onpeak, null);
  assert.equal(day.total, null);
  assert.equal(day.status, 'incomplete');
  assert.match(day.issues.join(' '), /decreased/);
});

test('last valid endpoint produces a partial final day and future no-data days', () => {
  const fixture = constantMeter();
  for (let index = slot(26, 15, 15); index <= 30 * 96; index++) clear(fixture, index);
  const report = analyzeTou(parse(fixture));
  const partial = report.days[25];
  assert.equal(partial.status, 'partial');
  assert.equal(partial.endAt, '15:00');
  assert.equal(partial.total, 150);
  assert.equal(partial.holiday, 150);
  assert.equal(report.days[26].status, 'no-data');
  assert.equal(report.days[26].total, null);
  assert.equal(report.days[26].offpeak, 0);
  assert.equal(report.days[27].offpeak, null);
  assert.equal(report.days[27].onpeak, null);
});

test('date filters preserve calendar-first-day policy and filter raw rows exactly once', () => {
  const data = parse(constantMeter());
  const report = analyzeTou(data, {from: '2026-09-02', to: '2026-09-02'});
  assert.equal(report.days.length, 1);
  assert.equal(report.energy.total, 240);
  assert.equal(report.energy.offpeak, 110);
  assert.equal(report.rows.length, 96);
  assert.equal(report.validDays, 1);
  const empty = analyzeTou(data, {from: '2026-10-01'});
  assert.equal(empty.days.length, 0);
  assert.equal(empty.energy.total, null);
  assert.equal(empty.peakDemand, null);
  assert.throws(() => analyzeTou(data, {from: '2026-09-20', to: '2026-09-02'}), /date|range/i);
});

test('2026 PEA public holidays are classified; unknown years are visible', () => {
  const may = analyzeTou(parse(constantMeter({month: 5, days: 31})));
  assert.equal(may.days[0].isHoliday, true);
  assert.equal(may.days[0].holiday, 237.5);
  const unknown = analyzeTou(parse(constantMeter({year: 2027})));
  assert.equal(unknown.calendarKnown, false);
});

test('parser rejects malformed binary framing, header dates, names, and non-finite values', () => {
  assert.throws(() => parseTou(new ArrayBuffer(8), 'ORACLE_Sep26.tou'), /TOU|header/i);
  const badHeader = constantMeter();
  badHeader.view.setUint16(8, 32, true);
  assert.throws(() => parse(badHeader), /header/i);
  const badDate = constantMeter();
  badDate.bytes.set(new TextEncoder().encode('31/02/202600:00:00'), 10);
  assert.throws(() => parse(badDate), /date/i);
  const badValue = constantMeter();
  badValue.view.setFloat64(64, NaN, true);
  assert.throws(() => parse(badValue), /row 1/i);
  assert.throws(() => parseTou(constantMeter().bytes.buffer, 'unknown.tou'), /filename/i);
  assert.throws(() => parseTou(constantMeter().bytes.buffer.slice(0, -1), 'ORACLE_Sep26.tou'), /record|row|length/i);
});

test('all four generated samples match independently saved dashboard daily reports', async () => {
  for (const meter of ['REFERENCE', 'OFFICE', 'FACTORY', 'ISSUES']) {
    const name = `SIM_${meter}_Sep26.tou`;
    const bytes = await readFile(new URL(`../examples/tou/${name}`, import.meta.url));
    const report = analyzeTou(parseTou(bytes, name));
    const csv = await readFile(new URL(`../examples/tou/SIM_${meter}_Sep26_dashboard_daily.csv`, import.meta.url), 'utf8');
    const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1, -1);
    assert.equal(report.days.length, lines.length);
    for (let index = 0; index < lines.length; index++) {
      const columns = lines[index].slice(1, -1).split('","');
      const day = report.days[index];
      assert.equal(day.date, columns[1]);
      for (const [key, column] of Object.entries({offpeak: 2, onpeak: 3, holiday: 4, total: 5, peakOff: 6, peakOn: 7, peakHoliday: 8})) {
        if (columns[column] === '') assert.equal(day[key], null, `${meter} ${day.date} ${key}`);
        else closeTo(day[key], Number(columns[column]));
      }
    }
    if (meter === 'ISSUES') {
      assert.equal(report.incompleteDays, 11);
      assert.equal(report.missingReadings, 426);
      closeTo(report.energy.offpeak, 3434.2975);
      closeTo(report.energy.onpeak, 11971.11425);
      closeTo(report.energy.holiday, 1807.27325);
      closeTo(report.energy.total, 15682.44025);
    }
  }
});
