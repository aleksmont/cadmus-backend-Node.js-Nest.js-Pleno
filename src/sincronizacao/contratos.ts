export interface MensagemSincronizacao {
  sincronizacaoId: string;
  consentimentoId: string;
  correlacaoId: string;
  de: string;
  ate: string;
}

export interface Entrega {
  mensagemId: string;
  recibo: string;
  tentativa: number;
  corpo: string;
}

export interface Consentimento {
  id: string;
  instituicaoId: string;
  idExterno: string;
}

export interface LancamentoExterno {
  contaId: string;
  id: string;
  valor: string;
  moeda: string;
  ocorridoEm: string;
  descricao: string;
}

export interface Lancamento extends LancamentoExterno {}

export interface Pagina {
  lancamentos: LancamentoExterno[];
  proximoCursor?: string;
}

export abstract class Parceira {
  abstract buscarPagina(
    consentimento: Consentimento,
    mensagem: MensagemSincronizacao,
    cursor?: string,
  ): Promise<Pagina>;
}

export abstract class Repositorio {
  abstract obterConsentimento(id: string): Promise<Consentimento>;
  abstract salvarPagina(consentimentoId: string, lancamentos: Lancamento[]): Promise<number>;
  // Retorna true somente para a primeira conclusão desta sincronização.
  abstract concluir(mensagem: MensagemSincronizacao): Promise<boolean>;
}

export abstract class Fila {
  // No SQS: DeleteMessage usando o receipt handle desta entrega.
  abstract confirmar(recibo: string): Promise<void>;
  // No SQS: ChangeMessageVisibility. Não cria uma cópia da mensagem.
  abstract adiar(recibo: string, segundos: number): Promise<void>;
}

export abstract class Telemetria {
  abstract registrar(evento: string, campos: Record<string, string | number>): void;
  abstract incrementar(nome: string, rotulos: Record<string, string>, valor?: number): void;
}

export class LimiteDaParceira extends Error {
  constructor(readonly esperarSegundos?: number) {
    super('Limite de requisições da instituição atingido');
  }
}

export class FalhaPermanente extends Error {}
