-- Assinaturas: a compra na Kiwify libera o acesso sozinha, e a falta de pagamento pausa as automações sozinha.
-- Regra: com acesso pago → tudo ligado. Acabou o período pago → 7 dias de tolerância → automações pausadas
-- (o cliente continua entrando no app e vendo os dados, mas nada é buscado nem postado). Pagou de novo → volta como estava.

alter table public.achados_donos
  add column if not exists plano      text not null default 'base',   -- base | robo
  add column if not exists status     text not null default 'ativo',  -- ativo | atrasado | cancelado | reembolsado | vitalicio
  add column if not exists acesso_ate timestamptz,                    -- fim do período pago (vem da Kiwify)
  add column if not exists origem     text,                           -- kiwify | manual
  add column if not exists assinatura_id text,
  add column if not exists nome       text,
  add column if not exists pausado    jsonb,                          -- como estavam as automações antes da pausa
  add column if not exists atualizado_em timestamptz not null default now();

alter table public.achados_donos
  drop constraint if exists achados_donos_plano_check,
  add constraint achados_donos_plano_check check (plano in ('base', 'robo')),
  drop constraint if exists achados_donos_status_check,
  add constraint achados_donos_status_check check (status in ('ativo', 'atrasado', 'cancelado', 'reembolsado', 'vitalicio'));

-- O dono do sistema (cliente nº 1) nunca vence.
update public.achados_donos set status = 'vitalicio', plano = 'robo', origem = 'manual' where email = 'edinardorlf@gmail.com';

-- Registro de tudo o que a Kiwify mandou (para conferir e não processar o mesmo aviso duas vezes).
create table if not exists public.achados_kiwify_eventos (
  id bigint generated always as identity primary key,
  chave text unique,              -- order_id/subscription_id + tipo do evento
  tipo text,
  email text,
  corpo jsonb,
  resultado text,
  recebido_em timestamptz not null default now()
);
alter table public.achados_kiwify_eventos enable row level security;  -- sem políticas: só o servidor lê

-- Os 7 dias de tolerância.
create or replace function public.achados_tem_acesso(d public.achados_donos)
returns boolean language sql stable as $$
  select d.status = 'vitalicio'
      or (d.status in ('ativo', 'atrasado', 'cancelado') and (d.acesso_ate is null or d.acesso_ate + interval '7 days' > now()));
$$;

