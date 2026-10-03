import { Consentimento, FalhaPermanente, LimiteDaParceira, MensagemSincronizacao, Pagina, Parceira } from '../sincronizacao/contratos.js';

export function interpretarRetryAfter(valor: string | null, agora = Date.now()): number | undefined {
  if (valor === null) return undefined;
  const texto = valor.trim();
  if (/^\d+$/.test(texto)) {
    const segundos = Number(texto);
    return Number.isSafeInteger(segundos) ? segundos : undefined;
  }
  // Só aceita a forma de data HTTP, evitando interpretar "-1" como data.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(texto)) return undefined;
  const data = Date.parse(texto);
  return Number.isFinite(data) ? Math.max(0, Math.ceil((data - agora) / 1000)) : undefined;
}

// Contrato HTTP ilustrativo: o adaptador real traduziria o contrato da instituição.
export class ParceiraHttp extends Parceira {
  constructor(
    private readonly baseUrl: string,
    private readonly obterToken: (consentimento: Consentimento) => Promise<string>,
    private readonly requisitar: typeof fetch = fetch,
  ) { super(); }

  async buscarPagina(consentimento: Consentimento, mensagem: MensagemSincronizacao, cursor?: string): Promise<Pagina> {
    const url = new URL(`consentimentos/${encodeURIComponent(consentimento.idExterno)}/lancamentos`, this.baseUrl);
    url.searchParams.set('de', mensagem.de);
    url.searchParams.set('ate', mensagem.ate);
    if (cursor !== undefined) url.searchParams.set('cursor', cursor);
    const resposta = await this.requisitar(url, {
      headers: {
        Authorization: `Bearer ${await this.obterToken(consentimento)}`,
        'X-Correlation-Id': mensagem.correlacaoId,
      },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!resposta.ok) {
      const espera = interpretarRetryAfter(resposta.headers.get('retry-after'));
      await resposta.body?.cancel();
      if (resposta.status === 429) throw new LimiteDaParceira(espera);
      if (resposta.status >= 500 || resposta.status === 408) throw new Error('Falha temporária na instituição');
      throw new FalhaPermanente(`Instituição retornou HTTP ${resposta.status}`);
    }
    const pagina: unknown = await resposta.json();
    if (!pagina || typeof pagina !== 'object' ||
      !('lancamentos' in pagina) || !Array.isArray(pagina.lancamentos) || pagina.lancamentos.length > 1_000 ||
      ('proximoCursor' in pagina && (typeof pagina.proximoCursor !== 'string' || !pagina.proximoCursor))) {
      throw new FalhaPermanente('Página incompatível com o contrato da integração');
    }
    return pagina as Pagina;
  }
}
