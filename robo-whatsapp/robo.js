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

// v4: confere a cada 30 min se há versão nova; se houver, sai (o INICIAR roda o atualizador e liga de novo em 10 s).
async function verAtualizacao() {
  if (ocupado || privOcupado) return;
  try {
    const r = await api({ acao: "atualizacao", versao: VERSAO });
    if (!r.atual) { log(`Versão nova (${r.versao}) disponível. Reiniciando para atualizar…`); process.exit(0); }
  } catch (e) { log("Não consegui checar atualização:", e.message); }
}

log(`Robô versão ${VERSAO}.`);
await conectar();
if (modo === "ligado") { setInterval(() => rodar(false), 60 * 1000); setInterval(mandarPrivadas, 20 * 1000); setInterval(verAtualizacao, 30 * 60 * 1000); }
