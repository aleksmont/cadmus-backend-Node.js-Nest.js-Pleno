import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { RepositorioPostgres } from '../src/persistencia/repositorio-postgres.js';
import { ConsumidorSincronizacao } from '../src/sincronizacao/consumidor.js';
import { FalhaPermanente, LimiteDaParceira } from '../src/sincronizacao/contratos.js';
import { entrega, FilaMemoria, lancamento, mensagem, TelemetriaMemoria } from './apoio.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Defina TEST_DATABASE_URL apontando para um PostgreSQL descartável de testes.');
const schema = `teste_${randomUUID().replaceAll('-', '')}`;
const administracao = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 5 });
const repositorio = new RepositorioPostgres(pool);
const clienteId = '40000000-0000-4000-8000-000000000001';
const contaId = '50000000-0000-4000-8000-000000000001';
const contaId2 = '50000000-0000-4000-8000-000000000002';
const outroConsentimento = '20000000-0000-4000-8000-000000000002';

before(async () => {
  await administracao.query(`CREATE SCHEMA ${schema}`);
  await pool.query(await readFile('sql/001_modelagem.sql', 'utf8'));
});
after(async () => {
  await pool.end();
  await administracao.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await administracao.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE sincronizacao, lancamento, consentimento_conta, conta, consentimento RESTART IDENTITY');
  for (const id of [mensagem.consentimentoId, outroConsentimento]) {
    await pool.query(`INSERT INTO consentimento (id, cliente_id, instituicao_id, id_externo, status, valido_ate)
      VALUES ($1::uuid, $2, 'banco-teste', $1::text, 'ATIVO', clock_timestamp() + interval '1 day')`, [id, clienteId]);
  }
  for (const [id, externo] of [[contaId, lancamento.contaId], [contaId2, 'conta-externa-2']]) {
    await pool.query(`INSERT INTO conta (id, cliente_id, instituicao_id, id_externo) VALUES ($1, $2, 'banco-teste', $3)`, [id, clienteId, externo]);
    for (const consentimentoId of [mensagem.consentimentoId, outroConsentimento]) {
      await pool.query(`INSERT INTO consentimento_conta VALUES ($1, $2, $3, 'banco-teste')`, [consentimentoId, id, clienteId]);
    }
  }
});

async function quantidade(tabela: 'lancamento' | 'sincronizacao') {
  return Number((await pool.query(`SELECT count(*) FROM ${tabela}`)).rows[0].count);
}

test('duas conexões disputando a mesma chave gravam um único lançamento', async () => {
  const resultados = await Promise.all([
    repositorio.salvarPagina(mensagem.consentimentoId, [lancamento]),
    repositorio.salvarPagina(mensagem.consentimentoId, [lancamento]),
  ]);
  assert.equal(resultados.reduce((a, b) => a + b), 1);
  assert.equal(await quantidade('lancamento'), 1);
  const { rows } = await pool.query('SELECT valor::text FROM lancamento');
  assert.equal(rows[0].valor, '-125.90');
});

test('renovação de consentimento não duplica a mesma conta e transação', async () => {
  await repositorio.salvarPagina(mensagem.consentimentoId, [lancamento]);
  await repositorio.salvarPagina(outroConsentimento, [lancamento]);
  assert.equal(await quantidade('lancamento'), 1);
});

test('mesmo id externo em contas diferentes representa dois lançamentos', async () => {
  await repositorio.salvarPagina(mensagem.consentimentoId, [lancamento, { ...lancamento, contaId: 'conta-externa-2' }]);
  assert.equal(await quantidade('lancamento'), 2);
});

test('valores e datas iguais com ids distintos não são descartados', async () => {
  await repositorio.salvarPagina(mensagem.consentimentoId, [lancamento, { ...lancamento, id: 'outro-id' }]);
  assert.equal(await quantidade('lancamento'), 2);
});

test('conta desconhecida rejeita a página inteira', async () => {
  await assert.rejects(repositorio.salvarPagina(mensagem.consentimentoId,
    [lancamento, { ...lancamento, id: 'outro-id', contaId: 'não-autorizada' }]), FalhaPermanente);
  assert.equal(await quantidade('lancamento'), 0);
});

test('erro SQL desfaz a página inteira, inclusive registros válidos', async () => {
  await assert.rejects(repositorio.salvarPagina(mensagem.consentimentoId,
    [lancamento, { ...lancamento, id: 'outro-id', moeda: 'USD' }]));
  assert.equal(await quantidade('lancamento'), 0);
});

