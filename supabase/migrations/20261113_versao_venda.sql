-- Versão para venda: cada cliente com a própria marca, a própria chave do robô e complementos ligados por conta.
-- Só acrescenta. O cliente nº 1 (dono atual) recebe os mesmos valores que já saem hoje, então nada muda para ele.

alter table public.achados_config
  add column if not exists assinatura  text,                            -- nome que assina as mensagens (ex.: "O Cara dos Achados")
  add column if not exists hashtag     text,                            -- hashtag da marca, sem o # (ex.: "ocaradosachados")
  add column if not exists rec_robo    boolean not null default false,  -- complemento: robô do WhatsApp
  add column if not exists rec_estudio boolean not null default false,  -- complemento: Estúdio IA (em desenvolvimento)
  add column if not exists zap_chave_hash text;                         -- só o hash da chave do robô; a chave em si nunca fica guardada

create unique index if not exists achados_config_zap_chave_hash_key
  on public.achados_config (zap_chave_hash) where zap_chave_hash is not null;

-- Complementos e chave do robô não podem ser alterados pelo próprio cliente pelo app.
-- Só as funções do servidor (e quem administra) mudam esses campos.
create or replace function public.achados_proteger_config()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.rec_robo := old.rec_robo;
    new.rec_estudio := old.rec_estudio;
    new.zap_chave_hash := old.zap_chave_hash;
  end if;
  return new;
end $$;

drop trigger if exists achados_proteger_config on public.achados_config;
create trigger achados_proteger_config before update on public.achados_config
  for each row execute function public.achados_proteger_config();

-- Cliente nº 1: mantém a marca e os dois complementos, e a chave atual do robô passa a ser dele.
update public.achados_config
   set assinatura = coalesce(assinatura, 'O Cara dos Achados'),
       hashtag    = coalesce(hashtag, 'ocaradosachados'),
       rec_robo = true, rec_estudio = true
 where dono = 'edinardorlf@gmail.com';

update public.achados_config c
   set zap_chave_hash = encode(extensions.digest(s.valor, 'sha256'), 'hex')
  from public.segredos s
 where s.chave = 'zap' and c.dono = 'edinardorlf@gmail.com' and c.zap_chave_hash is null;

-- Gera uma chave nova do robô para o cliente logado. Devolve a chave uma única vez; só o hash fica guardado.
-- Gerar de novo desliga o robô que estiver usando a chave anterior.
create or replace function public.achados_gerar_chave_robo()
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_eu text := public.achados_eu(); v_chave text;
begin
  if v_eu is null then raise exception 'Acesso não liberado ao Caça Achados'; end if;
  if not coalesce((select rec_robo from achados_config where dono = v_eu), false) then
    raise exception 'O robô do WhatsApp é um complemento e não está ativo na sua conta.';
  end if;
  v_chave := encode(gen_random_bytes(24), 'hex');
  update achados_config set zap_chave_hash = encode(digest(v_chave, 'sha256'), 'hex') where dono = v_eu;
  return v_chave;
end $$;
revoke all on function public.achados_gerar_chave_robo() from public, anon;
grant execute on function public.achados_gerar_chave_robo() to authenticated;

-- A chave da IA ainda é uma só (Estúdio em desenvolvimento): só quem tem o complemento pode ver ou trocar.
create or replace function public.achados_ia_status()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from achados_config where dono = public.achados_eu() and rec_estudio)
     and exists (select 1 from segredos where chave = 'anthropic');
$$;

create or replace function public.achados_salvar_ia(p_chave text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from achados_config where dono = public.achados_eu() and rec_estudio) then
    raise exception 'O Estúdio IA ainda está em desenvolvimento e não está ativo na sua conta.';
  end if;
  delete from segredos where chave = 'anthropic';
  if p_chave is not null and length(trim(p_chave)) > 0 then
    insert into segredos(chave, valor) values ('anthropic', trim(p_chave));
  end if;
end $$;

-- Vitrine pública: passa a mandar a assinatura do cliente para o título da página.
create or replace function public.achados_vitrine(p_slug text)
returns jsonb language sql stable security definer set search_path = public as $$
  with c as (select dono, vit_slug, vit_telegram, vit_whatsapp, vit_instagram, vit_tiktok, assinatura from achados_config where vit_slug = lower(p_slug))
  select jsonb_build_object(
    'perfil', (select jsonb_build_object('slug', vit_slug, 'nome', assinatura, 'telegram', vit_telegram, 'whatsapp', vit_whatsapp, 'instagram', vit_instagram, 'tiktok', vit_tiktok) from c),
    'ofertas', coalesce((
      select jsonb_agg(x order by x.quando desc) from (
        select o.id, o.num, o.titulo, o.marketplace, o.categoria, o.preco_de, o.preco_por, o.cupom, o.imagem, o.link, o.validade,
               greatest(o.postado_em, o.ig_postado_em, o.story_em, o.alerta_em, o.story_gerado_em, o.atualizado_em) as quando
          from achados_ofertas o join c on o.dono = c.dono
         where o.link is not null and o.exemplo = false and o.status <> 'descartada'
           and (o.validade is null or o.validade >= current_date)
           and ((o.status = 'postada' and o.postado_em > now() - interval '7 days')
                or o.status = 'aprovada'
                or o.ig_postado_em > now() - interval '7 days'
                or o.story_em > now() - interval '7 days'
                or o.alerta_em > now() - interval '7 days'
                or o.story_gerado_em > now() - interval '7 days')
         order by 12 desc
         limit 120) x), '[]'::jsonb));
$$;

-- Cada cliente preenche a própria marca e o endereço da vitrine pelo app.
alter table public.achados_config
  add constraint achados_config_assinatura_check check (assinatura is null or char_length(trim(assinatura)) between 2 and 40),
  add constraint achados_config_hashtag_check check (hashtag is null or hashtag ~ '^[a-z0-9_]{2,30}$');
grant update (assinatura, hashtag, vit_slug) on public.achados_config to authenticated;

-- Cliente novo: cria a linha de configuração no primeiro acesso (o app chama ao entrar).
create or replace function public.achados_garantir_config()
returns void language plpgsql security definer set search_path = public as $$
declare v_eu text := public.achados_eu();
begin
  if v_eu is null then raise exception 'Acesso não liberado ao Caça Achados'; end if;
  insert into achados_config(dono) values (v_eu) on conflict (dono) do nothing;
end $$;
revoke all on function public.achados_garantir_config() from public, anon;
grant execute on function public.achados_garantir_config() to authenticated;

-- Logo opcional da marca na Vitrine (link https de uma imagem). O cliente nº 1 mantém o logo atual.
-- (Esta etapa também recriou achados_vitrine para devolver 'logo' no perfil.)
alter table public.achados_config
  add column if not exists vit_logo text,
  add constraint achados_config_vit_logo_check check (vit_logo is null or vit_logo ~ '^https://');
grant update (vit_logo) on public.achados_config to authenticated;
update public.achados_config set vit_logo = 'https://edinardorlf-netizen.github.io/caca-achados/marcas/ocaradosachados.png'
 where dono = 'edinardorlf@gmail.com' and vit_logo is null;
