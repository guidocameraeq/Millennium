'use strict';
// Pruebas de ci-verde.cjs, sin red: solo la lógica que decide.
const test = require('node:test');
const assert = require('node:assert');
const { veredicto, dueñoRepo, resumen, sinChecksVencido } = require('./ci-verde.cjs');

const run = (name, status, conclusion = null) => ({ name, status, conclusion });

test('veredicto: todo success/skipped/neutral y hay al menos uno → 0', () => {
  const v = veredicto([
    run('a', 'completed', 'success'),
    run('b', 'completed', 'skipped'),
    run('c', 'completed', 'neutral'),
  ]);
  assert.strictEqual(v.codigo, 0);
  assert.strictEqual(v.total, 3);
  assert.deepStrictEqual(v.fallados, []);
});

test('veredicto: un check fallado → 1 y lista su nombre', () => {
  const v = veredicto([run('ok', 'completed', 'success'), run('roto', 'completed', 'failure')]);
  assert.strictEqual(v.codigo, 1);
  assert.deepStrictEqual(v.fallados, ['roto']);
});

test('veredicto: cancelled, timed_out y action_required también cuentan como fallo', () => {
  for (const c of ['cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
    const v = veredicto([run('x', 'completed', c)]);
    assert.strictEqual(v.codigo, 1, c);
  }
});

test('veredicto: uno fallado y otro corriendo → 1 (el fallo manda)', () => {
  const v = veredicto([run('roto', 'completed', 'failure'), run('lento', 'in_progress')]);
  assert.strictEqual(v.codigo, 1);
  assert.deepStrictEqual(v.fallados, ['roto']);
});

test('veredicto: alguno sigue corriendo o en cola y ninguno falló → 2', () => {
  assert.strictEqual(veredicto([run('a', 'completed', 'success'), run('b', 'in_progress')]).codigo, 2);
  assert.strictEqual(veredicto([run('a', 'queued')]).codigo, 2);
});

test('veredicto: sin ningún check → 2 (todavía no apareció)', () => {
  const v = veredicto([]);
  assert.strictEqual(v.codigo, 2);
  assert.strictEqual(v.total, 0);
});

test('dueñoRepo: https con y sin .git', () => {
  assert.deepStrictEqual(dueñoRepo('https://github.com/guidocameraeq/Millennium.git'), { dueño: 'guidocameraeq', repo: 'Millennium' });
  assert.deepStrictEqual(dueñoRepo('https://github.com/guidocameraeq/Millennium'), { dueño: 'guidocameraeq', repo: 'Millennium' });
  assert.deepStrictEqual(dueñoRepo('https://github.com/guidocameraeq/Millennium.git\n'), { dueño: 'guidocameraeq', repo: 'Millennium' });
});

test('dueñoRepo: ssh y credenciales embebidas', () => {
  assert.deepStrictEqual(dueñoRepo('git@github.com:guidocameraeq/Millennium.git'), { dueño: 'guidocameraeq', repo: 'Millennium' });
  assert.deepStrictEqual(dueñoRepo('https://usuario@github.com/o/r.git'), { dueño: 'o', repo: 'r' });
});

test('dueñoRepo: otro host o basura → null', () => {
  assert.strictEqual(dueñoRepo('https://gitlab.com/o/r.git'), null);
  assert.strictEqual(dueñoRepo('no es una url'), null);
  assert.strictEqual(dueñoRepo(''), null);
});

test('sinChecksVencido: con --esperar, sin checks pasados 3 min → vencido', () => {
  assert.strictEqual(sinChecksVencido(0, 180000), true);
  assert.strictEqual(sinChecksVencido(0, 179999), false);
  assert.strictEqual(sinChecksVencido(2, 999999), false);
});

test('resumen: última línea con sha corto, cantidad y estado', () => {
  assert.strictEqual(resumen('a8a575a3929f', 3, 0), 'ci-verde @a8a575a: 3 checks · verde');
  assert.strictEqual(resumen('a8a575a3929f', 3, 1), 'ci-verde @a8a575a: 3 checks · rojo');
  assert.strictEqual(resumen('a8a575a3929f', 0, 2), 'ci-verde @a8a575a: 0 checks · corriendo');
});

const { decidir, textoHttp } = require('./ci-verde.cjs');
const MIN = 60000;

test('decidir: sin --esperar devuelve el código tal cual', () => {
  assert.deepStrictEqual(decidir({ codigo: 2, total: 1 }, false, 0), { codigo: 2 });
  assert.deepStrictEqual(decidir({ codigo: 0, total: 1 }, true, 0), { codigo: 0 });
  assert.deepStrictEqual(decidir({ codigo: 1, total: 1 }, true, 0), { codigo: 1 });
});

test('decidir: con --esperar y corriendo → seguir hasta los 25 min, después 2', () => {
  assert.deepStrictEqual(decidir({ codigo: 2, total: 2 }, true, 10 * MIN), { seguir: true });
  assert.deepStrictEqual(decidir({ codigo: 2, total: 2 }, true, 25 * MIN), { codigo: 2 });
});

test('decidir: con --esperar y sin checks → seguir antes de 3 min, 1 con aviso después', () => {
  assert.deepStrictEqual(decidir({ codigo: 2, total: 0 }, true, 2 * MIN), { seguir: true });
  const d = decidir({ codigo: 2, total: 0 }, true, 3 * MIN);
  assert.strictEqual(d.codigo, 1);
  assert.ok(d.aviso);
});

test('textoHttp: explica 401/403/404/422 y no se rompe con otros', () => {
  for (const c of [401, 403, 404, 422]) assert.match(textoHttp(c), new RegExp(`${c}: `));
  assert.strictEqual(textoHttp(500), 'la API contestó 500');
});

test('resumen: error sin verificar', () => {
  assert.strictEqual(resumen('a8a575a3929f', 0, null), 'ci-verde @a8a575a: 0 checks · sin verificar');
});
