// Robô do WhatsApp do Caça Achados.
// Uso:  node robo.js           -> fica ligado e posta no canal e nos grupos (DESTINOS no config.env) conforme a agenda do app
//       node robo.js teste     -> posta 1 oferta agora para testar
//       node robo.js conectar  -> só faz a conexão (QR code) e sai
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from "@whiskeysockets/baileys";

// v2 (14/11/2026): a biblioteca de criptografia do WhatsApp imprime avisos internos ("Bad MAC", "Closing session"
// com chaves da sessão). Não ajudam a acompanhar o robô e não devem ficar gravados no registro: são descartados.
const RUIDO = /Bad MAC|Failed to decrypt|Session error|Closing (open )?session|Decrypted message with closed session|SessionEntry|No session record|No matching sessions/i;
for (const m of ["log", "info", "warn", "error"]) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { if (a.some((x) => (typeof x === "string" && RUIDO.test(x)) || (x && typeof x === "object" && ("_chains" in x || "currentRatchet" in x || "indexInfo" in x)))) return; orig(...a); };
}

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const cfg = Object.fromEntries(fs.readFileSync(path.join(AQUI, "config.env"), "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const modo = process.argv[2] || "ligado";
// v4: sabe a própria versão (para a atualização automática sem precisar reiniciar o computador)
const VERSAO = (() => { try { return Number(fs.readFileSync(path.join(AQUI, "versao.txt"), "utf8")) || 0; } catch { return 0; } })();
const log = (...a) => console.log(new Date().toLocaleString("pt-BR"), "·", ...a);
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const aleat = (a, b) => Math.floor(a + Math.random() * (b - a));

async function api(corpo) {
  const r = await fetch(cfg.URL, { method: "POST", headers: { "Content-Type": "application/json", "x-zap-key": cfg.CHAVE }, body: JSON.stringify(corpo) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || `erro ${r.status}`);
  return j;
}

let sock, destinos = [], pronto = false, ocupado = false;
const ARQ_GRUPOS = path.join(AQUI, "grupos.json");
const LIMITE = Number(cfg.LIMITE_GRUPO) || 950;          // ao chegar nisso, cria o próximo grupo
const MAX_GRUPOS = Number(cfg.MAX_GRUPOS) || 10;          // teto de segurança
const NOME_BASE = cfg.NOME_GRUPO || "Cara dos Achados";
const PAUSA_GRUPOS = [Number(cfg.PAUSA_GRUPOS_MIN) || 15, Number(cfg.PAUSA_GRUPOS_MAX) || 40];
const lerGrupos = () => { try { return JSON.parse(fs.readFileSync(ARQ_GRUPOS, "utf8")); } catch { return { lista: [], ultimaCriacao: 0 }; } };
const salvarGrupos = (g) => fs.writeFileSync(ARQ_GRUPOS, JSON.stringify(g, null, 2));

// Resolve cada link (canal ou grupo) para o endereço interno do WhatsApp.
async function achaDestinos() {
  const links = (cfg.DESTINOS || cfg.CANAL || "").split(",").map((x) => x.trim()).filter(Boolean);
  const achados = [];
  let meusGrupos = null;
  falhas_links.length = 0;
  for (const link of links) {
    const codigo = new URL(link.startsWith("http") ? link : "https://" + link).pathname.split("/").filter(Boolean).pop();
    try {
      if (/whatsapp\.com\/channel\//i.test(link)) {
        const m = await sock.newsletterMetadata("invite", codigo);
        achados.push({ jid: m.id, nome: `canal ${m.name || ""}` });
        log(`Canal encontrado: ${m.name || ""} · seu papel: ${m.viewer_metadata?.role || "?"}`);
      } else {
        const g = await sock.groupGetInviteInfo(codigo);
        meusGrupos = meusGrupos || (await sock.groupFetchAllParticipating());
        const sou = !!meusGrupos[g.id];
        achados.push({ jid: g.id, nome: `grupo ${g.subject || ""}`, grupo: true });
        log(`Grupo encontrado: ${g.subject || ""} (${g.size || "?"} pessoas)${sou ? "" : " · ATENÇÃO: este número ainda NÃO entrou no grupo"}`);
      }
    } catch (e) { log(`Não consegui achar ${link}:`, e.message); falhas_links.push(`${link.replace(/\?.*$/, "")} (${e.message})`); }
  }
  // Sem nenhum grupo pelo link (link redefinido ou cancelado): procura pelo nome entre os grupos em que este número é administrador.
  if (!achados.some((d) => d.grupo)) {
    try {
      meusGrupos = meusGrupos || (await sock.groupFetchAllParticipating());
      // v3: o WhatsApp identifica participantes pelo número ou por um código novo (LID): confere os dois
      const so = (x) => String(x || "").split(":")[0].split("@")[0];
      const eu = new Set([so(sock.user?.id), so(sock.user?.lid)].filter(Boolean));
      const base = NOME_BASE.toLowerCase();
      const peloNome = Object.values(meusGrupos).filter((g) => String(g.subject || "").toLowerCase().includes(base));
      const souAdmin = (g) => (g.participants || []).some((p) => [p.id, p.lid, p.jid, p.phoneNumber].some((x) => eu.has(so(x))) && p.admin);
      // prefere os grupos em que se confirmou administrador; se não confirmar nenhum, tenta os do nome mesmo
      const cands = peloNome.some(souAdmin) ? peloNome.filter(souAdmin) : peloNome;
      if (!peloNome.length) falhas_links.push(`nenhum grupo com "${NOME_BASE}" no nome entre os ${Object.keys(meusGrupos).length} grupos deste número`);
      for (const g of cands) {
        achados.push({ jid: g.id, nome: `grupo ${g.subject}`, grupo: true });
        log(`Grupo encontrado pelo nome: ${g.subject} (${(g.participants || []).length} pessoas)`);
      }
    } catch (e) { log("Não consegui procurar os grupos pelo nome:", e.message); }
  }
  for (const g of lerGrupos().lista) if (!achados.some((d) => d.jid === g.jid)) achados.push({ jid: g.jid, nome: `grupo ${g.nome}`, grupo: true, criado: true });
  destinos = achados;
  log(`${destinos.length} destino(s) prontos.`);
  // Conta para o app onde o robô vai postar (ou por que não achou), para acompanhar de longe
  const msg = destinos.length
    ? `conectado; vai postar em: ${destinos.map((d) => d.nome).join(", ")}`
    : `conectado, mas não achou o grupo. ${falhas_links.join("; ")}. Confira o link em DESTINOS no config.env e se este número é administrador do grupo "${NOME_BASE}".`;
  await api({ acao: "erro", mensagem: msg.slice(0, 240) }).catch(() => {});
}
const falhas_links = [];

let falhas = 0;
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(AQUI, "sessao"));
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, logger: pino({ level: "silent" }), browser: Browsers.windows("Chrome"), syncFullHistory: false, markOnlineOnConnect: false });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const arq = path.join(AQUI, "qr.png");
      await QRCode.toFile(arq, qr, { width: 420, margin: 2 });
      log("Leia o QR code que abriu na tela: WhatsApp > Aparelhos conectados > Conectar um aparelho.");
      if (process.platform === "win32") exec(`start "" "${arq}"`);
    }
    if (connection === "open") {
      pronto = true;
      falhas = 0;
      try { fs.unlinkSync(path.join(AQUI, "qr.png")); } catch { /* tanto faz */ }
      log("WhatsApp conectado.");
      await achaDestinos();
      if (modo === "conectar") { log("Conexão salva. Pode fechar."); setTimeout(() => process.exit(0), 3000); }
      if (modo === "teste") rodar(true).then(() => setTimeout(() => process.exit(0), 3000));
    }
    if (connection === "close") {
      pronto = false;
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === DisconnectReason.loggedOut) { log("Este número foi desconectado do WhatsApp. Apague a pasta 'sessao' e conecte de novo."); process.exit(1); }
      // 403 = o WhatsApp recusou este aparelho/número. Insistir de 5 em 5 s (como em 12–13/11, 7 mil vezes)
      // piora a situação do número: espera 30 min e avisa. Outras quedas: espera crescente até 5 min.
      falhas = codigo === 403 ? falhas : falhas + 1;
      const espera = codigo === 403 ? 30 * 60e3 : Math.min(5000 * 2 ** Math.min(falhas - 1, 6), 5 * 60e3);
      if (codigo === 403) log("O WhatsApp RECUSOU a conexão (403): o número pode estar restrito ou o aparelho foi removido. Confira o WhatsApp no celular do robô. Nova tentativa em 30 min.");
      else log(`Conexão caiu, tentando de novo em ${Math.round(espera / 1000)} s…`, codigo || "");
      await dorme(espera);
      conectar();
    }
  });
}

