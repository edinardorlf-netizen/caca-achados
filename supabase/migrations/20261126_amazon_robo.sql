-- Amazon pelo robô do WhatsApp (v12): o desktop abre amazon.com.br/deals no Chrome do robô e manda os cards
-- para a achados-zap (amz_lista_proxima / amz_lista / amz_bloqueio). As tarefas do notebook continuam valendo;
-- o índice único (dono, amz_asin) evita duplicar.
alter table public.achados_config
  add column if not exists amz_ativo boolean not null default true,  -- false = o robô não abre a Amazon
  add column if not exists amz_cursor int not null default 0,         -- rodízio: /deals, início 60, 120, 180
  add column if not exists amz_msg text;                              -- última leitura / bloqueio (aparece no app)
