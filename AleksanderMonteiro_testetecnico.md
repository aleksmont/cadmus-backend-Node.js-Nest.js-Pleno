# Teste técnico Backend Node.js / Nest.js Pleno

A proposta trata da investigação do incidente e do processamento seguro de sincronizações bancárias, com foco em integridade dos lançamentos, recuperação de falhas e desempenho do extrato.

[Código e repositório](https://github.com/aleksmont/cadmus-backend-Node.js-Nest.js-Pleno) · [Enunciado original](docs/BackendNodeNestPleno_TesteTecnico.docx) · [Como executar os testes](README.md)

## Abertura

### Como você resumiria a solução?

Eu começaria entendendo por que a sincronização ficou lenta e por que os dados ficaram inconsistentes. Minha principal hipótese é que o volume maior aumentou o número de chamadas, gerou 429 e provocou reprocessamentos. Mas eu precisaria verificar isso nos dados do ambiente.

No código, a preocupação central é permitir que a mensagem seja processada novamente sem duplicar lançamentos. A confirmação da fila só acontece depois de concluir a gravação. Para o extrato, a proposta é usar um índice alinhado à consulta e paginação por cursor. E eu acompanharia se os clientes estão recebendo dados atualizados, porque CPU e memória não respondem essa pergunta.

### Que premissas você adotou?

Considerei PostgreSQL e SQS Standard, com possibilidade de entregar a mesma mensagem mais de uma vez. A mensagem mantém o identificador da sincronização, o consentimento, a correlação e uma janela fixa de consulta, incluindo o início e excluindo o fim.

Também considerei que a instituição fornece um identificador estável para cada conta e lançamento. O exemplo trata lançamentos efetivados e imutáveis, em BRL, com duas casas decimais. Contas e consentimentos já estão cadastrados, e as páginas da instituição são estáveis dentro da janela consultada.

Essas premissas precisam ser confirmadas. Se um lançamento puder mudar ou a paginação variar durante a coleta, a solução precisa de regras adicionais. E os números de performance que proponho são metas, não resultados medidos no ambiente do incidente.

## 1. Investigação antes da correção

### Você chegou ao incidente. O que olharia primeiro?

Eu montaria uma linha do tempo relacionando a entrada da instituição, a mudança no fluxo e o início dos sintomas. Compararia a instituição nova com as anteriores para entender se o problema está concentrado nela.

Depois, separaria o tempo de uma sincronização: espera na fila, chamadas externas, normalização, espera por conexão e gravação no banco. Isso evita tentar corrigir o banco quando o maior atraso está na API da parceira, por exemplo.

### Quais são suas hipóteses, em ordem de probabilidade?

Minha ordem inicial seria esta, e eu a mudaria conforme as evidências:

1. **Mais páginas, mais chamadas e limite excedido.** Olharia primeiro a taxa de 429, o `Retry-After`, chamadas por segundo e páginas por sincronização. Compararia isso com o crescimento da fila e a queda de conclusões.
2. **A mensagem volta à fila antes de terminar.** Compararia duração p95/p99 com o tempo de visibilidade e procuraria a mesma sincronização em dois consumidores ao mesmo tempo. Também olharia tentativas por mensagem e mensagens em processamento.
3. **O ajuste introduziu uma falha na escrita ou na paginação.** Revisaria o diff e procuraria confirmação antecipada da fila, cursor avançando antes do commit, erro tratado como página vazia e deduplicação sem chave única.
4. **A consulta do extrato não suporta o novo volume.** Pegaria a consulta real, parâmetros representativos e plano de execução. Procuraria varreduras grandes, ordenação em disco, `OFFSET` alto, contagem total e joins que multiplicam registros.
5. **O serviço está esgotando conexões ou outros recursos.** Verificaria espera no pool, locks, consultas em execução, CPU, memória, coleta de lixo, atraso do event loop e reinícios dos contêineres.

### Que métricas da fila ajudariam?

Eu olharia a idade da mensagem mais antiga, a quantidade de mensagens disponíveis, as mensagens em processamento e o número de recebimentos por mensagem. No SQS, isso inclui `ApproximateAgeOfOldestMessage` e `ApproximateReceiveCount`.

Se os recebimentos aumentam, mas as conclusões não, posso estar gastando capacidade com repetição. Esses contadores são aproximados; não usaria o número de exclusões da fila como contagem exata de sincronizações de negócio.

### Duplicidade e ausência podem ser o mesmo problema?

Podem. Imagine que a primeira página foi gravada, a segunda falhou e a mensagem voltou para a fila. Sem idempotência, a primeira página pode entrar novamente, enquanto os lançamentos das páginas seguintes continuam faltando.

Mas eu não concluiria isso só pelos sintomas. Compararia os identificadores da instituição, do banco e da resposta da API na mesma conta e janela. Se está uma vez no banco e duas vezes na API, investigaria joins ou paginação. Se está na instituição e não no banco, investigaria a coleta. Se está no banco e não aparece na API, olharia filtros, autorização e cache.

Também verificaria se a regra de deduplicação está descartando compras legítimas por terem o mesmo valor e a mesma data.

### E os erros 500? Você trataria todos como lentidão?

Não. Eu separaria por causa. Timeout esperando conexão, violação de unicidade e erro de serialização podem virar 500, mas pedem correções diferentes. Cruzaria o horário e a categoria do erro com a espera no pool, os bloqueios e o tempo das consultas. CPU baixa não elimina um gargalo de rede ou banco.

### O que faria hoje e o que deixaria para depois?

Hoje eu reduziria a taxa e a concorrência da instituição afetada, pausaria cargas históricas e priorizaria atualizações recentes. Ajustaria a visibilidade da fila ao tempo observado e interromperia a tentativa ao receber 429. Colocaria limite de tentativas, DLQ e alerta para evitar falhas circulando indefinidamente.

Se as evidências apontassem regressão no ajuste, avaliaria rollback, conferindo compatibilidade com os dados já gravados. Para a listagem, limitaria período e tamanho da página e avaliaria o índice com base no plano. Também comunicaria o atraso ao atendimento.

A correção definitiva inclui unicidade no banco, retomada segura, controle global de taxa, consulta paginada e reconciliação dos dados afetados. Eu não apagaria duplicados em massa nem marcaria uma sincronização como concluída só para reduzir a fila. Corrigir o código não recupera automaticamente os lançamentos que já faltaram.

## 2. Consumo da fila em Nest.js

### Explique o caminho de uma mensagem no seu código.

O consumidor valida a mensagem e verifica se o consentimento está ativo. Depois busca uma página na instituição, normaliza os lançamentos e grava essa página em uma transação. Repete o processo enquanto houver cursor.

Quando todas as páginas terminam, registra a conclusão da sincronização e só então confirma a mensagem. Se algo falhar antes disso, não há confirmação. A mensagem pode voltar, e o banco impede que os lançamentos já persistidos sejam duplicados.

**Onde conferir:** [`ConsumidorSincronizacao.processar`](src/sincronizacao/consumidor.ts).

### Por que separar essas classes?

Eu separaria o que muda por motivos diferentes. O consumidor coordena o fluxo. A normalização valida identidade, data, moeda e valor. O adaptador HTTP conhece o contrato da instituição. O repositório conhece as transações e as restrições do banco.

Fila e telemetria também ficam atrás de contratos. Isso permite simular falhas externas nos testes e trocar uma integração sem reescrever a regra de processamento. O módulo Nest registra essas dependências por injeção.

**Onde conferir:** [`contratos.ts`](src/sincronizacao/contratos.ts), [`normalizar.ts`](src/sincronizacao/normalizar.ts) e [`modulo.ts`](src/sincronizacao/modulo.ts).

### O que significa idempotência aqui?

Significa que repetir o processamento não cria outro registro para o mesmo lançamento. Posso chamar a instituição novamente e tentar inserir de novo, mas o estado final do banco continua com um único lançamento para aquela conta e aquele identificador externo.

Eu não estou prometendo executar tudo uma única vez. Estou garantindo que a repetição seja segura para a persistência, dentro das premissas do exemplo.

### Por que não consultar se existe antes de inserir?

Porque dois consumidores podem consultar ao mesmo tempo, ambos não encontrar o registro e ambos tentar inserir. Essa consulta não protege contra concorrência.

A garantia está em `UNIQUE (conta_id, id_externo)`. O código usa `ON CONFLICT ... DO NOTHING` para tratar a repetição esperada. Mesmo com dois processos, o banco arbitra a disputa pela chave.

**Onde conferir:** [`salvarPagina`](src/persistencia/repositorio-postgres.ts) e [`001_modelagem.sql`](sql/001_modelagem.sql).

### A primeira página foi salva e a segunda falhou. O que acontece?

A primeira fica salva. Não há conclusão da sincronização nem confirmação da mensagem. Na próxima tentativa, o exemplo recomeça a janela; os registros existentes são ignorados e os que faltam são inseridos.

Se a falha ocorrer dentro da gravação de uma página, a transação desfaz a página inteira. Eu não mantenho uma transação aberta durante todas as chamadas externas, porque isso prenderia recursos do banco por tempo demais.

### Recomeçar tudo não fica caro?

Fica, principalmente com muitas páginas. É uma escolha de simplicidade neste núcleo. Para um volume maior, eu salvaria um checkpoint na mesma transação que grava a página, desde que o cursor da instituição continue válido.

Se salvar o cursor antes dos lançamentos, posso pular dados depois de uma falha. Se ele ficar só em memória, perco o progresso quando o processo reinicia. E, se as páginas mudarem durante a coleta, preciso de snapshot, cursor estável ou reconciliação; uma janela fixa não resolve tudo.

### E se gravar tudo, mas falhar na confirmação da fila?

A mensagem pode ser entregue novamente. Os lançamentos continuam protegidos pela chave única, e a tabela `sincronizacao` impede registrar duas conclusões para o mesmo trabalho.

Esse caso é importante porque o commit do PostgreSQL e a confirmação da fila não são uma única transação. A solução precisa suportar essa janela de falha.

### Como você trata o 429?

O adaptador identifica o 429 e lança um erro específico. O consumidor para a tentativa, não confirma a mensagem e pede um adiamento.

Se houver `Retry-After`, respeito o tempo informado, em segundos ou data HTTP. Sem um valor válido, uso espera exponencial com uma parte aleatória, o jitter. Essa aleatoriedade evita que vários consumidores voltem exatamente juntos. O backoff tem teto de 300 segundos, mas um `Retry-After` maior prevalece.

**Onde conferir:** [`parceira-http.ts`](src/integracoes/parceira-http.ts) e `calcularEspera` em [`consumidor.ts`](src/sincronizacao/consumidor.ts).

### Por que apenas registrar o 429 e continuar é perigoso?

Porque posso tratar uma página que não consegui buscar como se estivesse vazia e marcar a sincronização como concluída. O extrato fica incompleto, mas parece atualizado. Além disso, continuar chamando uma instituição que já limitou as requisições agrava o atraso.

### Esse backoff resolve o limite da instituição inteira?

Não sozinho. Ele controla a espera daquela mensagem, mas vários contêineres podem continuar consumindo a mesma cota. Eu precisaria de controle compartilhado de taxa e concorrência, no escopo real do limite da instituição.

Uma opção é um token bucket distribuído: cada chamada consome uma permissão de um orçamento comum, renovado ao longo do tempo. Redis com operação atômica pode apoiar isso. No 429, reduziria o ritmo e recuperaria gradualmente. Circuit breaker serve para interromper chamadas durante falhas persistentes, mas não substitui esse controle de taxa.

### Como o adiamento funcionaria no SQS?

Normalmente, alterando a visibilidade da entrega atual. A confirmação usa o receipt handle para excluir a mensagem. O listener precisa estar sem confirmação automática e renovar a visibilidade durante trabalhos longos.

Existe um limite total de 12 horas de visibilidade desde o recebimento. Se a espera exigida não couber no tempo restante, preciso de reagendamento durável. Eu registraria a intenção de tentar novamente antes de excluir a mensagem original, por exemplo com outbox e agendador. Outbox é uma tabela de ações pendentes gravada transacionalmente e processada depois.

No exemplo, a fila é um contrato com simulação em memória. Esse adaptador real e a renovação de visibilidade ainda precisam ser implementados.

### Quais erros você tentaria novamente?

Rede, timeout, 408 e 5xx são candidatos a nova tentativa. Payload incompatível e consentimento inválido não se resolvem apenas repetindo. No exemplo, erros permanentes ficam sem confirmação para uma política de redrive com limite de tentativas; essa política ainda precisa ser configurada na fila.

Em produção, eu trataria 401 com uma política explícita de renovação de credencial, sem repetição infinita. Consentimento revogado também pode ter um encerramento auditável próprio, em vez de gerar ruído na DLQ.

## 3. Banco de dados e performance

### Explique a modelagem sem entrar em cada coluna.

Consentimento representa a autorização de um cliente para acessar dados de uma instituição, com status e validade. Conta representa a identidade estável da conta. A associação `consentimento_conta` permite renovar a autorização sem criar outra identidade de conta.

Lançamento pertence a uma conta e tem identificador externo único dentro dela. A tabela adicional `sincronizacao` registra qual janela foi concluída e quando. Isso permite contar trabalhos concluídos sem confundir sucesso com número de tentativas.

### Por que a chave única não usa o consentimento ou o ID da mensagem?

Porque renovar um consentimento não transforma uma transação antiga em nova. E duas mensagens diferentes podem trazer o mesmo lançamento.

Por isso, a identidade fica em conta mais identificador externo. A conta interna já distingue cliente e instituição. Também não uso valor, data e descrição como chave: duas compras legítimas podem ter os mesmos dados.

### E se a instituição não fornecer um ID estável?

Eu não conseguiria prometer a mesma garantia sem entender melhor o contrato. Um hash de valor, data e descrição apenas transforma esses campos em outra representação; não elimina a ambiguidade.

Precisaria buscar uma identidade confiável com a instituição ou definir uma reconciliação que trate os casos ambíguos. Eu deixaria essa limitação explícita.

### `DO NOTHING` não pode esconder uma atualização legítima?

Pode, se os lançamentos forem mutáveis. Ele faz sentido aqui porque a premissa é trabalhar com lançamentos efetivados e imutáveis.

Se a instituição permitir atualizações, eu usaria uma regra de atualização baseada em versão ou sequência confiável da origem. Não sobrescreveria simplesmente na ordem de chegada, porque uma resposta antiga pode chegar depois. Estornos e a mudança de pendente para efetivado também precisam de regras próprias.

### Como você lida com dinheiro e isolamento entre clientes?

O valor chega como texto decimal e é gravado em `numeric(18,2)`. Evito converter para `Number`, porque ponto flutuante pode perder precisão. O contrato define débito negativo e crédito positivo. Datas ficam em `timestamptz`, e a API também precisa preservar a precisão de decimais e IDs `bigint` na resposta.

O lançamento tem `cliente_id` para consultar o extrato diretamente. Essa desnormalização é protegida por uma chave estrangeira composta para a conta. Outras chaves estrangeiras impedem associar um consentimento a uma conta de outro cliente ou instituição. Na API, o cliente vem da autenticação, não de um parâmetro livre.

### Por que o endpoint pode ter ficado lento?

Uma consulta aceitável com poucas linhas pode se tornar cara com milhares por cliente. Eu procuraria `OFFSET` grande, ordenação sem índice, contagem total em cada página, N+1, joins que multiplicam linhas e filtros que dificultam usar o índice.

Também avaliaria estatísticas desatualizadas e disputa por conexões e I/O com o worker. O índice é uma hipótese de solução; o plano e as métricas precisam mostrar onde está o custo.

### Qual consulta você propõe?

Filtro o cliente e o período, ordeno por data e ID e continuo a partir do último registro devolvido. Para as páginas seguintes, a consulta é esta:

```sql
SELECT id, conta_id, valor, moeda, ocorrido_em, descricao
FROM lancamento
WHERE cliente_id = $1
  AND ocorrido_em >= $2::timestamptz
  AND ocorrido_em < $3::timestamptz
  AND (ocorrido_em, id) < ($4::timestamptz, $5::bigint)
ORDER BY ocorrido_em DESC, id DESC
LIMIT 51;
```

O índice proposto é `(cliente_id, ocorrido_em DESC, id DESC)`. A primeira página usa outra consulta, sem a condição de cursor. Busco 51 registros, devolvo 50 e uso o excedente para indicar que há mais. O cursor aponta para o 50º registro devolvido.

**Onde conferir:** [`002_listagem.sql`](sql/002_listagem.sql).

### Por que cursor, e por que usar data e ID juntos?

Com `OFFSET`, o banco precisa encontrar e descartar registros anteriores, o que tende a encarecer páginas profundas. O cursor permite buscar a partir de uma posição indexada.

Só a data não basta, porque vários lançamentos podem ter o mesmo instante. O ID desempata e torna a ordem definida. Eu validaria o cursor e o vincularia ao cliente e aos filtros, preferencialmente com assinatura. Evitaria um `COUNT(*)` em toda página.

### A paginação garante uma visão congelada do extrato?

Não. Ela ordena e continua a navegação, mas novas inserções ainda podem mudar o conjunto disponível. Um lançamento inserido em uma posição já percorrida pode aparecer só quando o usuário atualizar o extrato.

Para uma exportação consistente, eu precisaria de snapshot ou de um conjunto materializado específico. Não manteria uma transação de banco aberta enquanto o usuário navega entre requisições.

### Como provaria que melhorou?

Compararia antes e depois com a mesma distribuição de dados e concorrência, incluindo clientes de volume mediano e extremo, primeira página e páginas profundas. Mediria p50, p95, p99, taxa de erro, espera por conexão e tempo no banco.

O p95 é o tempo dentro do qual terminam 95% das requisições observadas. Uma meta inicial seria recuperar p95 de até 300 ms, p99 abaixo de 1 segundo e erros abaixo de 0,1%, por 30 minutos em carga de pico representativa. Eu alinharia esses critérios com o time.

No banco, compararia plano, buffers, linhas examinadas e uso de disco temporário. `EXPLAIN ANALYZE` executa a consulta; começaria em ambiente controlado ou réplica, com timeout. Os testes entregues verificam comportamento, mas não provam essas metas de performance.

### Como aplicaria o índice em uma tabela grande?

Eu avaliaria `CREATE INDEX CONCURRENTLY`, fora de um bloco de transação. Isso reduz bloqueio de escrita durante a construção, mas ainda consome I/O, espaço e WAL e pode esperar por transações. Monitoraria também o atraso da réplica. Se falhar, verificaria se ficou um índice inválido antes de tentar novamente.

Para a chave única, primeiro precisaria reconciliar duplicatas existentes e controlar novas escritas afetadas durante a transição. Não basta executar a restrição em uma tabela que já tem duplicação. O SQL do repositório cria um esquema novo; não é uma migração pronta para a base do incidente.

### Você colocaria cache, NoSQL ou particionamento?

Eu começaria medindo e corrigindo a consulta relacional. Cache pode ajudar depois, mas exige uma política clara de atualização para não esconder justamente o extrato desatualizado.

Particionamento também tem custo e pode dificultar a unicidade global quando a divisão é por data. Eu só adotaria essas alternativas com uma necessidade demonstrada e explicando o que ganhamos e o que fica mais complexo.

## 4. Testes e observabilidade

### Se o tempo fosse curto, quais testes viriam primeiro?

Primeiro, integração com PostgreSQL para provar que duas conexões tentando gravar a mesma chave deixam um único lançamento. Testaria também uma renovação de consentimento, o mesmo ID em contas diferentes e transações de mesmo valor com IDs distintos.

Depois, testaria 429 na segunda página após gravar a primeira, verificando que não há confirmação e que a repetição recupera o restante. Em seguida, falha de confirmação depois do commit, rollback de página, revogação e isolamento entre clientes.

Nos unitários, priorizaria interpretação do `Retry-After`, backoff, validação de identidade, datas e valores. Assim cubro primeiro os riscos de perder, duplicar ou considerar completos dados incompletos.

### Como você testa sem depender da instituição?

O adaptador recebe uma função de requisição substituível. Nos testes, ela devolve respostas controladas, como 429 com `Retry-After` ou uma página válida. Isso permite reproduzir a falha sem acesso à instituição.

A fila também é simulada para verificar confirmação e adiamento. Já a restrição de unicidade é testada em PostgreSQL real, porque um repositório em memória não prova concorrência nem transações do banco.

### O que já foi validado e o que ainda falta?

A validação local passou em 16 testes unitários e 11 de integração. Eles incluem resolução de dependências no Nest, concorrência no PostgreSQL, falha parcial, valores decimais e paginação com empate de datas.

Ainda faltam testes do adaptador SQS real, renovação de visibilidade, DLQ, limitador distribuído, interrupção do processo em pontos críticos e carga representativa. O fluxo de CI está no repositório; exigir que ele passe antes do merge depende da proteção da branch no GitHub.

**Onde conferir:** [`test/`](test/) e [configuração de CI](.github/workflows/ci.yml).

### Que informações você colocaria nos logs?

Timestamp UTC, ambiente, versão, etapa, correlação, sincronização, mensagem, tentativa, consentimento interno, instituição e duração. Por página, registraria recebidos, inseridos e tempo de busca e persistência. Em erro, categoria segura, status e espera agendada.

Não registraria token, recibo da fila, CPF, conta externa, saldo ou payload de lançamento. Mesmo o consentimento interno merece acesso e retenção controlados.

Para rastreamento distribuído, propagaria `traceparent` entre produtor, fila e consumidor, com spans de HTTP e banco. O código já emite eventos e tempos básicos; exportação, contexto de ambiente e rastreamento ainda dependem do adaptador de telemetria.

### Qual métrica de negócio você escolheria?

A proporção de consentimentos ativos com dados atrasados, incluindo quem nunca sincronizou. Ela mostra o impacto percebido pelo cliente. Também acompanharia conclusões por instituição e dia.

Para explicar o problema, teria duração por etapa, 429 e outros erros da parceira, idade da fila, backlog, tentativas, DLQ, inserções e conflitos de unicidade, além da latência da listagem. Eu não usaria cliente ou consentimento como rótulos de métrica, porque isso cria uma quantidade excessiva de séries; esses identificadores ficam nos logs.

### Como responderia quantas sincronizações concluíram ontem?

Consultaria a tabela `sincronizacao` pelo intervalo de ontem, convertido do fuso do negócio para UTC, agrupando por instituição. Cada trabalho tem uma única conclusão registrada.

O contador de métricas é útil para operação, mas pode perder um evento se o processo cair depois do commit e antes da emissão. Se eu precisar garantir a publicação desse evento, usaria uma outbox transacional. Não usaria só o contador para um número auditável.

### Que alerta detectaria o problema antes do cliente?

Assumindo atualização prevista a cada 15 minutos, eu começaria alertando quando mais de 5% dos consentimentos ativos de uma instituição estivessem atrasados há 30 minutos, durante 10 minutos. Outra condição seria ter fila pendente e nenhuma conclusão por 15 minutos.

Também alertaria para DLQ acima de zero, 429 acima de 5% com pelo menos 100 chamadas em 5 minutos e p95 da API acima de 1 segundo por 10 minutos. São limites iniciais, que precisam ser calibrados ao volume e ao SLO. Cada alerta teria responsável e orientação de resposta.

### Uma execução que terminou agora significa que o extrato está atualizado?

Não necessariamente. Pode ser uma carga histórica que acabou agora. Eu olharia a janela coberta, não apenas a hora de conclusão.

`sincronizado_ate` guarda o maior fim de janela concluída, mas não prova que não há lacunas anteriores. O agendador precisa controlar janelas pendentes e prever sobreposição para lançamentos disponibilizados com atraso. Também não apagaria registros porque não apareceram em uma consulta parcial.

## 5. Iniciativa e prioridades

### Depois de estabilizar, o que você assumiria sem alguém pedir?

Eu levaria uma proposta curta, priorizada pelo risco:

1. **Rotacionar o segredo compartilhado e mover seu acesso para um gerenciador de segredos.** Só mudar o lugar onde ele fica não invalida cópias antigas. Usaria menor privilégio e papéis de execução.
2. **Concluir a DLQ e o procedimento de recuperação.** Isso já começaria na contenção. Precisa de retenção, alerta, responsável e reprocessamento controlado para não virar um depósito de falhas.
3. **Cobrir as regras críticas e reativar os testes do pipeline.** Eu não esperaria cobertura total para bloquear regressões de idempotência e 429.
4. **Adicionar correlação e indicadores de atualização.** O time precisa detectar o atraso e localizar a etapa que falhou.
5. **Tratar a vulnerabilidade e organizar atualizações.** Avaliaria exposição, possibilidade de exploração e correção disponível. Se houver risco crítico ou exploração, esse item sobe imediatamente para o primeiro lugar.
6. **Acordar revisão mínima mesmo nas urgências.** Teria segunda pessoa, testes mínimos, rollback e registro da decisão. Depois ampliaria a cobertura e a rotina de manutenção.

### Por que não atualizar todas as dependências imediatamente?

Porque uma atualização ampla durante um incidente também pode introduzir regressões. Eu avaliaria a vulnerabilidade concreta e faria a correção necessária, com testes e plano de retorno. Isso não significa adiar indefinidamente: as demais atualizações precisam de prazo e responsável.

### Como proporia isso sem criticar quem já está no time?

Eu começaria perguntando quais restrições levaram ao estado atual. Depois mostraria o risco e uma proposta pequena: ‘Estamos repetindo essas mensagens sem limite; podemos definir uma DLQ e um procedimento de recuperação para reduzir o impacto?’.

Eu levaria evidências, dividiria as mudanças em PRs e combinaria prioridade e responsáveis com a liderança. O objetivo é facilitar a recuperação do serviço, não procurar culpados ou prometer resolver tudo sozinho.

## 6. Uso de IA no dia a dia

### Em que partes desse cenário você usaria Claude ou Claude Code?

Eu usaria como apoio para entender um fluxo, levantar hipóteses, lembrar casos de teste, discutir uma consulta, revisar um PR e organizar documentação. Faria pedidos delimitados e validaria o resultado.

Por exemplo: ‘Explique onde este fluxo recebe a mensagem, grava os dados e confirma a fila; aponte o que acontece se falhar entre essas etapas’. Depois conferiria a explicação no código.

### Dê exemplos do que pediria para testes, SQL e revisão.

Nos testes, pediria casos de duas entregas concorrentes e de 429 depois da primeira página. Conferiria se os testes reproduzem a falha e se os mocks não escondem justamente o comportamento que preciso provar.

Para SQL, pediria uma consulta parametrizada e a justificativa do índice, mas validaria resultado, plano e consumo de recursos com dados representativos.

Na revisão de PR, pediria que procurasse confirmação antes do commit e exposição de dados sensíveis, apontando os trechos. Eu avaliaria cada achado, porque pode haver falsos positivos. Para documentação, conferiria se o texto descreve o que existe e não promete garantias ausentes.

### Onde você não confiaria apenas na resposta da ferramenta?

Em regras de identidade, dinheiro, autorização e recuperação de falha. Código pode parecer correto e ainda descartar uma compra legítima. Deduplicar por valor e data é um exemplo: funciona em casos simples, mas duas compras podem ter os mesmos campos.

Eu precisaria de testes independentes e revisão antes de produção. Se não consigo explicar por que a alteração funciona e como falha, ainda não tenho condição de aprová-la.

### E os dados bancários e os segredos nos prompts?

Eu usaria exemplos sintéticos e ferramentas aprovadas pela organização. Não colaria dados reais de contas, lançamentos, tokens ou segredos. Verificaria as regras de retenção, acesso e tratamento de dados, inclusive as obrigações de proteção de dados aplicáveis.

Com uma ferramenta que executa comandos, também limitaria permissões e acesso ao repositório necessário. Não daria acesso irrestrito a produção. A responsabilidade pela decisão continua com quem aprova a mudança.

## Considerações adicionais

### O que você colocaria em produção amanhã?

Eu não trataria este recorte como um serviço pronto. O núcleo de persistência e seus testes dão uma base, mas ainda faltam as integrações reais, autenticação, controle global de taxa, renovação de visibilidade, DLQ e exportação de telemetria.

Eu entregaria a integração em etapas, com revisão, testes no ambiente adequado, observação de métricas e possibilidade de rollback.

### Qual é a principal limitação da sua proposta?

A garantia de identidade depende do contrato da instituição. Sem um ID estável e uma regra clara para alterações, a chave única não resolve toda a reconciliação. Outra limitação é recomeçar a janela a cada falha, o que aumenta chamadas em alto volume.

Eu começaria confirmando essas premissas antes de ampliar a solução.

### Mostre no código onde estão suas garantias.

Eu começaria pela restrição única no SQL e pela inserção com `ON CONFLICT` no repositório. Depois mostraria a transação por página e a confirmação da fila somente depois de `concluir` no consumidor.

Em seguida, mostraria os testes com PostgreSQL para concorrência e para o 429 após gravação parcial. Isso liga a explicação à implementação e à evidência que a sustenta.

## Referências técnicas

- [NestJS — providers e injeção de dependências](https://docs.nestjs.com/providers)
- [PostgreSQL — INSERT e ON CONFLICT](https://www.postgresql.org/docs/18/sql-insert.html)
- [PostgreSQL — criação concorrente de índices](https://www.postgresql.org/docs/18/sql-createindex.html)
- [Amazon SQS — processamento e limite de visibilidade](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/best-practices-processing-messages-timely-manner.html)
- [Amazon SQS — ChangeMessageVisibility](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ChangeMessageVisibility.html)