// Quando o último grupo chega perto do limite, cria o próximo e passa a divulgar o link dele.
async function cuidarDosGrupos() {
  const gs = destinos.filter((d) => d.grupo);
  if (!gs.length) return;
  const ultimo = gs[gs.length - 1];
  let tam;
  try { tam = (await sock.groupMetadata(ultimo.jid)).participants.length; }
  catch (e) { log("Não consegui ver o tamanho do grupo:", e.message); return; }
  if (tam < LIMITE) return;
  const est = lerGrupos();
  if (gs.length >= MAX_GRUPOS) { log(`Grupo cheio (${tam}), mas o teto de ${MAX_GRUPOS} grupos foi atingido.`); return; }
  if (Date.now() - (est.ultimaCriacao || 0) < 20 * 3600 * 1000) { log(`Grupo cheio (${tam}); aguardo para criar outro (máx. 1 por dia).`); return; }
  const num = (Number((ultimo.nome.match(/(\d+)\s*$/) || [])[1]) || gs.length) + 1;
  const nome = `${NOME_BASE} ${num}`;
  log(`Grupo "${ultimo.nome}" chegou a ${tam} pessoas. Criando "${nome}"…`);
  let jid;
  try { jid = (await sock.groupCreate(nome, [])).id; }
  catch (e1) {
    if (!cfg.ADMIN_NUMERO) { log("Não consegui criar grupo vazio e não há ADMIN_NUMERO no config.env:", e1.message); await api({ acao: "erro", mensagem: `Não criei o grupo ${nome}: ${e1.message}` }).catch(() => {}); return; }
    try { jid = (await sock.groupCreate(nome, [`${cfg.ADMIN_NUMERO.replace(/\D/g, "")}@s.whatsapp.net`])).id; }
    catch (e2) { log("Falha ao criar o grupo:", e2.message); await api({ acao: "erro", mensagem: `Não criei o grupo ${nome}: ${e2.message}` }).catch(() => {}); return; }
  }
  try {
    await sock.groupSettingUpdate(jid, "announcement"); // só administradores enviam
    await sock.groupUpdateDescription(jid, "Ofertas e achados do O Cara dos Achados. Só os administradores postam aqui.").catch(() => {});
    const link = `https://chat.whatsapp.com/${await sock.groupInviteCode(jid)}`;
    est.lista.push({ jid, nome, link, criado: new Date().toISOString() });
    est.ultimaCriacao = Date.now();
    salvarGrupos(est);
    destinos.push({ jid, nome: `grupo ${nome}`, grupo: true, criado: true });
    await api({ acao: "novo_grupo", nome, link });
    log(`Grupo "${nome}" criado. Link novo: ${link}`);
  } catch (e) { log("Criei o grupo mas não terminei a configuração:", e.message); await api({ acao: "erro", mensagem: `Grupo ${nome} criado, mas faltou configurar: ${e.message}` }).catch(() => {}); }
}

