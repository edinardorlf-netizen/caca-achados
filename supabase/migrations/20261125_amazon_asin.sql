-- Ofertas da Amazon (25/11/2026): ASIN para não repetir o mesmo produto.
alter table achados_ofertas add column if not exists amz_asin text;
create unique index if not exists achados_ofertas_dono_amz_asin_key on achados_ofertas (dono, amz_asin);
