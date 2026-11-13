# Caça Achados · um sistema Auraxis

Fila de promoções de afiliado (Shopee, Mercado Livre, Amazon, TikTok Shop) com posts prontos para
WhatsApp, Telegram, TikTok/Instagram e roteiro de live.

Vendido como produto: cada cliente tem a própria conta, a própria marca (Ajustes > Sua marca) e as
próprias contas de afiliado, canais e bot. O cliente nº 1 é o perfil **O Cara dos Achados** (logo em `marcas/`).
Complementos por conta (`achados_config.rec_robo`, `rec_estudio`): robô do WhatsApp e Estúdio IA
(em desenvolvimento). Só o administrador liga um complemento; o próprio cliente não consegue.

- Página estática (GitHub Pages): `index.html`, `estilo.css`, `app.js`, `config.js`.
- Banco: projeto Supabase próprio "caca-achados" (separado do LicitaPro), acesso só do dono.
- `supabase/functions/achados-ml`: conexão com o Mercado Livre (OAuth só leitura) e busca dos
  mais vendidos com desconto, a cada 3 horas.