test('429 após commit parcial pode ser reprocessado sem perda nem duplicação', async () => {
  let limitar = true;
  const fila = new FilaMemoria();
  const consumidor = new ConsumidorSincronizacao({ buscarPagina: async (_c, _m, cursor) => {
    if (!cursor) return { lancamentos: [lancamento], proximoCursor: 'p2' };
    if (limitar) throw new LimiteDaParceira(60);
    return { lancamentos: [{ ...lancamento, id: 'transacao-2' }] };
  } }, repositorio, fila, new TelemetriaMemoria());
  await assert.rejects(consumidor.processar(entrega), LimiteDaParceira);
  assert.equal(await quantidade('lancamento'), 1);
  assert.equal(await quantidade('sincronizacao'), 0);
  assert.equal((await pool.query('SELECT sincronizado_ate FROM consentimento WHERE id = $1', [mensagem.consentimentoId])).rows[0].sincronizado_ate, null);
  limitar = false;
  await consumidor.processar(entrega);
  assert.equal(await quantidade('lancamento'), 2);
  assert.equal(await quantidade('sincronizacao'), 1);
  assert.equal(fila.confirmacoes.length, 1);
});

test('conclusão concorrente é registrada uma vez e janela antiga não regride cobertura', async () => {
  const resultados = await Promise.all([repositorio.concluir(mensagem), repositorio.concluir(mensagem)]);
  assert.equal(resultados.filter(Boolean).length, 1);
  await repositorio.concluir({ ...mensagem, sincronizacaoId: randomUUID(), ate: '2026-09-15T00:00:00Z' });
  const { rows } = await pool.query('SELECT sincronizado_ate FROM consentimento WHERE id = $1', [mensagem.consentimentoId]);
  assert.equal(rows[0].sincronizado_ate.toISOString(), '2026-10-01T00:00:00.000Z');
});

test('revogação impede busca, gravação e conclusão posteriores', async () => {
  await pool.query("UPDATE consentimento SET status = 'REVOGADO' WHERE id = $1", [mensagem.consentimentoId]);
  await assert.rejects(repositorio.obterConsentimento(mensagem.consentimentoId), FalhaPermanente);
  await assert.rejects(repositorio.salvarPagina(mensagem.consentimentoId, [lancamento]), FalhaPermanente);
  await assert.rejects(repositorio.concluir(mensagem), FalhaPermanente);
});

test('FK impede associar uma conta de outro cliente ao consentimento', async () => {
  const terceiro = randomUUID();
  await pool.query(`INSERT INTO conta (id, cliente_id, instituicao_id, id_externo)
    VALUES ($1, $2, 'banco-teste', 'conta-outro-cliente')`, [terceiro, randomUUID()]);
  await assert.rejects(pool.query(`INSERT INTO consentimento_conta VALUES ($1, $2, $3, 'banco-teste')`,
    [mensagem.consentimentoId, terceiro, clienteId]));
});

test('paginação por cursor cobre empates de data e isola clientes', async () => {
  const outroCliente = randomUUID();
  const outraConta = randomUUID();
  await pool.query(`INSERT INTO conta VALUES ($1, $2, 'outro-banco', 'outra-conta')`, [outraConta, outroCliente]);
  await pool.query(`INSERT INTO lancamento (conta_id, cliente_id, id_externo, valor, moeda, ocorrido_em, descricao)
    VALUES ($1, $2, 'isolado', 1, 'BRL', '2026-09-20T12:30:00Z', 'Teste')`, [outraConta, outroCliente]);
  await repositorio.salvarPagina(mensagem.consentimentoId,
    Array.from({ length: 105 }, (_, i) => ({ ...lancamento, id: `transacao-${i}` })));
  const consultas = (await readFile('sql/002_listagem.sql', 'utf8')).replace(/--[^\n]*/g, '').split(';');
  const primeira = await pool.query(consultas[0]!, [clienteId, mensagem.de, mensagem.ate]);
  assert.equal(primeira.rowCount, 51);
  const ids = new Set<string>();
  let registros = primeira.rows;
  while (registros.length) {
    const devolvidos = registros.slice(0, 50);
    for (const registro of devolvidos) {
      assert.ok(!ids.has(registro.id));
      ids.add(registro.id);
    }
    if (registros.length <= 50) break;
    const ultimo = devolvidos.at(-1)!;
    registros = (await pool.query(consultas[1]!, [clienteId, mensagem.de, mensagem.ate, ultimo.ocorrido_em, ultimo.id])).rows;
  }
  assert.equal(ids.size, 105);
});
