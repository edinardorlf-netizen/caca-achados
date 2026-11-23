# Caça Achados · um sistema Auraxis — guia para o Claude Code

Leia isto primeiro. É a passagem de bastão das conversas no claude.ai para o Claude Code.
Idioma: português do Brasil. Respostas ao dono: curtas, dizendo o que ficou pronto e o próximo passo.

## Quem usa e para quê
- Dono: Edinardo (edinardorlf@gmail.com). Perfil de afiliado **O Cara dos Achados** (grupo de WhatsApp
  "Cara dos Achados", canal no Telegram, TikTok @ocaradosachados01, Instagram).
- O Caça Achados é uma fila de promoções de afiliado (Shopee, Mercado Livre, Amazon, TikTok Shop) que busca
  ofertas sozinha e posta pronto em WhatsApp, Telegram, Stories do Instagram e Vitrine.
- O dono é o cliente nº 1 (status `vitalicio`). O sistema também vai ser **vendido** (assinatura pela Kiwify).

## Onde está cada coisa
- App (GitHub Pages): https://edinardorlf-netizen.github.io/caca-achados/ — `index.html`, `app.js`, `estilo.css`,
  `config.js`, `vitrine.html` (vitrine pública com os achados por código #N). Sem build: edite e publique.
  Ao mudar `app.js`, suba a versão no `index.html` (`app.js?v=N`) para furar o cache.
- Banco: Supabase **caca-achados** (id `airbtbqorhrrzqhucmzu`), separado do LicitaPro. Tabelas:
  `achados_donos` (clientes, plano, status, acesso_ate, pausado), `achados_config` (tudo de cada cliente),
  `achados_ofertas`, `achados_cupons`, `achados_campanha`, `achados_zap_privadas`, `achados_kiwify_eventos`,
  `zap_codigo` (código publicado do robô do WhatsApp), `segredos` (cofre), `est_produtos`.
- Funções (pasta `supabase/functions`, todas com verify_jwt = false e autenticação própria):
  - `achados-shopee` — busca na API de afiliados da Shopee (assinatura SHA256 appId+ts+body+secret; credenciais
    por `achados_shp_segredo(dono)`). Erro 10000 é intermitente: tentar de novo.
  - `achados-ml` — Mercado Livre (OAuth só leitura), mais vendidos com desconto.
  - `achados-zap` — API do robô do WhatsApp (cabeçalho `x-zap-key`; no banco só o hash em `zap_chave_hash`):
    `proximas`, `confirmar`, `privadas`, `confirmar_privada`, `atualizacao`, `novo_grupo`, `erro`; vigia (cron).
  - `achados-story` — artes dos Stories (satori + resvg, `arte.ts`), Story por API oficial ("LINK NA BIO"),
    avisos no Telegram (achadão, Hora do WhatsApp) e o **robô de Stories** (`x-zap-key`: `story_proximas`,
    `story_teste`, `story_confirmar`, `story_aviso`).
  - `achados-kiwify` — webhook da Kiwify (HMAC-SHA1 do corpo cru com o token em `segredos.kiwify_webhook`,
    `?signature=`); libera, renova e pausa. Hoje o token é de TESTE: o dono ainda vai criar a conta na Kiwify.
  - `achados-estudio` — Estúdio IA (complemento, "em desenvolvimento").
  - O `index.ts` completo é o que vai ao ar (deploy pelo MCP do Supabase ou `supabase functions deploy`).
- Migrações: `supabase/migrations` (as recentes; parte do esquema antigo foi aplicada direto no banco).
- Crons (pg_cron): achados-shopee-buscar (:50), achados-ml-buscar (:20), achados-postar (*/10),
  achados-story-postar (5-59/10), achados-zap-vigia (2-59/5), achados-assinaturas (:07), campanhas de
  brinquedos e festas (busca/processa de 20 em 20 min, 9h–23h; terminam sozinhas em 23/12).
- `pg_net`: o `net.http_post` só dispara depois do commit. Faça a chamada e leia `net._http_response` em
  consultas separadas.

## Robô do WhatsApp (`robo-whatsapp/`)
- Node + Baileys. Roda **só no desktop** (Windows Server), em `C:\LicitaPro\robo-zap-achados`, num número
  que NÃO é o principal. Nunca ligar o mesmo número em dois computadores.
- `INICIAR.bat`/`INICIAR-LOG.bat` em laço: `atualizar.js` → `robo.js` → religa em 10 s. `INICIAR-OCULTO.vbs` não
  abre um segundo robô. `AGENDAR.ps1`: tarefa "Robo Achados - Ligar" (diária + ao entrar no Windows), sem
  hibernar (o robô de lances do LicitaPro roda no mesmo computador).
- **Atualização sozinha:** o código publicado fica em `zap_codigo` (versao, arquivos[{nome, conteudo, sha256}];
  o atualizador só aceita `robo.js` e `package.json`). O robô confere a cada 30 min entre rodadas e reinicia.
  Para publicar: insira a versão nova em `zap_codigo` com o sha256 certo. **Versão atual: 5** (sha 79fa5656…).
  `robo-whatsapp/robo.js` = v5.
- Agenda (no servidor): das **6h às 4h** da manhã seguinte, 20 ofertas a cada 45 min, pausa de 25–70 s.
  Campanhas até 22/12: em cada 20, 5 brinquedos + 10 de Natal/formatura + 5 normais (mesma proporção no Telegram).
- v5: mensagens em **particular** (tabela `achados_zap_privadas`: dono, numero, oferta jsonb | texto) saem
  em até 20 s, mesmo no meio de uma rodada; o número é conferido no WhatsApp com e sem o 9 extra.
  Para mandar ofertas a alguém: insira linhas com `oferta` = {marketplace, titulo, preco_por, preco_de, link,
  imagem} (o texto sai no formato do grupo). Número do dono: 553897412120.
- Vigia: mais de 10 min sem sinal no horário → aviso "parou"/"voltou" no Telegram do dono.
- Atenção: o `PARAR.bat` do robô do WhatsApp mata todos os `node.exe` (inclusive o robô de lances).

## Robô de Stories do Instagram (`robo-stories/`)
- Python + **instagrapi (não oficial)**: posta Stories com a **figurinha de link** na conta principal.
  O dono aceitou o risco de bloqueio (21/11/2026). Senha não fica guardada, só `sessao-instagram.json`.
- Usa a mesma chave do robô do WhatsApp. Agenda em `achados_config`: `ig_robo_ativo` (ligado), `ig_qtd` = 5,
  `ig_intervalo_min` = 120, `ig_hora_ini`/`ig_hora_fim` = 9–21, `ig_desconto_min` = 30, `ig_rodada_em`.
  Um Story a cada 4–9 min; figurinha em x 0,50 / y 0,80 (sobre o quadro "TOQUE NO LINK AQUI").
- Login caiu → avisa no WhatsApp particular e espera o `CONECTAR-INSTAGRAM.bat`; bloqueio → espera 6 h.
- Situação em 23/11: pacote pronto; o dono vai instalar no desktop em `C:\LicitaPro\robo-stories`.
  Falta: instalar, login (o dono digita), `TESTE-STORY.bat` para conferir a posição da figurinha, ligar.
- Stories pela API oficial (`ig_ativo` + token da Meta) também existem, mas o token nunca foi conectado.

## Telegram desligado (23/11/2026)
- O dono decidiu **trabalhar só com o WhatsApp por enquanto**: `tg_ativo` = false (nada é postado no canal do
  Telegram), `alerta_ativo` = false (o aviso de achadão para Story à mão saiu; o robô de Stories faz isso) e
  `vit_telegram` = null (o link do Telegram saiu do rodapé das mensagens; era https://t.me/ocaradosachados).
- Avisos dos robôs (grupo novo criado, robô de Stories) vão para o **WhatsApp particular** do dono pela tabela
  `achados_zap_privadas`, usando `achados_config.zap_aviso_numero` (553897412120). Sem número, caem no Telegram.
- Única exceção: a vigia "o robô do WhatsApp parou" continua no bot particular do Telegram, porque com o robô
  parado não há como mandar no WhatsApp.
- Para voltar ao Telegram: religar `tg_ativo`, devolver `vit_telegram` e (se quiser) `alerta_ativo`.

## Marca e canais (O Cara dos Achados)
- Nome sem mostrar o nome real do dono; identidade preto e amarelo (logo em `marcas/`).
- Canais: grupos de WhatsApp "Cara dos Achados" (o robô cria o próximo grupo, numerado, perto de 950 pessoas;
  no máximo 1 por dia), canal no Telegram t.me/ocaradosachados, Instagram @ocaradosachados01 (conta antiga
  renomeada; o dono quer separá-la da antiga Mirafarma Drogaria num Meta Business só do O Cara dos Achados),
  TikTok @ocaradosachados01 (só TikTok Shop). O canal de WhatsApp foi trocado por grupos comuns.
- Anúncios Meta: levavam tráfego para o canal do Telegram; com o Telegram parado, devem apontar para o grupo de WhatsApp.
- Cupons: saem nos grupos como "bônus" (por ora só os da Shopee). Desconto mínimo das postagens zerado.
- Afiliados só em programas gratuitos (não quer pagar para ser afiliado).
- O dono usa o app no celular (iPhone), no iPad e no notebook.
- TikTok Shop: API ainda não liberada (faltam seguidores); voltar quando liberar. Planos: lives como afiliado
  e dois personagens de IA (Caio e Bia) para divulgar produtos (imagens/vídeos com Google Gemini/Veo).
- **Estúdio IA** (aba do app): só para produzir os vídeos (Shopee Video etc.); não deve influenciar as
  postagens dos grupos de WhatsApp. Ideia: achar produtos com boas vendas e poucos afiliados (< 300).

## Venda (Kiwify)
- Assinatura mensal com opção anual; planos sugeridos: Caça Achados R$ 39,90/mês e + Robô WhatsApp R$ 59,90/mês.
- `achados-kiwify` + `achados_assinatura_aplicar`: com acesso pago tudo liga; acabou o período → 7 dias de
  tolerância → automações pausadas (o estado fica em `achados_donos.pausado`; o trigger
  `achados_proteger_config` impede religar pelo app). Pagou → volta como estava. O dono (vitalício) nunca muda.
- Complementos por conta: `rec_robo`, `rec_estudio` (só o administrador liga).
- Pacote do robô para clientes: genérico, sem a marca do dono. Documentos já feitos (artifacts no claude.ai):
  plano de lançamento, guia de início e Termos/Privacidade.
- Pendente do dono: preços finais, conta na Kiwify e token do webhook (direto no cofre, nunca no chat),
  campos dos Termos, prints/vídeo, domínio próprio. Pendente de autorização: plano Pro do Supabase e limpezas
  (Stories com mais de 3 dias — armazenamento perto de 1 GB —, ofertas com mais de 30 dias, intervalo do robô).

## Afiliados
- Shopee e Mercado Livre: automáticos. Amazon: tag `ocaradosach08-20`; a API só libera com 10 vendas em
  30 dias (ainda não). Magalu: sem API de ofertas para afiliados (links à mão). Mensagens iguais para todas as
  lojas, sem o aviso "link de afiliado" no texto.
- Próximos: **AliExpress** (API de afiliados; o dono vai se cadastrar no portals.aliexpress.com e gerar App Key,
  App Secret e Tracking ID) e **Awin** (Casas Bahia, Americanas, Kabum, Netshoes, Centauro…). Quando ele avisar
  que tem as chaves: criar um lugar no app para colar (cofre, como a Shopee) e uma função de busca no padrão
  da `achados-shopee`.
- Regras da Amazon: nada de compras próprias ou combinadas.

## Regras de trabalho
- **Segredos** (chave do robô, tokens, senhas, App Secret) nunca no código, no git nem no chat: cofre
  (`segredos`, funções `achados_*_segredo`) ou `config.env` no computador (fora do git).
- Não criar contas nem digitar senha, CPF ou dados fiscais pelo dono.
- Não mudar a operação ao vivo (agenda, robôs, grupos) sem o dono pedir.
- Repositório público: nada de dados pessoais. Commit com mensagem em português.
