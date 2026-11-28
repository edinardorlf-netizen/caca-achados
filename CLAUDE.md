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
    `proximas`, `confirmar`, `privadas`, `confirmar_privada`, `atualizacao`, `novo_grupo`, `erro`, `ml_*`,
    `amz_lista_proxima`, `amz_lista`, `amz_bloqueio`; vigia (cron).
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
  Para publicar: insira a versão nova em `zap_codigo` com o sha256 certo. **Versão atual: 14** (robo.js sha 49dc86e2…;
  v14 = **"Ofertas do dia" do Mercado Livre pelo Chrome do desktop** (`lerOfertasML`, ver seção do Mercado Livre abaixo) e o laço antigo produto a produto (`lerListaML`) desligado;
  v13 = a Amazon confere a cada 37 s: com 60 s caía no mesmo instante da rodada (que marca `ocupado` antes) e nunca rodava —
  cuidado ao criar laços novos com o mesmo período dos que já existem;
  v12 = **ofertas da Amazon pelo Chrome do desktop** (`lerAmazon`, ver seção da Amazon abaixo); v11 = só abre a página de cada produto da fila `achados_ml_precos` (mais vendidos pelo /highlights), sem percorrer listas/buscas; fila vazia = espera 20 min; v10 = espera o preço/cards aparecerem antes de ler; v9 = Chrome com janela de verdade, minimizada, por padrão — sem janela o ML devolvia página de erro; com janela as páginas abriram, mas em 25/11 18:37 o ML mostrou tela de verificação e o robô pausou 6 h; `ML_JANELA=nao` volta ao modo sem janela; v8 = volta a estratégia dos mais vendidos por categoria: o servidor
  monta a fila em `achados_ml_precos` pelo `/highlights` e o robô lê o preço na página de cada produto, 2 produtos para cada
  página de lista, uma página a cada 3–6 min; v7 = Mercado Livre pelo Google Chrome, Edge só se não houver Chrome,
  e diagnóstico de página vazia em `ml_preco_msg`; v6 trouxe
  package.json com `playwright-core`; o atualizador roda `npm install` e volta à anterior se falhar). `robo-whatsapp/robo.js` = v14
  (com fim de linha LF, igual ao publicado; confira o sha256 antes de derivar a próxima versão).
- Agenda (no servidor): das **6h às 4h** da manhã seguinte, **30 ofertas** a cada 45 min, pausa de 25–70 s.
  Divisão (25/11/2026, pedido do dono): 5 brinquedos + 4 Natal/formatura (até 22/12) + 6 beleza e cosméticos + 6 moda feminina
  + 9 normais. Campanhas `beleza-2026` (`%beleza%`, categoria nova "Beleza e Cosméticos") e `femininos-2026` (`%feminin%`,
  "Moda Feminina") sem data de fim, com crons `campanha-beleza-*` e `campanha-femininos-*` (busca/processa de 20 em 20 min, 8h–23h).
  As frações são sequenciais sobre as vagas que sobram (`planoDaRodada`).
  **Todas as lojas em toda rodada** (27/11/2026, pedido do dono; achados-zap v27, `garantirLojas`): Shopee, Amazon e Mercado Livre
  têm pelo menos 3 vagas por rodada (rodada com menos de 15: 1), se houver oferta delas na fila; a vaga sai da loja com mais ofertas,
  de uma oferta fora de campanha e do fim da lista.
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
  Cada rodada termina com um **6º Story-convite** para o grupo do WhatsApp (id `grupo`, link = `vit_whatsapp`,
  arte `gerarArteGrupo` com o quadro no mesmo lugar). Publicado em 23/11/2026 (achados-story v9, com os avisos no WhatsApp).
- Login caiu → avisa no WhatsApp particular e espera o `CONECTAR-INSTAGRAM.bat`; bloqueio → espera 6 h.
- Situação em 23/11: pacote pronto; o dono vai instalar no desktop em `C:\LicitaPro\robo-stories`.
  Falta: instalar, login (o dono digita), `TESTE-STORY.bat` para conferir a posição da figurinha, ligar.
