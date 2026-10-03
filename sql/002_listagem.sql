-- Primeira página: $1 vem da identidade autenticada; $2/$3 são o intervalo [de, ate).
-- Buscar 51 registros, devolver 50 e usar o excedente apenas para indicar próxima página.
SELECT id, conta_id, valor, moeda, ocorrido_em, descricao
FROM lancamento
WHERE cliente_id = $1
  AND ocorrido_em >= $2::timestamptz
  AND ocorrido_em < $3::timestamptz
ORDER BY ocorrido_em DESC, id DESC
LIMIT 51;

-- Páginas seguintes: $4/$5 são data e id do último registro devolvido.
SELECT id, conta_id, valor, moeda, ocorrido_em, descricao
FROM lancamento
WHERE cliente_id = $1
  AND ocorrido_em >= $2::timestamptz
  AND ocorrido_em < $3::timestamptz
  AND (ocorrido_em, id) < ($4::timestamptz, $5::bigint)
ORDER BY ocorrido_em DESC, id DESC
LIMIT 51;

-- Contagem auditável de conclusões no intervalo; não depende de entrega de métricas.
SELECT c.instituicao_id, count(*) AS sincronizacoes_concluidas
FROM sincronizacao s
JOIN consentimento c ON c.id = s.consentimento_id
WHERE s.concluida_em >= $1::timestamptz AND s.concluida_em < $2::timestamptz
GROUP BY c.instituicao_id;
