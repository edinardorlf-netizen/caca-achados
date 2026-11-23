-- 21/11/2026 · Robô de Stories (desktop, Python/instagrapi): posta os Stories com a figurinha de link.
-- Não oficial: o dono aceitou o risco de bloqueio da conta. Usa a mesma chave do robô do WhatsApp
-- (x-zap-key) na função achados-story (ações story_proximas, story_teste, story_confirmar, story_aviso).
alter table public.achados_config
  add column if not exists ig_robo_ativo boolean not null default false,
  add column if not exists ig_qtd int not null default 5,
  add column if not exists ig_rodada_em timestamptz;
alter table public.achados_config drop constraint if exists achados_config_ig_qtd_check,
  add constraint achados_config_ig_qtd_check check (ig_qtd between 1 and 10);
-- achados_proteger_config: em pausa por falta de pagamento também desliga ig_robo_ativo.

-- 23/11/2026 · Telegram parado; avisos dos robôs vão para o WhatsApp particular do dono (migração avisos_no_whatsapp).
alter table public.achados_config add column if not exists zap_aviso_numero text
  check (zap_aviso_numero is null or zap_aviso_numero ~ '^[0-9]{10,15}$');