- Stories pela API oficial (`ig_ativo` + token da Meta) também existem, mas o token nunca foi conectado.
- **v2: seguir contas** (pedido do dono em 23/11/2026, risco aceito): no laço principal, `seguir_um` segue 1 conta
  quando chega a hora; meta `SEGUIR_POR_DIA` (máx. 30, rampa 10 → 20 → meta na 1ª semana), janela
  `SEGUIR_HORA_INI`/`FIM`, mínimo ~6 min entre um e outro. Alvos: quem curtiu posts recentes de `SEGUIR_PERFIS`
  (config.env local; vazio = desligado). Histórico em `seguir-estado.json` (nunca repete; não deixa de seguir).
  Bloqueio → pausa de 48 h só no seguir + aviso. `SEGUIR-TESTE.bat` lista candidatos sem seguir.
- **v3: atualiza sozinho** como o do WhatsApp: a cada 30 min a ação `story_config` (achados-story) devolve a
  configuração de seguir (`achados_config.ig_seguir_perfis` texto separado por vírgula, `ig_seguir_qtd` 0–30,
  `ig_seguir_hora_ini`/`fim`; vale mais que o config.env) e, se `story_codigo` tiver versão maior, os arquivos
  [{nome, conteudo, sha256}] (só `robo_stories.py`; confere sha256 e compila antes de trocar; depois sai e o .bat
  religa). Para publicar: insira a versão nova em `story_codigo` com o sha256 do conteúdo UTF-8.
  A v3 em si precisa ser copiada à mão uma vez no desktop.

## Mercado Livre pelo navegador (25/11/2026)
- **PAUSADO pelo dono em 25/11 19:10** até resolver o bloqueio (tela de verificação no Chrome do robô; consulta 498450570 no suporte do ML): `ml_preco_ativo` = false, cron `achados-ml-buscar` desligado, ofertas meli ativas guardadas em `achados_ml_pausa` e marcadas 'descartada' (como voltar: `supabase/migrations/20261125_ml_pausa.sql`).
- Amazon (25/11): sem API (conta ainda não aprovada; Creators API só com 10 vendas em 30 dias). Ofertas pegas à mão no navegador e gravadas com `amz_asin` + `link` com `amz_tag`, status 'aprovada' (prioridade).

## Mercado Livre "Ofertas do dia" pelo robô do desktop (27/11/2026)
- Mesmo procedimento das tarefas agendadas do notebook (que continuam valendo; não apagar nem alterar), para seguir com o
  notebook desligado. O índice único em `(dono, ml_item_id)` evita duplicar entre as duas fontes.
- Robô v14, `lerOfertasML()` (laço de 41 s; não coincidir com 20, 37 e 60 s): 3 vezes por dia em horários sorteados entre 9h e 22h,
  3 h ou mais entre uma e outra (agenda do dia em `ml-ofertas-agenda.json` na pasta do robô), 2 páginas de
  `mercadolivre.com.br/ofertas?page=N` por vez, 40–90 s entre as páginas, rolagem lenta. Nunca junto com a Amazon nem no meio de uma rodada.
  Lê `.poly-card` (pula patrocinados; ID `/up/MLBU…` → `/p/MLB…` → `MLB-123`, nunca o item_id do pdp_filters; "de"/"por" pelo aria-label).
- `achados-zap` v28: `ml_ofertas_proxima` (páginas 1–8, rodízio em `achados_config.ml_ofertas_cursor`; só com
  `ml_desktop_ativo`; com `so_teste` serve 1 página se `ml_desktop_teste` = true e volta o flag para false). `ml_lista`
  aceita MLBU, mínimo fixo de 15%, categoria "Beleza e Cosméticos" pelas palavras do título ou "Ofertas ML"; oferta já existente
  só atualiza o preço, e 'descartada' que nunca saiu no WhatsApp (`postado_em` nulo) volta para 'nova'.
- Liga/desliga: `achados_config.ml_desktop_ativo` (padrão false). Teste: `ml_desktop_teste` = true → o robô lê 1 página em até 5 min.
  `ml_preco_ativo` e o cron `achados-ml-buscar` continuam desligados.
- Verificação/captcha (url ou título com verifica|captcha|account-verification|wall|robot): **não contorna**, avisa no WhatsApp
  particular do dono, para o Mercado Livre por 24 h e anota em `ml_preco_msg`.
- Migração: `supabase/migrations/20261127_ml_desktop.sql`.