-- Aplica a regra para um cliente: pausa (guardando como estava) ou devolve tudo como era.
create or replace function public.achados_assinatura_aplicar(p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare d achados_donos; c achados_config; v_ok boolean;
begin
  select * into d from achados_donos where email = lower(p_email);
  if d is null then return 'sem cadastro'; end if;
  insert into achados_config(dono) values (d.email) on conflict (dono) do nothing;
  select * into c from achados_config where dono = d.email;
  v_ok := achados_tem_acesso(d);

  if v_ok then
    if d.pausado is not null then
      update achados_config set
        tg_ativo = coalesce((d.pausado->>'tg_ativo')::boolean, tg_ativo),
        shp_ativo = coalesce((d.pausado->>'shp_ativo')::boolean, shp_ativo),
        ml_conectado = coalesce((d.pausado->>'ml_conectado')::boolean, ml_conectado),
        ig_ativo = coalesce((d.pausado->>'ig_ativo')::boolean, ig_ativo),
        alerta_ativo = coalesce((d.pausado->>'alerta_ativo')::boolean, alerta_ativo),
        wa_ativo = coalesce((d.pausado->>'wa_ativo')::boolean, wa_ativo),
        zap_ativo = coalesce((d.pausado->>'zap_ativo')::boolean, zap_ativo)
      where dono = d.email;
      update achados_donos set pausado = null, atualizado_em = now() where email = d.email;
    end if;
    -- complemento do robô acompanha o plano (o dono vitalício mantém o que já tem)
    if d.status <> 'vitalicio' then
      update achados_config set rec_robo = (d.plano = 'robo') where dono = d.email and rec_robo is distinct from (d.plano = 'robo');
    end if;
    return 'ativo';
  end if;

  if d.pausado is null then
    update achados_donos set pausado = jsonb_build_object(
      'tg_ativo', c.tg_ativo, 'shp_ativo', c.shp_ativo, 'ml_conectado', c.ml_conectado, 'ig_ativo', c.ig_ativo,
      'alerta_ativo', c.alerta_ativo, 'wa_ativo', c.wa_ativo, 'zap_ativo', c.zap_ativo), atualizado_em = now()
    where email = d.email;
  end if;
  update achados_config set tg_ativo = false, shp_ativo = false, ml_conectado = false, ig_ativo = false,
    alerta_ativo = false, wa_ativo = false, zap_ativo = false, rec_robo = false
  where dono = d.email;
  return 'pausado';
end $$;
revoke all on function public.achados_assinatura_aplicar(text) from public, anon, authenticated;

-- Roda para todos (de hora em hora): é o que pausa quem passou dos 7 dias sem aviso novo da Kiwify.
create or replace function public.achados_assinaturas_rodar()
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select email from achados_donos where status <> 'vitalicio' loop
    perform achados_assinatura_aplicar(r.email);
  end loop;
end $$;
revoke all on function public.achados_assinaturas_rodar() from public, anon, authenticated;

select cron.unschedule('achados-assinaturas') where exists (select 1 from cron.job where jobname = 'achados-assinaturas');
select cron.schedule('achados-assinaturas', '7 * * * *', $$select public.achados_assinaturas_rodar()$$);

-- Enquanto pausado, o cliente não consegue religar as automações pelo app.
create or replace function public.achados_proteger_config()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.rec_robo := old.rec_robo;
    new.rec_estudio := old.rec_estudio;
    new.zap_chave_hash := old.zap_chave_hash;
    if exists (select 1 from achados_donos where email = old.dono and pausado is not null) then
      new.tg_ativo := false; new.shp_ativo := false; new.ml_conectado := old.ml_conectado; new.ig_ativo := false;
      new.alerta_ativo := false; new.wa_ativo := false; new.zap_ativo := false;
    end if;
  end if;
  return new;
end $$;

-- O app pergunta a situação da assinatura para mostrar o aviso no topo.
create or replace function public.achados_minha_assinatura()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('plano', d.plano, 'status', d.status, 'acesso_ate', d.acesso_ate,
                            'pausado', d.pausado is not null, 'tolerancia_ate', d.acesso_ate + interval '7 days')
    from achados_donos d where d.email = public.achados_eu();
$$;
revoke all on function public.achados_minha_assinatura() from public, anon;
grant execute on function public.achados_minha_assinatura() to authenticated;

-- Correção: achados_donos não é visível pelo cliente (RLS), então a trava usa uma função com permissão do servidor.
create or replace function public.achados_esta_pausado(p_email text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from achados_donos where email = p_email and pausado is not null);
$$;
revoke all on function public.achados_esta_pausado(text) from public, anon;
grant execute on function public.achados_esta_pausado(text) to authenticated;

create or replace function public.achados_proteger_config()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.rec_robo := old.rec_robo;
    new.rec_estudio := old.rec_estudio;
    new.zap_chave_hash := old.zap_chave_hash;
    if public.achados_esta_pausado(old.dono) then
      new.tg_ativo := false; new.shp_ativo := false; new.ml_conectado := old.ml_conectado; new.ig_ativo := false;
      new.alerta_ativo := false; new.wa_ativo := false; new.zap_ativo := false;
    end if;
  end if;
  return new;
end $$;

-- Teste (só o servidor): envia um aviso falso assinado com o token, para conferir a função achados-kiwify.
create or replace function public.achados_teste_kiwify(body jsonb) returns bigint language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := 'https://airbtbqorhrrzqhucmzu.supabase.co/functions/v1/achados-kiwify?signature=' || encode(hmac(body::text, (select valor from segredos where chave='kiwify_webhook'), 'sha1'), 'hex'),
    body := body, headers := '{"Content-Type":"application/json"}'::jsonb);
$$;
revoke all on function public.achados_teste_kiwify(jsonb) from public, anon, authenticated;

-- 19/11/2026 · Mensagens em particular pelo robô do WhatsApp (ex.: prévia das ofertas no celular do dono).
-- Tabela achados_zap_privadas (dono, numero, oferta|texto, enviado_em, erro); vão junto na resposta "proximas"
-- e o robô confirma com a ação "confirmar_privada". Robô v4 (zap_codigo) manda essas mensagens e
-- confere atualização a cada 30 min. Migração aplicada: zap_mensagens_privadas.
