-- Esquema inicial. Migração de uma base existente exige saneamento prévio.
CREATE TABLE consentimento (
    id uuid PRIMARY KEY,
    cliente_id uuid NOT NULL,
    instituicao_id text NOT NULL,
    id_externo text NOT NULL,
    status text NOT NULL CHECK (status IN ('ATIVO', 'REVOGADO', 'EXPIRADO')),
    valido_ate timestamptz NOT NULL,
    sincronizado_ate timestamptz,
    ultima_sincronizacao_em timestamptz,
    UNIQUE (cliente_id, instituicao_id, id_externo),
    UNIQUE (id, cliente_id, instituicao_id)
);

CREATE TABLE conta (
    id uuid PRIMARY KEY,
    cliente_id uuid NOT NULL,
    instituicao_id text NOT NULL,
    id_externo text NOT NULL,
    UNIQUE (cliente_id, instituicao_id, id_externo),
    UNIQUE (id, cliente_id),
    UNIQUE (id, cliente_id, instituicao_id)
);

-- Uma renovação não cria uma nova identidade para a mesma conta.
CREATE TABLE consentimento_conta (
    consentimento_id uuid NOT NULL,
    conta_id uuid NOT NULL,
    cliente_id uuid NOT NULL,
    instituicao_id text NOT NULL,
    PRIMARY KEY (consentimento_id, conta_id),
    FOREIGN KEY (consentimento_id, cliente_id, instituicao_id)
        REFERENCES consentimento (id, cliente_id, instituicao_id),
    FOREIGN KEY (conta_id, cliente_id, instituicao_id)
        REFERENCES conta (id, cliente_id, instituicao_id)
);

CREATE TABLE lancamento (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conta_id uuid NOT NULL,
    cliente_id uuid NOT NULL,
    id_externo text NOT NULL,
    valor numeric(18, 2) NOT NULL,
    moeda char(3) NOT NULL CHECK (moeda = 'BRL'),
    ocorrido_em timestamptz NOT NULL,
    descricao text NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (conta_id, cliente_id) REFERENCES conta (id, cliente_id),
    UNIQUE (conta_id, id_externo)
);

CREATE INDEX lancamento_extrato_idx ON lancamento (cliente_id, ocorrido_em DESC, id DESC);

-- Uma linha por conclusão lógica, independentemente da quantidade de entregas.
CREATE TABLE sincronizacao (
    consentimento_id uuid NOT NULL REFERENCES consentimento (id),
    id uuid NOT NULL,
    de timestamptz NOT NULL,
    ate timestamptz NOT NULL,
    concluida_em timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (consentimento_id, id),
    CHECK (de < ate)
);
CREATE INDEX sincronizacao_concluida_idx ON sincronizacao (concluida_em);
