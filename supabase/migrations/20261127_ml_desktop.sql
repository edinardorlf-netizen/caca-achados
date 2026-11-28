-- Mercado Livre "Ofertas do dia" pelo robô do WhatsApp no desktop (v14), o mesmo procedimento das tarefas do notebook.
-- ml_desktop_ativo liga só a leitura do desktop (ml_preco_ativo e o cron achados-ml-buscar continuam desligados).
alter table public.achados_config
  add column if not exists ml_desktop_ativo boolean not null default false,
  add column if not exists ml_ofertas_cursor int not null default 0;   -- rodízio das páginas 1–8 (2 por vez)
alter table public.achados_config
  add column if not exists ml_desktop_teste boolean not null default false; -- true = o robô lê 1 página na próxima conferida (até 5 min) e volta a false