async function enviar(jid, o) {
  if (o.imagem) {
    try { await sock.sendMessage(jid, { image: { url: o.imagem }, caption: o.texto }); return; }
    catch (e) { log("Foto não foi, mando só o texto:", e.message); }
  }
  await sock.sendMessage(jid, { text: o.texto });
}

// Posta a oferta em todos os destinos (canal e grupos). Devolve em quantos deu certo.
async function postar(o) {
  if (!destinos.length) throw new Error("Nenhum canal ou grupo encontrado");
  let ok = 0, ultimoErro = "";
  for (const [k, d] of destinos.entries()) {
    if (k > 0) await dorme(aleat(PAUSA_GRUPOS[0], PAUSA_GRUPOS[1]) * 1000); // pausa entre um grupo e outro
    try { await enviar(d.jid, o); ok++; }
    catch (e) { ultimoErro = `${d.nome}: ${e.message}`; log("Falhou em", ultimoErro); }
  }
  if (!ok) throw new Error(ultimoErro || "não consegui postar");
  return ok;
}

// v5: mensagens em particular saem na hora (o robô pergunta a cada 20 s, mesmo no meio de uma rodada do grupo)
// e o número é conferido no WhatsApp: tenta com e sem o 9 extra e usa o formato que existe.
let privOcupado = false;
async function jidDoNumero(numero) {
  const n = String(numero).replace(/\D/g, "");
  const tentativas = [n];
  if (n.startsWith("55") && n.length === 13 && n[4] === "9") tentativas.push(n.slice(0, 4) + n.slice(5)); // sem o 9 extra
  if (n.startsWith("55") && n.length === 12) tentativas.push(n.slice(0, 4) + "9" + n.slice(4));           // com o 9 extra
  for (const t of tentativas) {
    try {
      const [r] = (await sock.onWhatsApp(`${t}@s.whatsapp.net`)) || [];
      if (r?.exists) return r.jid;
    } catch (e) { log("Não consegui conferir o número", t, e.message); }
  }
  return null;
}
async function mandarPrivadas() {
  if (privOcupado || !pronto) return;
  privOcupado = true;
  try {
    const { privadas } = await api({ acao: "privadas" });
    const jaVi = {};
    for (const [i, p] of (privadas || []).entries()) {
      if (i > 0) await dorme(aleat(6, 15) * 1000);
      try {
        const jid = jaVi[p.numero] !== undefined ? jaVi[p.numero] : (jaVi[p.numero] = await jidDoNumero(p.numero));
        if (!jid) throw new Error(`o número ${p.numero} não tem WhatsApp (conferi com e sem o 9)`);
        await enviar(jid, p);
        await api({ acao: "confirmar_privada", id: p.id });
        log(`Mensagem particular ${i + 1}/${privadas.length} enviada para ${jid.split("@")[0]}.`);
      } catch (e) {
        log("Mensagem particular falhou:", e.message);
        await api({ acao: "confirmar_privada", id: p.id, erro: e.message }).catch(() => {});
      }
    }
  } catch (e) { log("Erro nas mensagens particulares:", e.message); }
  finally { privOcupado = false; }
}

