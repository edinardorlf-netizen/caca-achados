# Caça Achados · um sistema Auraxis

Fila de promoções de afiliado (Shopee, Mercado Livre, Amazon, TikTok Shop) com posts prontos para
WhatsApp, Telegram, TikTok/Instagram e roteiro de live, do perfil **O Cara dos Achados**.

- Página estática (GitHub Pages): `index.html`, `estilo.css`, `app.js`, `config.js`.
- Banco: Supabase (tabelas `achados_*`, acesso só do dono).
- `supabase/functions/achados-ml`: conexão com o Mercado Livre (OAuth só leitura) e busca dos
  mais vendidos com desconto, a cada 3 horas.
