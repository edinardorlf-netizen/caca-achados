-- 25/11/2026 · O Mercado Livre bloqueou os preços na API para apps de terceiros (403 em /products/{id}/items e /sites/MLB/search).
-- O robô do WhatsApp (v6, desktop, Edge via playwright-core) lê as páginas "Ofertas do dia" e as buscas com filtro
-- de desconto e manda os preços para a achados-zap (ações ml_lista_proxima / ml_lista). Risco aceito pelo dono.
create table if not exists public.achados_ml_precos (
  dono text not null, produto_id text not null, titulo text, imagem text, link_produto text,
  ml_categoria text, categoria text, posicao int, criado_em timestamptz not null default now(),
  pedido_em timestamptz not null default now(), conferido_em timestamptz, preco_por numeric, preco_de numeric, erro text,
  primary key (dono, produto_id)
);
alter table public.achados_ml_precos enable row level security;
alter table public.achados_config
  add column if not exists ml_preco_ativo boolean not null default true,
  add column if not exists ml_preco_cursor int not null default 0,
  add column if not exists ml_preco_msg text,
  add column if not exists ml_lista_cursor int not null default 0,
  add column if not exists ml_palavras text[];
update public.achados_config set ml_palavras = shp_palavras where ml_palavras is null and shp_palavras is not null;
