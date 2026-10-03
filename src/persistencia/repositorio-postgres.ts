import { Pool, PoolClient } from 'pg';
import { Consentimento, FalhaPermanente, Lancamento, MensagemSincronizacao, Repositorio } from '../sincronizacao/contratos.js';

export class RepositorioPostgres extends Repositorio {
  constructor(private readonly pool: Pool) { super(); }

  async obterConsentimento(id: string): Promise<Consentimento> {
    const { rows } = await this.pool.query<Consentimento>(`
      SELECT id, instituicao_id AS "instituicaoId", id_externo AS "idExterno"
      FROM consentimento WHERE id = $1 AND status = 'ATIVO' AND valido_ate > clock_timestamp()
    `, [id]);
    if (!rows[0]) throw new FalhaPermanente('Consentimento inexistente, revogado ou expirado');
    return rows[0];
  }

  private async transacao<T>(operacao: (cliente: PoolClient) => Promise<T>): Promise<T> {
    const cliente = await this.pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query("SET LOCAL statement_timeout = '5s'");
      await cliente.query("SET LOCAL lock_timeout = '2s'");
      const resultado = await operacao(cliente);
      await cliente.query('COMMIT');
      return resultado;
    } catch (erro) {
      await cliente.query('ROLLBACK');
      throw erro;
    } finally { cliente.release(); }
  }

  private async validarConsentimento(cliente: PoolClient, id: string): Promise<void> {
    const resultado = await cliente.query(`
      SELECT id FROM consentimento
      WHERE id = $1 AND status = 'ATIVO' AND valido_ate > clock_timestamp()
      FOR SHARE
    `, [id]);
    if (!resultado.rowCount) throw new FalhaPermanente('Consentimento não está ativo');
  }

  async salvarPagina(consentimentoId: string, lancamentos: Lancamento[]): Promise<number> {
    return this.transacao(async (cliente) => {
      await this.validarConsentimento(cliente, consentimentoId);
      if (!lancamentos.length) return 0;
      const { rows: contas } = await cliente.query<{ id: string; id_externo: string; cliente_id: string }>(`
        SELECT c.id, c.id_externo, c.cliente_id FROM conta c
        JOIN consentimento_conta cc ON cc.conta_id = c.id
        WHERE cc.consentimento_id = $1 AND c.id_externo = ANY($2::text[])
      `, [consentimentoId, [...new Set(lancamentos.map((l) => l.contaId))]]);
      const porIdExterno = new Map(contas.map((c) => [c.id_externo, c]));
      const registros = lancamentos.map((l) => {
        const conta = porIdExterno.get(l.contaId);
        if (!conta) throw new FalhaPermanente('Conta não pertence ao consentimento');
        return {
          conta_id: conta.id, cliente_id: conta.cliente_id, id_externo: l.id,
          valor: l.valor, moeda: l.moeda, ocorrido_em: l.ocorridoEm, descricao: l.descricao,
        };
      });
      const resultado = await cliente.query(`
        INSERT INTO lancamento (conta_id, cliente_id, id_externo, valor, moeda, ocorrido_em, descricao)
        SELECT conta_id, cliente_id, id_externo, valor, moeda, ocorrido_em, descricao
        FROM jsonb_to_recordset($1::jsonb) AS l(
          conta_id uuid, cliente_id uuid, id_externo text, valor numeric(18,2),
          moeda char(3), ocorrido_em timestamptz, descricao text
        )
        ORDER BY conta_id, id_externo
        ON CONFLICT (conta_id, id_externo) DO NOTHING
      `, [JSON.stringify(registros)]);
      return resultado.rowCount ?? 0;
    });
  }

  async concluir(mensagem: MensagemSincronizacao): Promise<boolean> {
    return this.transacao(async (cliente) => {
      // FOR UPDATE serializa a conclusão; evita upgrade concorrente de SHARE para UPDATE.
      const consentimento = await cliente.query(`
        SELECT id FROM consentimento
        WHERE id = $1 AND status = 'ATIVO' AND valido_ate > clock_timestamp() FOR UPDATE
      `, [mensagem.consentimentoId]);
      if (!consentimento.rowCount) throw new FalhaPermanente('Consentimento não está ativo');
      const resultado = await cliente.query(`
        INSERT INTO sincronizacao (consentimento_id, id, de, ate) VALUES ($1, $2, $3, $4)
        ON CONFLICT (consentimento_id, id) DO NOTHING
      `, [mensagem.consentimentoId, mensagem.sincronizacaoId, mensagem.de, mensagem.ate]);
      if (!resultado.rowCount) return false;
      await cliente.query(`
        UPDATE consentimento SET
          ultima_sincronizacao_em = clock_timestamp(),
          sincronizado_ate = GREATEST(sincronizado_ate, $2::timestamptz)
        WHERE id = $1
      `, [mensagem.consentimentoId, mensagem.ate]);
      return true;
    });
  }
}
