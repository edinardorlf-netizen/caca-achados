-- Mercado Livre pausado pelo dono (25/11/2026 19:10) até resolver o bloqueio.
-- As ofertas meli que estavam ativas foram guardadas aqui e marcadas como 'descartada'.
-- Para voltar: update achados_ofertas o set status = p.status from achados_ml_pausa p where o.id = p.id;
--              update achados_config set ml_preco_ativo = true; select cron.alter_job(<id de achados-ml-buscar>, active := true);
create table if not exists achados_ml_pausa (id uuid primary key, status text not null, pausado_em timestamptz default now());
alter table achados_ml_pausa enable row level security;
