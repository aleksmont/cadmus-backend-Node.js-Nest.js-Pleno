import { Injectable } from '@nestjs/common';
import { Entrega, FalhaPermanente, Fila, LimiteDaParceira, Parceira, Repositorio, Telemetria } from './contratos.js';
import { lerMensagem, normalizar } from './normalizar.js';

export function calcularEspera(tentativa: number, minimo = 0, aleatorio = Math.random): number {
  const teto = Math.min(300, 2 ** Math.min(9, Math.max(1, tentativa)));
  return Math.max(1, Math.ceil(minimo), Math.ceil(teto * aleatorio()));
}

@Injectable()
export class ConsumidorSincronizacao {
  constructor(
    private readonly parceira: Parceira,
    private readonly repositorio: Repositorio,
    private readonly fila: Fila,
    private readonly telemetria: Telemetria,
  ) {}

  async processar(entrega: Entrega): Promise<void> {
    const inicio = Date.now();
    const campos: Record<string, string | number> = {
      mensagem_id: entrega.mensagemId,
      tentativa: entrega.tentativa,
    };
    let instituicao = 'desconhecida';
    try {
      const mensagem = lerMensagem(entrega.corpo);
      Object.assign(campos, {
        sincronizacao_id: mensagem.sincronizacaoId,
        correlacao_id: mensagem.correlacaoId,
        consentimento_id: mensagem.consentimentoId,
      });
      const consentimento = await this.repositorio.obterConsentimento(mensagem.consentimentoId);
      instituicao = consentimento.instituicaoId;
      campos.instituicao_id = instituicao;
      this.telemetria.registrar('sincronizacao_iniciada', campos);

      let cursor: string | undefined;
      const cursores = new Set<string>();
      let paginas = 0;
      do {
        const inicioPagina = Date.now();
        const pagina = await this.parceira.buscarPagina(consentimento, mensagem, cursor);
        const buscaMs = Date.now() - inicioPagina;
        const lancamentos = pagina.lancamentos.map(normalizar);
        const inicioPersistencia = Date.now();
        const inseridos = await this.repositorio.salvarPagina(consentimento.id, lancamentos);
        paginas++;
        this.telemetria.registrar('pagina_persistida', {
          ...campos, pagina: paginas, recebidos: lancamentos.length, inseridos,
          busca_ms: buscaMs, persistencia_ms: Date.now() - inicioPersistencia,
        });
        cursor = pagina.proximoCursor;
        if (cursor !== undefined && (cursores.has(cursor) || paginas >= 10_000)) {
          throw new FalhaPermanente('Paginação repetida ou acima do limite de proteção');
        }
        if (cursor !== undefined) cursores.add(cursor);
      } while (cursor !== undefined);

      const primeiraConclusao = await this.repositorio.concluir(mensagem);
      if (primeiraConclusao) {
        this.telemetria.incrementar('sincronizacoes_concluidas_total', { instituicao });
      }
      // Se a confirmação falhar depois do commit, a reentrega é segura.
      await this.fila.confirmar(entrega.recibo);
      this.telemetria.registrar('sincronizacao_confirmada', { ...campos, duracao_ms: Date.now() - inicio });
    } catch (erro) {
      const motivo = erro instanceof LimiteDaParceira ? 'limite_429'
        : erro instanceof FalhaPermanente ? 'permanente' : 'transitorio';
      this.telemetria.incrementar('sincronizacoes_falhas_total', { instituicao, motivo });
      this.telemetria.registrar('sincronizacao_interrompida', {
        ...campos, motivo, duracao_ms: Date.now() - inicio,
      });
      // Sem ACK. A redrive policy da fila envia falhas persistentes à DLQ.
      if (erro instanceof FalhaPermanente) throw erro;
      const espera = calcularEspera(entrega.tentativa,
        erro instanceof LimiteDaParceira ? erro.esperarSegundos : 0);
      // O adaptador deve garantir o limite restante de visibilidade do SQS.
      // Esperas longas exigem reagendamento durável; nunca encurtar Retry-After.
      await this.fila.adiar(entrega.recibo, espera);
      this.telemetria.registrar('sincronizacao_adiada', { ...campos, motivo, espera_segundos: espera });
      throw erro;
    }
  }
}
