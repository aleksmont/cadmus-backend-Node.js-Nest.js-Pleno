# Sincronização de lançamentos bancários

Resolução do teste técnico Backend Node.js / Nest.js Pleno. O foco é investigar o incidente e demonstrar o processamento seguro de uma mensagem de sincronização, sem montar uma aplicação completa.

- [Respostas às seis questões e aprofundamentos técnicos](AleksanderMonteiro_testetecnico.md)
- [Enunciado original](docs/BackendNodeNestPleno_TesteTecnico.docx)
- [Modelagem PostgreSQL](sql/001_modelagem.sql)
- [Consultas do extrato e de conclusões](sql/002_listagem.sql)

## Executar os testes

Requisitos: Node.js 24 e npm. PostgreSQL 18 é necessário somente para os testes de integração.

```sh
npm ci
npm test
```

Os testes unitários usam respostas HTTP e fila simuladas. Não acessam instituições financeiras, AWS ou dados reais.

Para a integração, use um banco descartável. A suíte cria um schema exclusivo e o remove ao terminar; não é preciso aplicar o SQL manualmente.

```sh
# Exemplo opcional para quem tem Docker instalado:
docker run --rm --name cadmus-postgres \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=cadmus_test \
  -p 5432:5432 -d postgres:18

TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cadmus_test npm run check

# Depois dos testes:
docker stop cadmus-postgres
```

Também é possível usar uma instalação local de PostgreSQL. `TEST_DATABASE_URL` deve apontar para esse banco; o usuário precisa de permissão para criar schemas. A configuração de exemplo está em [.env.example](.env.example), mas os comandos não carregam esse arquivo automaticamente.

`npm run build` verifica os tipos e compila. `npm test` executa a suíte unitária; `npm run test:integracao` exige o banco e falha se a configuração estiver ausente. O fluxo de CI executa ambas com PostgreSQL real.

## Organização

| Arquivo | Responsabilidade |
| --- | --- |
| `src/sincronizacao/consumidor.ts` | Orquestrar páginas, persistência, conclusão e confirmação da mensagem |
| `src/sincronizacao/normalizar.ts` | Validar mensagem, identidade, datas e representação monetária |
| `src/sincronizacao/contratos.ts` | Definir as fronteiras com instituição, banco, fila e telemetria |
| `src/sincronizacao/modulo.ts` | Registrar as dependências no Nest.js |
| `src/integracoes/parceira-http.ts` | Consultar o contrato HTTP ilustrativo e interpretar 429 |
| `src/persistencia/repositorio-postgres.ts` | Gravar páginas com transação e unicidade no banco |
| `test/` | Verificar regras, falhas e concorrência entre conexões PostgreSQL |

O módulo Nest recebe os adaptadores em `SincronizacaoModule.registrar(...)`. O teste de resolução de dependências mostra seu uso. Um listener da fila chamaria `ConsumidorSincronizacao.processar(entrega)` sem confirmação automática.

## Escopo e limites

O código contempla lançamentos efetivados e imutáveis em BRL, com identificador estável por conta. As contas e os consentimentos já estão cadastrados. A sincronização percorre uma janela fixa, com páginas estáveis segundo o contrato assumido. Essas premissas e as alternativas estão detalhadas nas respostas.

Não há API REST, listener SQS, configuração AWS, autenticação real na instituição ou exportador de métricas. Fila e telemetria são contratos, com implementações em memória nos testes. O adaptador HTTP é ilustrativo; o repositório PostgreSQL é executável e testado. Isso acompanha o pedido do enunciado de implementar apenas o núcleo.

Antes de integrar a um serviço, é necessário implementar renovação de visibilidade, limite global de requisições por instituição, DLQ e adiamento durável quando `Retry-After` não couber na visibilidade restante. A telemetria deve ser não bloqueante e não lançar erros para o fluxo de negócio. Não há garantia de processamento exatamente uma vez: o que se garante é a unicidade do lançamento persistido.

Repositório: [cadmus-backend-Node.js-Nest.js-Pleno](https://github.com/aleksmont/cadmus-backend-Node.js-Nest.js-Pleno).