## Amazon pelo navegador (26/11/2026)
- Duas fontes gravam na mesma tabela, sem duplicar (índice único `achados_ofertas_dono_amz_asin_key` em `(dono, amz_asin)`):
  1. **Tarefas agendadas do notebook** ("Ofertas da Amazon no Caça Achados" e "Amazon extra na Black Friday"), com o app do
     Claude aberto. Continuam valendo; não apagar nem alterar.
  2. **Robô do WhatsApp v12+ no desktop** (24 h, mesmo com o notebook desligado): `lerAmazon()` abre, no mesmo Chrome
     minimizado do Mercado Livre (`navegadorML()`), uma aba nova com `amazon.com.br/deals` (redireciona para a campanha do
     momento) ou `?promotionsSearchStartIndex=60|120|180&promotionsSearchPageSize=60`; rola 25–30 vezes (900 px, ~1 s) lendo
     os cards `[data-testid="product-card"]` a cada rolagem (lista virtual) e manda {a, t, p, d, i} para a `achados-zap`.
     No máximo uma página a cada 20–40 min, das 7h às 23h, nunca junto com o Mercado Livre nem no meio de uma rodada.
- `achados-zap` (v26): `amz_lista_proxima` (rodízio em `achados_config.amz_cursor`; devolve `url: null` com
  `amz_ativo` = false ou 80+ ofertas da Amazon na fila sem postar), `amz_lista` (só de > por e 25%+; grava marketplace/fonte
  'amazon', `link_produto` /dp/ASIN, `link` com `?tag=amz_tag`, `link_auto` false, status 'nova', categoria Brinquedos ou
  Beleza e Cosméticos pelas palavras do título; ASIN já existente e ainda não postado só atualiza o preço) e `amz_bloqueio`.
- Status em `achados_config.amz_msg`. `amz_ativo` = false desliga só a busca do desktop.
- Captcha/verificação ("captcha", "Digite os caracteres", "validateCaptcha", "robot"): o robô **não contorna**, chama
  `amz_bloqueio` (aviso no WhatsApp particular do dono) e para a Amazon por 6 h. Nunca comprar nem clicar em comprar.
- Migração: `supabase/migrations/20261126_amazon_robo.sql` (`amz_ativo`, `amz_cursor`, `amz_msg`).
- Em 24/11 o Mercado Livre passou a recusar os preços para apps de terceiros (403 em `/products/{id}/items` e
  `/sites/MLB/search`; `/highlights` e `/products/{id}` ainda respondem, sem preço). A busca do `achados-ml` ficou em
  "0 conferidos".
- Decisão do dono (risco aceito para a conta de afiliado): o **robô do WhatsApp v7** abre no Google Chrome do desktop (Edge se não houver Chrome)
  (playwright-core, perfil `perfil-mercadolivre-<navegador>`, `ML_NAVEGADOR` no config.env força outro, sem janela; `ML_JANELA=sim` no config.env mostra a janela) uma
  página a cada 4–7 min, das 7h às 23h: "Ofertas do dia" (8 páginas) e buscas `lista.mercadolivre.com.br/<palavra>_Desconto_N-100`
  com as palavras de `achados_config.ml_palavras` (cópia das da Shopee). Lê os cards `.poly-card` (preço "Antes"/atual
  pelo aria-label; pula patrocinados) e manda para a `achados-zap` (`ml_lista_proxima`, `ml_lista`), que grava em
  `achados_ofertas` (só com desconto) e monta o link de afiliado (`achados_aplicar_afiliado`). Status em
  `achados_config.ml_preco_msg`. Tela de verificação → para 6 h e avisa no WhatsApp; nunca contornar.
- `ml_preco_ativo` = false desliga. A tabela `achados_ml_precos` e as ações `ml_precos_pendentes`/`ml_preco` (produto a produto)
  ficaram como reserva; `ml_preco` com `bloqueio` é o aviso.

## Black Friday (27/11/2026, pedido do dono: ritmo forte)
- Cron `blackfriday-liga` (27/11 00h de Brasília): `wa_intervalo_min` 20, `ig_intervalo_min` 30 (o banco recusa menos de 30: com 20 o cron falhou às 00h e o modo Black Friday só entrou às 16h40, aplicado à mão), Stories 8h–23h, palavras extras na Shopee (black friday, oferta relâmpago, queima de estoque, super ofertas) e busca da Shopee às :10/:30/:50.
- Cron `blackfriday-desliga` (28/11 04h): volta para 45 min / 60 min / 9h–21h, tira as palavras, Shopee só às :50 e apaga os dois crons.
- Tarefas agendadas da Amazon (notebook com o app do Claude aberto): diária 9h43/15h43/20h43 (repõe se houver menos de 40 na fila) e extra só em 27/11 a cada 2 h.

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
