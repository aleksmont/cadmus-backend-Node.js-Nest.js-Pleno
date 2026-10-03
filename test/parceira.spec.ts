import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { interpretarRetryAfter, ParceiraHttp } from '../src/integracoes/parceira-http.js';
import { FalhaPermanente, LimiteDaParceira } from '../src/sincronizacao/contratos.js';
import { lerMensagem, normalizar } from '../src/sincronizacao/normalizar.js';
import { consentimento, lancamento, mensagem } from './apoio.js';

test('interpreta Retry-After em segundos, data HTTP e entradas inválidas', () => {
  const agora = Date.parse('2026-10-02T12:00:00Z');
  assert.equal(interpretarRetryAfter('120', agora), 120);
  assert.equal(interpretarRetryAfter('Fri, 02 Oct 2026 12:02:00 GMT', agora), 120);
  assert.equal(interpretarRetryAfter('Fri, 02 Oct 2026 11:00:00 GMT', agora), 0);
  for (const valor of [null, '', '-1', '1.5', 'não é uma data']) {
    assert.equal(interpretarRetryAfter(valor, agora), undefined);
  }
});

test('HTTP 429 não lê lançamentos nem repete a chamada dentro da tentativa', async () => {
  let chamadas = 0;
  const parceira = new ParceiraHttp('https://parceira.example/', async () => 'token-simulado', async () => {
    chamadas++;
    return new Response('limite', { status: 429, headers: { 'Retry-After': '75' } });
  });
  await assert.rejects(parceira.buscarPagina(consentimento, mensagem), (erro: unknown) =>
    erro instanceof LimiteDaParceira && erro.esperarSegundos === 75);
  assert.equal(chamadas, 1);
});

test('adaptador envia janela, cursor e correlação sem registrar o token', async () => {
  const parceira = new ParceiraHttp('https://parceira.example/', async () => 'token-simulado', async (url, init) => {
    assert.equal(new URL(String(url)).searchParams.get('cursor'), 'p2');
    assert.equal(new URL(String(url)).searchParams.get('ate'), mensagem.ate);
    assert.equal((init?.headers as Record<string, string>)['X-Correlation-Id'], mensagem.correlacaoId);
    assert.ok(init?.signal);
    return Response.json({ lancamentos: [lancamento] });
  });
  assert.equal((await parceira.buscarPagina(consentimento, mensagem, 'p2')).lancamentos.length, 1);
});

test('HTTP 503 é transitório e 403 é permanente', async () => {
  for (const status of [503, 403]) {
    const parceira = new ParceiraHttp('https://parceira.example/', async () => 'token', async () => new Response(null, { status }));
    await assert.rejects(parceira.buscarPagina(consentimento, mensagem), (erro: unknown) =>
      erro instanceof Error && (erro instanceof FalhaPermanente) === (status === 403));
  }
});

test('payload ou cursor inválido não é interpretado como fim da sincronização', async () => {
  for (const payload of [{}, { lancamentos: [], proximoCursor: '' }, { lancamentos: [], proximoCursor: null }]) {
    const parceira = new ParceiraHttp('https://parceira.example/', async () => 'token', async () => Response.json(payload));
    await assert.rejects(parceira.buscarPagina(consentimento, mensagem), FalhaPermanente);
  }
});

test('normalização preserva decimal exato, sinal e identidade', () => {
  const resultado = normalizar({ ...lancamento, valor: '9999999999999999.99', ocorridoEm: '2026-09-20T09:30:00-03:00' });
  assert.equal(resultado.valor, '9999999999999999.99');
  assert.equal(resultado.id, lancamento.id);
  assert.equal(resultado.ocorridoEm, '2026-09-20T12:30:00.000Z');
  assert.equal(normalizar(lancamento).valor, '-125.90');
});

test('normalização rejeita dados que poderiam corromper valores ou identidade', () => {
  for (const alteracao of [{ id: '' }, { contaId: '' }, { valor: '1.999' }, { valor: 'NaN' },
    { valor: '10000000000000000.00' }, { moeda: 'USD' }, { ocorridoEm: '2026-02-30T00:00:00Z' }]) {
    assert.throws(() => normalizar({ ...lancamento, ...alteracao }), FalhaPermanente);
  }
});

test('mensagem exige intervalo com timezone e identificadores válidos', () => {
  assert.deepEqual(lerMensagem(JSON.stringify(mensagem)), mensagem);
  for (const alteracao of [{ de: mensagem.ate }, { de: '2026-09-01' }, { consentimentoId: 'inválido' }]) {
    assert.throws(() => lerMensagem(JSON.stringify({ ...mensagem, ...alteracao })), FalhaPermanente);
  }
});
