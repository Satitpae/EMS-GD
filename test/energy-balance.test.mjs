import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTou} from '../web/tou-engine.mjs';
import {analyzeBalance} from '../web/energy-balance.mjs';

const QUARTER = 15 * 60 * 1000;
const slot = (day, hour = 0, minute = 0) => (day - 1) * 96 + hour * 4 + minute / 15;
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);
let meterNumber = 0;

// Independently constructed cumulative meters: every 15 minutes adds kW / 4.
function meter(kw, {name = `METER_${++meterNumber}`, year = 2026, month = 9, count} = {}) {
  const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const records = count ?? monthDays * 96 + 1;
  const bytes = new Uint8Array(64 + records * 16);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('TOUReg\0\0'));
  view.setUint16(8, 64, true);
  bytes.set(new TextEncoder().encode('01/10/202600:00:00'), 10);
  for (let i = 0; i < records; i++) {
    view.setFloat64(64 + i * 16, kw, true);
    view.setFloat64(72 + i * 16, 1000 + i * kw / 4, true);
  }
  const monthName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1];
  return parseTou(bytes, `${name}_${monthName}${String(year).slice(-2)}.tou`);
}

function missing(data, index) {
  data.allRows[index].energy = 0;
  data.allRows[index].demand = 0;
  data.allRows[index].missing = true;
}

test('independent 10 kW grid plus 5 kW solar September oracle adds both energies', () => {
  const report = analyzeBalance(meter(10, {name: 'MEA'}), meter(5, {name: 'SOLAR'}));
  assert.equal(report.period, '2026-09');
  assert.equal(report.gridMeter, 'MEA');
  assert.equal(report.solarMeter, 'SOLAR');
  assert.equal(report.totals.gridKwh, 7197.5);
  assert.equal(report.totals.solarKwh, 3598.75);
  assert.equal(report.totals.loadKwh, 10796.25);
  closeTo(report.totals.solarSharePct, 100 / 3);
  assert.equal(report.totals.gridPeakKw, 10);
  assert.equal(report.totals.solarPeakKw, 5);
  assert.equal(report.totals.loadPeakKw, 15);
  assert.equal(report.totals.peakAt, '2026-09-01 00:00');
  assert.equal(report.totals.expectedIntervals, 2879);
  assert.equal(report.totals.validIntervals, 2879);
  assert.equal(report.totals.completeDays, 30);
  assert.equal(report.totals.incompleteDays, 0);
  assert.equal(report.coveragePct, 100);
  assert.equal(report.days[0].expectedIntervals, 95);
  assert.equal(report.days[0].gridKwh, 237.5);
  assert.equal(report.days[0].solarKwh, 118.75);
  assert.equal(report.days[1].gridKwh, 240);
  assert.equal(report.rows.length, 2880);
  assert.deepEqual(report.rows[0], {
    date: '2026-09-01', time: '00:00', ts: Date.UTC(2026, 8, 1),
    gridKw: 10, solarKw: 5, loadKw: 15, valid: true
  });
});

test('timestamp alignment preserves simultaneous demand and never adds unrelated peaks', () => {
  const grid = meter(10);
  const solar = meter(5);
  grid.allRows[slot(3, 9)].demand = 80;
  solar.allRows[slot(3, 12)].demand = 90;
  // Deliberately reorder one source. Record positions are not timestamps.
  solar.allRows.reverse();
  const report = analyzeBalance(grid, solar, {from: '2026-09-03', to: '2026-09-03'});
  assert.equal(report.totals.gridKwh, 240);
  assert.equal(report.totals.solarKwh, 120);
  assert.equal(report.totals.gridPeakKw, 80);
  assert.equal(report.totals.solarPeakKw, 90);
  assert.equal(report.totals.loadPeakKw, 100);
  assert.equal(report.totals.peakAt, '2026-09-03 12:00');
});

test('a missing endpoint removes both adjacent intervals from both energy totals', () => {
  const grid = meter(10);
  const solar = meter(5);
  missing(solar, slot(8, 12, 15));
  const report = analyzeBalance(grid, solar, {from: '2026-09-08', to: '2026-09-08'});
  assert.equal(report.totals.gridKwh, 235);
  assert.equal(report.totals.solarKwh, 117.5);
  assert.equal(report.totals.loadKwh, 352.5);
  assert.equal(report.totals.validIntervals, 94);
  closeTo(report.coveragePct, 94 / 96 * 100);
  assert.equal(report.days[0].status, 'incomplete');
  const row = report.rows.find(row => row.time === '12:15');
  assert.equal(row.gridKw, 10);
  assert.equal(row.solarKw, null);
  assert.equal(row.loadKw, null);
  assert.equal(row.valid, false);
});

test('absent timestamps cannot be bridged or filled as zero', () => {
  const grid = meter(10);
  const solar = meter(5);
  const index = slot(10, 6);
  solar.allRows = solar.allRows.filter(row => row.index !== index);
  const report = analyzeBalance(grid, solar, {from: '2026-09-10', to: '2026-09-10'});
  assert.equal(report.totals.validIntervals, 94);
  assert.equal(report.totals.loadKwh, 352.5);
  assert.equal(report.rows.find(row => row.time === '06:00').loadKw, null);
});

