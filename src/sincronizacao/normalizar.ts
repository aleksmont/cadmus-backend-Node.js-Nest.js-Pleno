import { FalhaPermanente, Lancamento, LancamentoExterno, MensagemSincronizacao } from './contratos.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const instante = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function dataValida(valor: unknown): valor is string {
  if (typeof valor !== 'string' || !instante.test(valor) || !Number.isFinite(Date.parse(valor))) return false;
  const dia = valor.slice(0, 10);
  return new Date(`${dia}T00:00:00Z`).toISOString().slice(0, 10) === dia;
}

export function lerMensagem(corpo: string): MensagemSincronizacao {
  let valor: unknown;
  try { valor = JSON.parse(corpo); } catch { throw new FalhaPermanente('Mensagem não é JSON válido'); }
  if (!valor || typeof valor !== 'object') throw new FalhaPermanente('Mensagem inválida');
  const m = valor as Record<string, unknown>;
  if (!['sincronizacaoId', 'consentimentoId', 'correlacaoId'].every(
    (campo) => typeof m[campo] === 'string' && uuid.test(m[campo]),
  ) || !dataValida(m.de) || !dataValida(m.ate) || Date.parse(m.de) >= Date.parse(m.ate)) {
    throw new FalhaPermanente('Identificadores ou intervalo inválidos');
  }
  return m as unknown as MensagemSincronizacao;
}

export function normalizar(valor: LancamentoExterno): Lancamento {
  if (!valor || typeof valor !== 'object' ||
    typeof valor.id !== 'string' || !valor.id.trim() || valor.id.length > 200 ||
    typeof valor.contaId !== 'string' || !valor.contaId.trim() || valor.contaId.length > 200 ||
    typeof valor.valor !== 'string' || !/^-?\d{1,16}\.\d{2}$/.test(valor.valor) ||
    valor.moeda !== 'BRL' || !dataValida(valor.ocorridoEm) ||
    typeof valor.descricao !== 'string' || valor.descricao.length > 500) {
    throw new FalhaPermanente('Lançamento incompatível com o contrato da integração');
  }
  // O contrato usa valor decimal assinado: débito negativo, crédito positivo.
  // Não converter para Number: o banco recebe o decimal como texto.
  return { ...valor, ocorridoEm: new Date(valor.ocorridoEm).toISOString(), descricao: valor.descricao.trim() };
}
