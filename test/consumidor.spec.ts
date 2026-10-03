import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { ConsumidorSincronizacao, calcularEspera } from '../src/sincronizacao/consumidor.js';
import { FalhaPermanente, LimiteDaParceira, Parceira } from '../src/sincronizacao/contratos.js';
import { SincronizacaoModule } from '../src/sincronizacao/modulo.js';
import { entrega, FilaMemoria, lancamento, RepositorioMemoria, TelemetriaMemoria } from './apoio.js';

function preparar(parceira: Parceira = { buscarPagina: async () => ({ lancamentos: [lancamento] }) }) {
  const repositorio = new RepositorioMemoria();
  const fila = new FilaMemoria();
  const telemetria = new TelemetriaMemoria();
  return { repositorio, fila, telemetria, consumidor: new ConsumidorSincronizacao(parceira, repositorio, fila, telemetria) };
}

test('Nest resolve as dependências e a reentrega não duplica a conclusão', async () => {
  const deps = preparar();
  const app = await NestFactory.createApplicationContext(SincronizacaoModule.registrar({
    ...deps, parceira: { buscarPagina: async () => ({ lancamentos: [lancamento] }) },
  }), { logger: false });
  try {
    const consumidor = app.get(ConsumidorSincronizacao);
    await consumidor.processar(entrega);
    await consumidor.processar({ ...entrega, recibo: 'novo-recibo', tentativa: 2 });
    assert.equal(deps.repositorio.registros.size, 1);
    assert.deepEqual(deps.fila.confirmacoes, [entrega.recibo, 'novo-recibo']);
    assert.equal(deps.telemetria.metricas.filter((m) => m === 'sincronizacoes_concluidas_total').length, 1);
    assert.ok(deps.telemetria.logs.every((l) => !JSON.stringify(l).includes(lancamento.valor)));
  } finally { await app.close(); }
});

test('429 na segunda página conserva a primeira, não confirma e permite retomada', async () => {
  let limitar = true;
  const { consumidor, repositorio, fila } = preparar({
    buscarPagina: async (_c, _m, cursor) => {
      if (!cursor) return { lancamentos: [lancamento], proximoCursor: 'pagina-2' };
      if (limitar) throw new LimiteDaParceira(90);
      return { lancamentos: [{ ...lancamento, id: 'transacao-2' }] };
    },
  });
  await assert.rejects(consumidor.processar(entrega), LimiteDaParceira);
  assert.equal(repositorio.registros.size, 1);
  assert.equal(repositorio.conclusoes.size, 0);
  assert.equal(fila.confirmacoes.length, 0);
  assert.equal(fila.adiamentos[0], 90);
  limitar = false;
  await consumidor.processar({ ...entrega, tentativa: 2 });
  assert.equal(repositorio.registros.size, 2);
  assert.equal(repositorio.conclusoes.size, 1);
  assert.equal(fila.confirmacoes.length, 1);
});

test('falha ao confirmar depois do commit permite reentrega segura', async () => {
  const { consumidor, repositorio, fila } = preparar();
  const confirmar = fila.confirmar.bind(fila);
  fila.confirmar = async () => { throw new Error('Fila indisponível'); };
  await assert.rejects(consumidor.processar(entrega), /Fila indisponível/);
  assert.equal(repositorio.conclusoes.size, 1);
  fila.confirmar = confirmar;
  await consumidor.processar(entrega);
  assert.equal(repositorio.registros.size, 1);
  assert.equal(fila.confirmacoes.length, 1);
});

test('falha no banco não confirma nem registra conclusão', async () => {
  const { consumidor, repositorio, fila } = preparar();
  repositorio.salvarPagina = async () => { throw new Error('Banco indisponível'); };
  await assert.rejects(consumidor.processar(entrega), /Banco indisponível/);
  assert.equal(fila.confirmacoes.length, 0);
  assert.equal(repositorio.conclusoes.size, 0);
  assert.equal(fila.adiamentos.length, 1);
});

test('mensagem inválida não é confirmada e fica sujeita à DLQ', async () => {
  const { consumidor, fila } = preparar();
  await assert.rejects(consumidor.processar({ ...entrega, corpo: '{}' }), FalhaPermanente);
  assert.deepEqual(fila.confirmacoes, []);
});

test('cursor repetido interrompe a sincronização sem marcar sucesso', async () => {
  const { consumidor, repositorio, fila } = preparar({
    buscarPagina: async () => ({ lancamentos: [lancamento], proximoCursor: 'repetido' }),
  });
  await assert.rejects(consumidor.processar(entrega), /Paginação repetida/);
  assert.equal(repositorio.conclusoes.size, 0);
  assert.equal(fila.confirmacoes.length, 0);
});

test('página vazia ainda segue o cursor e só confirma no fim', async () => {
  let buscas = 0;
  const { consumidor, repositorio } = preparar({ buscarPagina: async () => {
    buscas++;
    return buscas === 1 ? { lancamentos: [], proximoCursor: 'p2' } : { lancamentos: [lancamento] };
  } });
  await consumidor.processar(entrega);
  assert.equal(buscas, 2);
  assert.equal(repositorio.registros.size, 1);
});

test('backoff é limitado, tem jitter e nunca reduz Retry-After', () => {
  assert.equal(calcularEspera(1, 0, () => 0), 1);
  assert.equal(calcularEspera(4, 0, () => 0.5), 8);
  assert.ok(calcularEspera(100, 0, () => 1) <= 300);
  assert.equal(calcularEspera(100, 900, () => 1), 900);
});
