-- Vitrine (26/11/2026): passa a mostrar também as ofertas postadas no grupo do WhatsApp nos últimos 7 dias
-- (wa_avisado_em), para as ofertas da Amazon aparecerem com o link de associado (pedido para a aprovação da conta Amazon).
CREATE OR REPLACE FUNCTION public.achados_vitrine(p_slug text)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with c as (select dono, vit_slug, vit_telegram, vit_whatsapp, vit_instagram, vit_tiktok, assinatura, vit_logo from achados_config where vit_slug = lower(p_slug))
  select jsonb_build_object(
    'perfil', (select jsonb_build_object('slug', vit_slug, 'nome', assinatura, 'logo', vit_logo, 'telegram', vit_telegram, 'whatsapp', vit_whatsapp, 'instagram', vit_instagram, 'tiktok', vit_tiktok) from c),
    'ofertas', coalesce((
      select jsonb_agg(x order by x.quando desc) from (
        select o.id, o.num, o.titulo, o.marketplace, o.categoria, o.preco_de, o.preco_por, o.cupom, o.imagem, o.link, o.validade,
               greatest(o.postado_em, o.wa_avisado_em, o.ig_postado_em, o.story_em, o.alerta_em, o.story_gerado_em, o.atualizado_em) as quando
          from achados_ofertas o join c on o.dono = c.dono
         where o.link is not null and o.exemplo = false and o.status <> 'descartada'
           and (o.validade is null or o.validade >= current_date)
           and ((o.status = 'postada' and o.postado_em > now() - interval '7 days')
                or o.status = 'aprovada'
                or o.wa_avisado_em > now() - interval '7 days'
                or o.ig_postado_em > now() - interval '7 days'
                or o.story_em > now() - interval '7 days'
                or o.alerta_em > now() - interval '7 days'
                or o.story_gerado_em > now() - interval '7 days')
         order by 12 desc
         limit 120) x), '[]'::jsonb));
$function$;
