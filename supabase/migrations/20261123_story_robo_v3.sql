-- Robô de Stories v3: atualização sozinha (como o robô do WhatsApp) e "seguir contas" configurado no servidor.
-- O código publicado fica em story_codigo (versao, arquivos[{nome, conteudo, sha256}]); só o service role lê.
create table if not exists public.story_codigo (
  versao int primary key,
  arquivos jsonb not null,
  nota text,
  criado_em timestamptz not null default now()
);
alter table public.story_codigo enable row level security;

-- Seguir contas: perfis de referência (separados por vírgula; vazio = desligado), meta por dia (0 a 30) e horário.
alter table public.achados_config
  add column if not exists ig_seguir_perfis text not null default '',
  add column if not exists ig_seguir_qtd int not null default 25,
  add column if not exists ig_seguir_hora_ini int not null default 9,
  add column if not exists ig_seguir_hora_fim int not null default 21;
alter table public.achados_config drop constraint if exists achados_config_ig_seguir_qtd_check,
  add constraint achados_config_ig_seguir_qtd_check check (ig_seguir_qtd between 0 and 30);
