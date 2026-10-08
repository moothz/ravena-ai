-- Reconciliação e Unificação de Contas Duplicadas (@s.whatsapp.net -> ID limpo)
BEGIN;

-- 1. Para contas duplicadas onde o ID limpo JÁ EXISTE:
-- 1a. Transferir harem_entries para a conta limpa
UPDATE harem_entries h
SET "userId" = split_part(h."userId", '@', 1)
WHERE h."userId" LIKE '%@%'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = split_part(h."userId", '@', 1));

-- 1b. Transferir kakera_transactions para a conta limpa
UPDATE kakera_transactions kt
SET "userId" = split_part(kt."userId", '@', 1)
WHERE kt."userId" LIKE '%@%'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = split_part(kt."userId", '@', 1));

-- 1c. Em user_groups, deletar pares duplicados onde o usuário limpo já está associado ao grupo
DELETE FROM user_groups ug
WHERE ug."userId" LIKE '%@%'
  AND EXISTS (
    SELECT 1 FROM user_groups ug_clean 
    WHERE ug_clean."userId" = split_part(ug."userId", '@', 1) 
      AND ug_clean."groupId" = ug."groupId"
  );

-- 1d. Atualizar os grupos restantes para a conta limpa
UPDATE user_groups ug
SET "userId" = split_part(ug."userId", '@', 1)
WHERE ug."userId" LIKE '%@%'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = split_part(ug."userId", '@', 1));

-- 1e. Somar saldo de kakera das contas duplicadas para a conta limpa
UPDATE users u_clean
SET kakera = u_clean.kakera + COALESCE(dup_sum.total_kakera, 0)
FROM (
    SELECT split_part(id, '@', 1) AS clean_id, SUM(kakera) AS total_kakera
    FROM users
    WHERE id LIKE '%@%'
    GROUP BY split_part(id, '@', 1)
) dup_sum
WHERE u_clean.id = dup_sum.clean_id;

-- 1f. Deletar os usuários duplicados com @ cujos IDs limpos já existem
DELETE FROM users u_dup
WHERE u_dup.id LIKE '%@%'
  AND EXISTS (SELECT 1 FROM users u_clean WHERE u_clean.id = split_part(u_dup.id, '@', 1));

-- 2. Para contas onde o ID limpo NÃO existia (ex: testes de roll), atualizar diretamente o ID do usuário
-- O ON UPDATE CASCADE atualizará automaticamente as tabelas filhas restantes
UPDATE users
SET id = split_part(id, '@', 1)
WHERE id LIKE '%@%';

COMMIT;