async function rodar(teste = false) {
  if (ocupado || !pronto) return;
  if (!destinos.length) return; // sem grupo não pede ofertas (senão gasta a vez da agenda à toa)
  ocupado = true;
  try {
    if (!teste) await cuidarDosGrupos();
    const { ofertas, motivo } = await api({ acao: "proximas", teste, sem_privadas: true });
    if (!ofertas.length) { if (teste) log("Nada para postar:", motivo); return; }
    log(`${ofertas.length} oferta(s) para postar (${motivo}).`);
    for (const [i, o] of ofertas.entries()) {
      if (i > 0) await dorme(aleat(25, 70) * 1000); // pausa variável entre uma e outra
      try {
        const n = await postar(o);
        await api({ acao: "confirmar", ids: [o.id] }); // confirma uma a uma
        log(`Postada ${i + 1}/${ofertas.length} em ${n} destino(s).`);
      } catch (e) { log("Falhou:", e.message); await api({ acao: "erro", mensagem: e.message }).catch(() => {}); break; }
    }
  } catch (e) {
    log("Erro:", e.message);
  } finally { ocupado = false; }
}

// v6: ofertas do Mercado Livre lidas no navegador (Edge) deste computador.
// Em 24/11/2026 o Mercado Livre bloqueou os preços na API para apps de terceiros. O robô abre, devagar,
// as páginas "Ofertas do dia" e as buscas com filtro de desconto (30–60 produtos por página, já com
// "de"/"por") e manda para o servidor, que monta o link de afiliado e põe na fila do WhatsApp.
// Risco aceito pelo dono (25/11/2026). Se aparecer verificação/captcha, PARA por 6 h e avisa; nunca contorna.
let mlVez = 0;
let mlOcupado = false, mlPausaAte = 0, mlNav = null, mlDesligado = false, mlProxima = Date.now() + 60 * 1000;
// v7 (25/11/2026, pedido do dono): usa o Google Chrome; sem Chrome instalado, usa o Edge e avisa uma vez.
let mlAvisouChrome = false;
async function navegadorML() {
  if (mlNav) return mlNav;
  const { chromium } = await import("playwright-core");
  const abrir = (canal) => chromium.launchPersistentContext(path.join(AQUI, `perfil-mercadolivre-${canal}`), {
    // v9 (25/11/2026, pedido do dono): janela de verdade por padrão (minimizada); o modo sem janela recebia página de erro do ML. ML_JANELA=nao volta ao sem janela.
    channel: canal, headless: cfg.ML_JANELA === "nao", args: ["--start-minimized"], locale: "pt-BR",
    viewport: { width: 1366, height: 900 }, timezoneId: "America/Sao_Paulo",
  });
  const canal = cfg.ML_NAVEGADOR || "chrome";
  try { mlNav = await abrir(canal); }
  catch (e) {
    if (cfg.ML_NAVEGADOR || canal === "msedge") throw e;
    mlNav = await abrir("msedge");
    if (!mlAvisouChrome) {
      mlAvisouChrome = true;
      log("Mercado Livre: Google Chrome não encontrado; usando o Edge.", e.message.slice(0, 120));
      await api({ acao: "erro", mensagem: "Leitura do Mercado Livre: o Google Chrome não está instalado no computador do robô; usando o Edge por enquanto." }).catch(() => {});
    }
  }
  mlNav.on("close", () => { mlNav = null; });
  return mlNav;
}
// v8: abre a página de um produto (mais vendido da categoria) e lê o preço "de"/"por" do quadro principal.
// A aba é aberta por lerListaML, que a fecha no "finally".
async function lerProdutoML(item, pg) {
  await pg.goto(item.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await pg.waitForSelector(".ui-pdp-price__main-container, .ui-pdp-price", { timeout: 25000 }).catch(() => {}); // v10: espera o preço aparecer
  await pg.waitForTimeout(aleat(2500, 5000));
  await pg.mouse.wheel(0, aleat(300, 700));
  await pg.waitForTimeout(aleat(800, 1600));
  const d = await pg.evaluate(() => {
    const reais = (t) => {
      const m = String(t || "").match(/([\d.]+)\s*rea(?:is|les)(?:\s*c[oa]n?\s*(\d+)\s*centavos?)?/i);
      return m ? Number(m[1].replace(/\./g, "")) + (m[2] ? Number(m[2]) / 100 : 0) : null;
    };
    const b = document.querySelector(".ui-pdp-price__main-container") || document.querySelector(".ui-pdp-price");
    const prev = b?.querySelector(".andes-money-amount--previous");
    const cur = b ? [...b.querySelectorAll(".andes-money-amount")].find((e) => !e.classList.contains("andes-money-amount--previous") && !e.closest(".andes-money-amount--previous")) : null;
    return { t: document.title, x: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160), url: location.href,
      de: reais(prev?.getAttribute("aria-label")), por: reais(cur?.getAttribute("aria-label")) };
  });
  if (/account-verification|suspicious|captcha|\/login|registration/i.test(d.url) || (!d.por && /verifi|captcha|rob[oô]|suspeit|incomum|confirme que/i.test(`${d.t} ${d.x}`))) {
    mlPausaAte = Date.now() + 6 * 3600 * 1000;
    log("Mercado Livre pediu verificação (", d.t, "). Parando a leitura por 6 horas.");
    await api({ acao: "ml_preco", bloqueio: true, erro: `O Mercado Livre mostrou uma tela de verificação: "${d.t}".` }).catch(() => {});
    return;
  }
  const r = await api({ acao: "ml_preco", produto_id: item.produto_id, preco_por: d.por, preco_de: d.de,
    erro: d.por ? null : `sem preço na página: "${d.t}" · ${d.x}` });
  log(`Mercado Livre · produto ${item.produto_id}: ${d.por ? `por ${d.por}${d.de ? ` (de ${d.de})` : ""}` : "sem preço"}${r.oferta ? ` → oferta nova (${r.desconto}% OFF)` : ""}.`);
}