test('counter resets reject the decreasing interval without inventing export', () => {
  const grid = meter(10);
  const solar = meter(5);
  const reset = slot(18, 14, 30);
  for (const row of solar.allRows.slice(reset)) row.energy -= 900;
  const report = analyzeBalance(grid, solar, {from: '2026-09-18', to: '2026-09-18'});
  assert.equal(report.totals.validIntervals, 95);
  assert.equal(report.totals.gridKwh, 237.5);
  assert.equal(report.totals.solarKwh, 118.75);
  assert.equal(report.days[0].status, 'incomplete');
});

test('zero nighttime solar demand with a positive register is a valid reading', () => {
  const grid = meter(10);
  const solar = meter(0);
  const report = analyzeBalance(grid, solar);
  assert.equal(report.totals.solarKwh, 0);
  assert.equal(report.totals.loadKwh, 7197.5);
  assert.equal(report.totals.solarSharePct, 0);
  assert.equal(report.totals.solarPeakKw, 0);
  assert.equal(report.coveragePct, 100);
  assert.equal(report.rows[0].valid, true);
});

test('closing midnight belongs to the preceding energy day', () => {
  const grid = meter(10);
  const solar = meter(5);
  const closing = slot(15);
  for (const row of solar.allRows.slice(closing)) row.energy += 10;
  const previous = analyzeBalance(grid, solar, {from: '2026-09-14', to: '2026-09-14'});
  const next = analyzeBalance(grid, solar, {from: '2026-09-15', to: '2026-09-15'});
  assert.equal(previous.totals.solarKwh, 130);
  assert.equal(next.totals.solarKwh, 120);
  missing(solar, closing);
  assert.equal(analyzeBalance(grid, solar, {from: '2026-09-14', to: '2026-09-14'}).totals.validIntervals, 95);
  assert.equal(analyzeBalance(grid, solar, {from: '2026-09-15', to: '2026-09-15'}).totals.validIntervals, 95);
});

test('partial files keep all expected calendar days and unknown totals stay null', () => {
  const report = analyzeBalance(meter(10), meter(5, {count: 4}));
  assert.equal(report.days.length, 30);
  assert.equal(report.totals.gridKwh, 5);
  assert.equal(report.totals.solarKwh, 2.5);
  assert.equal(report.totals.loadKwh, 7.5);
  assert.equal(report.totals.validIntervals, 2);
  assert.equal(report.days[0].status, 'incomplete');
  assert.equal(report.days[1].status, 'no-data');
  assert.equal(report.days[1].gridKwh, null);
  assert.equal(report.days[1].solarKwh, null);
  assert.equal(report.days[1].loadKwh, null);
  assert.equal(report.days[1].solarSharePct, null);
  assert.equal(report.totals.incompleteDays, 30);
  assert.equal(report.totals.completeDays, 0);
});

test('no paired intervals produce unknown energy, while real zero load has no share', () => {
  const unknown = analyzeBalance(meter(10), meter(5, {count: 0}));
  assert.equal(unknown.totals.gridKwh, null);
  assert.equal(unknown.totals.solarKwh, null);
  assert.equal(unknown.totals.loadKwh, null);
  assert.equal(unknown.totals.solarSharePct, null);
  assert.equal(unknown.totals.loadPeakKw, null);
  assert.equal(unknown.totals.peakAt, null);
  assert.equal(unknown.coveragePct, 0);
  assert.ok(unknown.days.every(day => day.status === 'no-data'));
  const zero = analyzeBalance(meter(0), meter(0));
  assert.equal(zero.totals.loadKwh, 0);
  assert.equal(zero.totals.solarSharePct, null);
  assert.equal(zero.coveragePct, 100);
});

test('date filters retain the month baseline and cannot shift energy across months', () => {
  const grid = meter(10);
  const solar = meter(5);
  const first = analyzeBalance(grid, solar, {from: '2026-09-01', to: '2026-09-01'});
  const second = analyzeBalance(grid, solar, {from: '2026-09-02', to: '2026-09-02'});
  assert.equal(first.totals.expectedIntervals, 95);
  assert.equal(second.totals.expectedIntervals, 96);
  assert.equal(second.totals.gridKwh, 240);
  assert.equal(second.rows.length, 96);
  const outside = analyzeBalance(grid, solar, {from: '2026-10-01'});
  assert.deepEqual(outside.days, []);
  assert.deepEqual(outside.rows, []);
  assert.equal(outside.totals.loadKwh, null);
  assert.equal(outside.totals.expectedIntervals, 0);
  assert.equal(outside.coveragePct, null);
  const last = analyzeBalance(grid, solar, {from: '2026-09-30'});
  assert.equal(last.totals.loadKwh, 360);
  assert.throws(() => analyzeBalance(grid, meter(5, {month: 10})), /period|month/i);
  assert.throws(() => analyzeBalance(grid, {...solar, meter: grid.meter}), /same|distinct|different|meter/i);
  assert.throws(() => analyzeBalance(grid, solar, {from: '2026-09-20', to: '2026-09-01'}), /range|start|date/i);
  assert.throws(() => analyzeBalance(grid, solar, {from: '2026-02-30'}), /date/i);
  assert.throws(() => analyzeBalance(grid, solar, {to: '09/30/2026'}), /date/i);
});

test('a shifted timestamp does not become the neighboring quarter by row index', () => {
  const grid = meter(10);
  const solar = meter(5);
  solar.allRows[slot(6, 8)].ts += QUARTER / 2;
  const report = analyzeBalance(grid, solar, {from: '2026-09-06', to: '2026-09-06'});
  assert.equal(report.totals.validIntervals, 94);
  assert.equal(report.rows.find(row => row.time === '08:00').loadKw, null);
});
