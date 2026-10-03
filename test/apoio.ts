import { Consentimento, Entrega, Fila, Lancamento, MensagemSincronizacao, Repositorio, Telemetria } from '../src/sincronizacao/contratos.js';

export const mensagem: MensagemSincronizacao = {
  sincronizacaoId: '10000000-0000-4000-8000-000000000001',
  consentimentoId: '20000000-0000-4000-8000-000000000001',
  correlacaoId: '30000000-0000-4000-8000-000000000001',
  de: '2026-09-01T00:00:00Z', ate: '2026-10-01T00:00:00Z',
};
export const consentimento: Consentimento = { id: mensagem.consentimentoId, instituicaoId: 'banco-teste', idExterno: 'autorizacao-1' };
export const lancamento: Lancamento = {
  id: 'transacao-1', contaId: 'conta-externa-1', valor: '-125.90', moeda: 'BRL',
  ocorridoEm: '2026-09-20T12:30:00Z', descricao: 'Compra de teste',
};
export const entrega: Entrega = {
  mensagemId: 'mensagem-1', recibo: 'recibo-da-entrega-1', tentativa: 1, corpo: JSON.stringify(mensagem),
};
export class RepositorioMemoria extends Repositorio {
  registros = new Map<string, Lancamento>();
  conclusoes = new Set<string>();
  async obterConsentimento() { return consentimento; }
  async salvarPagina(_id: string, registros: Lancamento[]) {
    let inseridos = 0;
    for (const registro of registros) {
      const chave = `${registro.contaId}:${registro.id}`;
      if (!this.registros.has(chave)) { this.registros.set(chave, registro); inseridos++; }
    }
    return inseridos;
  }
  async concluir(m: MensagemSincronizacao) {
    const primeira = !this.conclusoes.has(m.sincronizacaoId);
    this.conclusoes.add(m.sincronizacaoId);
    return primeira;
  }
}
export class FilaMemoria extends Fila {
  confirmacoes: string[] = [];
  adiamentos: number[] = [];
  async confirmar(recibo: string) { this.confirmacoes.push(recibo); }
  async adiar(_recibo: string, segundos: number) { this.adiamentos.push(segundos); }
}
export class TelemetriaMemoria extends Telemetria {
  logs: { evento: string; campos: Record<string, string | number> }[] = [];
  metricas: string[] = [];
  registrar(evento: string, campos: Record<string, string | number>) { this.logs.push({ evento, campos: { ...campos } }); }
  incrementar(nome: string) { this.metricas.push(nome); }
}