async function lerListaML() {
  if (mlOcupado || amzOcupado || mlDesligado || !pronto || Date.now() < mlPausaAte || Date.now() < mlProxima) return;
  const h = new Date().getHours();
  if (h < 7 || h >= 23) return; // só de dia, como uma pessoa
  mlOcupado = true;
  let pg;
  try {
    // v8: alterna os mais vendidos por categoria (página de cada produto, a estratégia de antes)
    // com as listas (Ofertas do dia e buscas): 2 produtos para cada lista.
    // v11 (25/11/2026, pedido do dono): só abre a página de cada produto que a busca trouxe; não percorre mais as listas.
    {
      const { item } = await api({ acao: "ml_precos_pendentes" });
      if (item) { pg = await (await navegadorML()).newPage(); await lerProdutoML(item, pg); return; }
      mlProxima = Date.now() + 20 * 60 * 1000; // fila vazia: tenta de novo em 20 min
      return;
    }
    const { url, rotulo } = await api({ acao: "ml_lista_proxima" });
    if (!url) { mlProxima = Date.now() + 30 * 60 * 1000; return; }
    let ctx;
    try { ctx = await navegadorML(); }
    catch (e) {
      mlDesligado = true;
      log("Mercado Livre: não consegui abrir o navegador Edge (", e.message.slice(0, 140), "). Leitura de preços desligada até reiniciar.");
      await api({ acao: "ml_preco", bloqueio: true, erro: `O robô não conseguiu abrir o navegador Edge no computador: ${e.message.slice(0, 120)}` }).catch(() => {});
      return;
    }
    pg = await ctx.newPage();
    await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await pg.waitForSelector(".poly-card", { timeout: 25000 }).catch(() => {}); // v10: espera os produtos aparecerem
    await pg.waitForTimeout(aleat(2500, 5000));
    for (let i = 0; i < 4; i++) { await pg.mouse.wheel(0, aleat(700, 1300)); await pg.waitForTimeout(aleat(600, 1400)); }
    const atual = pg.url();
    if (/account-verification|suspicious|captcha|\/login|registration/i.test(atual)) {
      mlPausaAte = Date.now() + 6 * 3600 * 1000;
      log("Mercado Livre pediu verificação. Parando a leitura de preços por 6 horas.");
      await api({ acao: "ml_preco", bloqueio: true, erro: "O Mercado Livre mostrou uma tela de verificação (anti-robô)." }).catch(() => {});
      return;
    }
    const itens = await pg.evaluate(() => {
      const reais = (t) => {
        const m = String(t || "").match(/([\d.]+)\s*rea(?:is|les)(?:\s*c[oa]n?\s*(\d+)\s*centavos?)?/i);
        return m ? Number(m[1].replace(/\./g, "")) + (m[2] ? Number(m[2]) / 100 : 0) : null;
      };
      const out = [];
      for (const c of document.querySelectorAll(".poly-card")) {
        if (c.querySelector(".poly-component__ads-promotions, .poly-component__ad-label")) continue; // anúncio patrocinado
        const a = c.querySelector("a.poly-component__title") || c.querySelector("a[href*='mercadolivre.com.br']");
        const href = a?.href || "";
        if (!/^https:\/\/(www|produto)\.mercadolivre\.com\.br\//.test(href)) continue;
        const u = new URL(href);
        const f = decodeURIComponent(u.searchParams.get("pdp_filters") || "");
        const id = (f.match(/item_id:(MLB\d+)/) || [])[1] || (u.pathname.match(/\/p\/(MLB\d+)/) || [])[1] || ((u.pathname.match(/MLB-(\d+)/) || [])[1] ? "MLB" + u.pathname.match(/MLB-(\d+)/)[1] : null);
        if (!id) continue;
        const prev = c.querySelector(".andes-money-amount--previous");
        const cur = [...c.querySelectorAll(".andes-money-amount")].find((e) => !e.classList.contains("andes-money-amount--previous") && !e.closest(".andes-money-amount--previous"));
        const img = c.querySelector("img");
        const foto = (img?.getAttribute("data-src") || img?.src || "").replace(/\.webp(\?.*)?$/, ".jpg");
        out.push({
          id, titulo: (c.querySelector(".poly-component__title")?.textContent || a.textContent || "").trim(),
          link: u.origin + u.pathname, imagem: /^https:/.test(foto) ? foto : null,
          de: reais(prev?.getAttribute("aria-label")), por: reais(cur?.getAttribute("aria-label")),
        });
      }
      return out;
    });
    // Página sem produtos: guarda o que apareceu (título e começo do texto) para entender o motivo.
    let rot = rotulo;
    if (!itens.length) {
      const d = await pg.evaluate(() => ({ t: document.title, x: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160), n: document.querySelectorAll(".poly-card").length }));
      if (/verifi|captcha|rob[oô]|suspeit|incomum|confirme que/i.test(`${d.t} ${d.x}`)) {
        mlPausaAte = Date.now() + 6 * 3600 * 1000;
        log("Mercado Livre pediu verificação (", d.t, "). Parando a leitura por 6 horas.");
        await api({ acao: "ml_preco", bloqueio: true, erro: `O Mercado Livre mostrou uma tela de verificação: "${d.t}".` }).catch(() => {});
        return;
      }
      rot = `${rotulo} [página vazia: "${d.t}" · cards ${d.n} · ${d.x}]`;
    }
    const r = await api({ acao: "ml_lista", rotulo: rot, itens });
    log(`Mercado Livre · ${rotulo}: ${itens.length} lidos, ${r.com_desconto ?? 0} com desconto, ${r.novos ?? 0} novos.`);
  } catch (e) {
    log("Mercado Livre: erro ao ler a página:", e.message.slice(0, 160));
  } finally {
    await pg?.close().catch(() => {});
    mlProxima = Date.now() + aleat(3 * 60, 6 * 60) * 1000; // uma página a cada 3–6 min
    mlOcupado = false;
  }
}

