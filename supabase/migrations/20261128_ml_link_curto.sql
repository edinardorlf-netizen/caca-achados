-- 28/11/2026, pedido do dono: link de afiliado do Mercado Livre mais curto.
-- As "Ofertas do dia" trazem o endereço com o nome do produto (177–191 caracteres). O link postado passa a usar a forma curta,
-- conferida no Chrome do dono (abre o mesmo anúncio e mantém os parâmetros de afiliado no redirecionamento):
--   www.mercadolivre.com.br/<nome>/p/MLB123   → www.mercadolivre.com.br/p/MLB123
--   www.mercadolivre.com.br/<nome>/up/MLBU123 → www.mercadolivre.com.br/up/MLBU123
--   produto.mercadolivre.com.br/MLB-123-<nome>-_JM → produto.mercadolivre.com.br/MLB-123-_JM
-- link_produto fica como veio; só o `link` muda.
create or replace function public.achados_ml_link_curto(p text)
returns text language sql immutable as $$
  select case
    when p ~ '^https://www\.mercadolivre\.com\.br/[^/?#]+/(p|up)/'
      then regexp_replace(p, '^https://www\.mercadolivre\.com\.br/[^/?#]+/(p|up)/', 'https://www.mercadolivre.com.br/\1/')
    when p ~ '^https://produto\.mercadolivre\.com\.br/MLB-\d+-[^?#]*_JM'
      then regexp_replace(p, '^(https://produto\.mercadolivre\.com\.br/MLB-\d+)-[^?#]*_JM', '\1-_JM')
    else p end
$$;

create or replace function public.achados_aplicar_afiliado(p_dono text)
returns integer language plpgsql security definer set search_path to 'public' as $function$
declare n int;
begin
  update achados_ofertas o
     set link = achados_ml_link_curto(o.link_produto)
                || case when position('?' in achados_ml_link_curto(o.link_produto)) > 0 then '&' else '?' end || c.ml_afiliado_query,
         link_auto = true
    from achados_config c
   where c.dono = p_dono and o.dono = p_dono and o.marketplace = 'meli'
     and o.link_produto is not null and coalesce(c.ml_afiliado_query,'') <> ''
     and (o.link is null or o.link_auto) and o.status in ('nova','aprovada');
  get diagnostics n = row_count;
  return n;
end $function$;

-- Corrige a fila que já existe.
select achados_aplicar_afiliado(dono) from achados_config;