// v12 (26/11/2026, pedido do dono): ofertas da Amazon pelo Chrome deste computador, para a busca continuar com o
// notebook desligado (as tarefas do notebook continuam; o amz_asin único no servidor evita duplicar).
// Abre amazon.com.br/deals (ou a página que o servidor mandar), rola aos poucos lendo os cards (a lista é virtual)
// e manda para a achados-zap, que filtra 25%+ e monta o link com a tag. No máximo uma página a cada 20–40 min,
// das 7h às 23h, nunca junto com o Mercado Livre nem no meio de uma rodada do WhatsApp.
// Captcha/verificação: NÃO contorna; avisa e para a Amazon por 6 h.
// v13: confere a cada 37 s (com 60 s caía sempre no mesmo instante da rodada, que marca "ocupado" antes, e nunca rodava).
let amzOcupado = false, amzPausaAte = 0, amzProxima = Date.now() + aleat(3, 8) * 60 * 1000;
const AMZ_BLOQ = /captcha|digite os caracteres|validatecaptcha|robot/i;
async function lerAmazon() {
  if (amzOcupado || mlOcupado || ocupado || privOcupado || !pronto || Date.now() < amzPausaAte || Date.now() < amzProxima) return;
  const h = new Date().getHours();
  if (h < 7 || h >= 23) return;
  amzOcupado = true;
  let pg;
  try {
    const { url, rotulo, motivo } = await api({ acao: "amz_lista_proxima" });
    if (!url) { log(`Amazon: nada a buscar agora (${motivo || "sem página"}).`); return; }
    pg = await (await navegadorML()).newPage();
    await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await pg.waitForSelector('[data-testid="product-card"]', { timeout: 25000 }).catch(() => {});
    await pg.waitForTimeout(aleat(2500, 4500));
    const bloqueada = async () => {
      const u = pg.url();
      if (AMZ_BLOQ.test(u)) return u;
      const n = await pg.locator('[data-testid="product-card"]').count().catch(() => 0);
      if (n) return null;
      const t = await pg.evaluate(() => `${document.title} ${(document.body?.innerText || "").slice(0, 600)}`).catch(() => "");
      return AMZ_BLOQ.test(t) ? t.replace(/\s+/g, " ").slice(0, 120) : null;
    };
    const bq = await bloqueada();
    if (bq) {
      amzPausaAte = Date.now() + 6 * 3600 * 1000;
      log("Amazon pediu verificação. Parando a busca da Amazon por 6 horas.");
      await api({ acao: "amz_bloqueio", erro: `Tela: ${bq}` }).catch(() => {});
      return;
    }
    // A lista é virtual (os cards somem ao rolar): lê os que estão na tela a cada rolagem e junta por ASIN.
    const lidos = new Map();
    const lerCards = () => pg.evaluate(() => {
      const num = (s) => Number(String(s).replace(/\./g, "").replace(",", "."));
      const out = [];
      for (const c of document.querySelectorAll('[data-testid="product-card"]')) {
        const href = c.querySelector('a[href*="/dp/"]')?.getAttribute("href") || "";
        const a = (href.match(/\/dp\/([A-Z0-9]{10})/) || [])[1];
        if (!a) continue;
        const txt = c.innerText || "";
        const linhas = txt.split("\n").map((l) => l.trim()).filter(Boolean);
        const t = linhas.find((l) => l.length > 25 && !/R\$|\boff\b|Oferta|De:/i.test(l)) || "";
        const p = (txt.match(/Preço da Oferta:\s*R\$\s*([\d.]+,\d{2}|[\d.]+)/i) || [])[1];
        const d = (txt.match(/De:\s*R\$\s*([\d.]+,\d{2}|[\d.]+)/i) || [])[1];
        const src = (c.querySelector("img")?.getAttribute("src") || "").split("?")[0];
        const i = src ? src.replace(/\._[^/]*_\.jpg$/i, "._AC_SL500_.jpg") : "";
        out.push({ a, t, p: p ? num(p) : null, d: d ? num(d) : null, i });
      }
      return out;
    });
    const voltas = aleat(25, 31);
    for (let k = 0; k < voltas; k++) {
      for (const it of await lerCards()) { const v = lidos.get(it.a); if (!v || (!v.p && it.p)) lidos.set(it.a, it); }
      await pg.evaluate(() => window.scrollBy(0, 900));
      await pg.waitForTimeout(aleat(900, 1400));
      if (k % 8 === 7 && (await bloqueada())) break; // conferido de novo abaixo
    }
    const bq2 = await bloqueada();
    if (bq2) {
      amzPausaAte = Date.now() + 6 * 3600 * 1000;
      log("Amazon pediu verificação no meio da leitura. Parando a busca da Amazon por 6 horas.");
      await api({ acao: "amz_bloqueio", erro: `Tela: ${bq2}` }).catch(() => {});
      return;
    }
    const itens = [...lidos.values()].filter((x) => x.p && x.d && x.d > x.p);
    const r = await api({ acao: "amz_lista", rotulo, itens });
    log(`Amazon · ${rotulo}: ${lidos.size} cards, ${itens.length} com preço de/por, ${r.com_desconto ?? 0} com 25%+, ${r.novos ?? 0} novos.`);
  } catch (e) {
    log("Amazon: erro ao ler a página:", String(e.message || e).slice(0, 160));
  } finally {
    await pg?.close().catch(() => {});
    amzProxima = Date.now() + aleat(20 * 60, 40 * 60) * 1000; // uma página a cada 20–40 min
    amzOcupado = false;
  }
}

// v4: confere a cada 30 min se há versão nova; se houver, sai (o INICIAR roda o atualizador e liga de novo em 10 s).
async function verAtualizacao() {
  if (ocupado || privOcupado || mlOcupado || amzOcupado) return;
  try {
    const r = await api({ acao: "atualizacao", versao: VERSAO });
    if (!r.atual) { log(`Versão nova (${r.versao}) disponível. Reiniciando para atualizar…`); await mlNav?.close().catch(() => {}); process.exit(0); }
  } catch (e) { log("Não consegui checar atualização:", e.message); }
}

log(`Robô versão ${VERSAO}.`);
await conectar();
if (modo === "ligado") { setInterval(() => rodar(false), 60 * 1000); setInterval(mandarPrivadas, 20 * 1000); setInterval(lerListaML, 30 * 1000); setInterval(lerAmazon, 37 * 1000); setInterval(verAtualizacao, 30 * 60 * 1000); }
