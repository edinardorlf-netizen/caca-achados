// =====================================================================
// Caça Achados · Stories do Instagram (Supabase Edge Function "achados-story")
//
// Ações do app (só o dono):
//   POST { acao: "gerar", id }            → gera as duas artes (link na bio / figurinha) e devolve os endereços
//   POST { acao: "story_postado", id }    → marca que você postou o Story à mão
//   POST { acao: "ig_testar" }            → confere o token do Instagram e guarda usuário e validade
//   POST { acao: "ig_postar", id }        → publica o Story agora pela API
//   POST { acao: "alerta_vincular" }      → acha a sua conversa com o bot do Telegram para receber os avisos
//   POST { acao: "alerta_testar" }        → manda um aviso de teste
//   POST { acao: "wa_agora" }             → manda já a próxima oferta da Hora do WhatsApp
// Cron (x-cron-key):
//   GET ?tarefa=postar → Story automático (link na bio) + aviso de achadão (para postar com figurinha)
//
// A API do Instagram não deixa colocar a figurinha de link, então o automático usa "link na bio"
// (a bio aponta para a Vitrine, onde o achado aparece pelo código #N).
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { fotoDataUri, gerarArte, type Modo, type Recursos } from "./arte.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const IG = "https://graph.instagram.com/v23.0";
const VITRINE = "https://edinardorlf-netizen.github.io/caca-achados/vitrine.html";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Recursos da arte (baixados uma vez por instância) ----------
const CDN = "https://cdn.jsdelivr.net/npm";
let recursos: Recursos | null = null;
async function carregarRecursos(): Promise<Recursos> {
  if (recursos) return recursos;
  const fonte = async (w: number) => {
    const r = await fetch(`${CDN}/@fontsource/archivo@5.1.0/files/archivo-latin-${w}-normal.woff`);
    if (!r.ok) throw new Error(`Não consegui baixar a fonte (${r.status})`);
    return await r.arrayBuffer();
  };
  const [w500, w700, w900, wasm] = await Promise.all([fonte(500), fonte(700), fonte(900),
    fetch(`${CDN}/@resvg/resvg-wasm@2.6.2/index_bg.wasm`).then((r) => { if (!r.ok) throw new Error("Não consegui baixar o gerador de imagem"); return r.arrayBuffer(); })]);
  recursos = { fontes: { w500, w700, w900 }, wasm };
  return recursos;
}

// deno-lint-ignore no-explicit-any
type Oferta = any;
const descontoDe = (o: Oferta) => (o.preco_de && o.preco_por && Number(o.preco_de) > Number(o.preco_por) ? Math.round((1 - Number(o.preco_por) / Number(o.preco_de)) * 100) : null);
const pontuacao = (o: Oferta) => Math.round((descontoDe(o) || 0) * 1.2 + (o.comissao || 0) * 2 + (o.cupom ? 8 : 0) + (o.ml_posicao ? Math.max(0, 12 - o.ml_posicao) : 0));
const brl = (v: number | null) => (v == null ? "" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const escHtml = (s: string) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

async function curto(txt: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt));
  return [...new Uint8Array(h)].slice(0, 5).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Gera (ou reaproveita) as artes de uma oferta. O nome do arquivo muda quando muda o preço ou o título.
async function artes(o: Oferta, quais: Modo[] = ["bio", "link"]) {
  const versao = await curto(`${o.titulo}|${o.preco_de}|${o.preco_por}|${o.cupom || ""}|${o.imagem || ""}|v1`);
  const caminho = (m: Modo) => `o${o.num}-${m}-${versao}.jpg`;
  const pub = (m: Modo) => db.storage.from("stories").getPublicUrl(caminho(m)).data.publicUrl;
  const atual: Record<Modo, string | null> = { bio: o.story_bio_url, link: o.story_link_url };
  const faltam = quais.filter((m) => atual[m] !== pub(m));
  if (faltam.length) {
    const rec = await carregarRecursos();
    const foto = await fotoDataUri(o.imagem);
    for (const m of faltam) {
      const jpg = await gerarArte(o, foto, m, rec);
      const { error } = await db.storage.from("stories").upload(caminho(m), jpg, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
      if (error) throw new Error(`Erro ao guardar a arte: ${error.message}`);
    }
    const patch: Record<string, string> = {};
    if (quais.includes("bio")) patch.story_bio_url = pub("bio");
    if (quais.includes("link")) patch.story_link_url = pub("link");
    await db.from("achados_ofertas").update(patch).eq("id", o.id);
  }
  return { bio: quais.includes("bio") ? pub("bio") : null, link: quais.includes("link") ? pub("link") : null };
}

// ---------- Instagram ----------
async function igToken(dono: string) {
  const { data } = await db.rpc("achados_ig_token", { p_dono: dono });
  if (!data) throw new Error("Falta o token do Instagram.");
  return data as string;
}
// deno-lint-ignore no-explicit-any
async function ig(metodo: "GET" | "POST", caminho: string, params: Record<string, string>): Promise<any> {
  const q = new URLSearchParams(params);
  const r = await fetch(metodo === "GET" ? `${IG}${caminho}?${q}` : `${IG}${caminho}`, metodo === "GET" ? {} : { method: "POST", body: q });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    const m = e.error_user_msg || e.message || `erro ${r.status}`;
    if (e.code === 190) throw new Error(`O token do Instagram expirou ou foi revogado: gere outro e cole em Ajustes. (${m})`);
    throw new Error(`Instagram: ${m}`);
  }
  return j;
}

// Tokens de longa duração valem 60 dias: renovamos quando faltam menos de 15.
async function renovarSeVencendo(dono: string, exp: string | null) {
  if (exp && Date.parse(exp) - Date.now() > 15 * 864e5) return;
  const token = await igToken(dono);
  const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({}));
  if (j.access_token) {
    await db.rpc("achados_ig_trocar_token", { p_dono: dono, p_token: j.access_token, p_exp: new Date(Date.now() + Number(j.expires_in || 5184000) * 1000).toISOString() });
  }
}

async function publicarStory(dono: string, o: Oferta) {
  const { data: cfg } = await db.from("achados_config").select("ig_user_id").eq("dono", dono).single();
  if (!cfg?.ig_user_id) throw new Error("Conecte o Instagram em Ajustes (Salvar e testar).");
  const token = await igToken(dono);
  const { bio } = await artes(o, ["bio"]);
  const c = await ig("POST", `/${cfg.ig_user_id}/media`, { image_url: bio!, media_type: "STORIES", access_token: token });
  // Espera o Instagram processar a imagem
  for (let i = 0; i < 12; i++) {
    const s = await ig("GET", `/${c.id}`, { fields: "status_code,status", access_token: token });
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`O Instagram recusou a imagem (${s.status || s.status_code}).`);
    await sleep(2500);
  }
  const p = await ig("POST", `/${cfg.ig_user_id}/media_publish`, { creation_id: c.id, access_token: token });
  const agora = new Date().toISOString();
  const canais = [...new Set([...(o.canais || []), "instagram"])];
  await db.from("achados_ofertas").update({ ig_postado_em: agora, canais }).eq("id", o.id);
  await db.from("achados_config").update({ ig_ultimo_post: agora, ig_msg: `Story publicado: #${o.num} ${String(o.titulo).slice(0, 70)}` }).eq("dono", dono);
  return p.id as string;
}

function horaSP() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hourCycle: "h23" }).format(new Date()));
}

async function proximaParaStory(dono: string, minDesc: number) {
  const hoje = new Date().toISOString().slice(0, 10);
  const { data } = await db.from("achados_ofertas").select("*").eq("dono", dono).not("link", "is", null).eq("exemplo", false)
    .is("ig_postado_em", null).in("status", ["nova", "aprovada", "postada"]).or(`validade.is.null,validade.gte.${hoje}`).limit(300);
  const lst = (data || []).filter((o: Oferta) => (descontoDe(o) || 0) >= minDesc);
  lst.sort((a: Oferta, b: Oferta) => (b.status === "aprovada" ? 1 : 0) - (a.status === "aprovada" ? 1 : 0) || pontuacao(b) - pontuacao(a));
  return lst[0] || null;
}

async function storyAgendado() {
  const { data: donos } = await db.from("achados_config").select("dono,ig_intervalo_min,ig_hora_ini,ig_hora_fim,ig_desconto_min,ig_ultimo_post,ig_token_exp").eq("ig_ativo", true);
  const res: Record<string, unknown> = {};
  for (const c of donos || []) {
    try {
      await renovarSeVencendo(c.dono, c.ig_token_exp).catch(() => {});
      const h = horaSP();
      if (h < c.ig_hora_ini || h >= c.ig_hora_fim) { res[c.dono] = "fora do horário"; continue; }
      if (c.ig_ultimo_post && Date.now() - Date.parse(c.ig_ultimo_post) < (c.ig_intervalo_min * 60 - 30) * 1000) { res[c.dono] = "aguardando intervalo"; continue; }
      const o = await proximaParaStory(c.dono, c.ig_desconto_min);
      if (!o) { res[c.dono] = "nada para postar"; await db.from("achados_config").update({ ig_msg: "Nenhuma oferta com link e desconto suficiente para o Story." }).eq("dono", c.dono); continue; }
      res[c.dono] = `story ${await publicarStory(c.dono, o)}`;
    } catch (e) {
      res[c.dono] = { erro: (e as Error).message };
      await db.from("achados_config").update({ ig_msg: (e as Error).message.slice(0, 300) }).eq("dono", c.dono);
    }
  }
  return res;
}

// ---------- Aviso de achadão (pelo bot do Telegram, na sua conversa particular com ele) ----------
async function tg(token: string, metodo: string, corpo: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram: ${j.description || `erro ${r.status}`}`);
  return j.result;
}
async function tgToken(dono: string) {
  const { data } = await db.rpc("achados_tg_token", { p_dono: dono });
  if (!data) throw new Error("Configure primeiro o bot do Telegram.");
  return data as string;
}

async function enviarAlerta(dono: string, chat: string, o: Oferta) {
  const token = await tgToken(dono);
  const { link } = await artes(o, ["link"]);
  const d = descontoDe(o);
  const texto = [
    `🔥 <b>Achadão para o Story</b> (#${o.num}) — ${d}% OFF`, "",
    `<b>${escHtml(String(o.titulo).slice(0, 160))}</b>`,
    `${o.preco_de ? `De ${brl(Number(o.preco_de))} por ` : ""}<b>${brl(Number(o.preco_por))}</b>`, "",
    "1. Salve esta imagem e poste no Story.",
    "2. Coloque a figurinha <b>Link</b> em cima do quadro amarelo com este link:",
    `<code>${escHtml(o.link)}</code>`,
  ].join("\n");
  try { await tg(token, "sendPhoto", { chat_id: chat, photo: link, caption: texto, parse_mode: "HTML" }); }
  catch (_) { await tg(token, "sendMessage", { chat_id: chat, text: `${texto}\n\nArte: ${link}`, parse_mode: "HTML" }); }
  await db.from("achados_ofertas").update({ alerta_em: new Date().toISOString() }).eq("id", o.id);
}

async function alertasAgendados() {
  const { data: donos } = await db.from("achados_config").select("dono,alerta_min,alerta_chat_id,alerta_desde").eq("alerta_ativo", true).not("alerta_chat_id", "is", null);
  const res: Record<string, unknown> = {};
  const h = horaSP();
  for (const c of donos || []) {
    if (h < 8 || h >= 22) { res[c.dono] = "fora do horário"; continue; }
    try {
      const hoje = new Date().toISOString().slice(0, 10);
      const { data } = await db.from("achados_ofertas").select("*").eq("dono", c.dono).not("link", "is", null).eq("exemplo", false)
        .is("alerta_em", null).is("story_em", null).in("status", ["nova", "aprovada", "postada"]).gte("criado_em", c.alerta_desde || new Date().toISOString())
        .or(`validade.is.null,validade.gte.${hoje}`).limit(200);
      const lst = (data || []).filter((o: Oferta) => (descontoDe(o) || 0) >= c.alerta_min).sort((a: Oferta, b: Oferta) => pontuacao(b) - pontuacao(a)).slice(0, 2);
      for (const o of lst) await enviarAlerta(c.dono, c.alerta_chat_id, o);
      res[c.dono] = `${lst.length} aviso(s)`;
      if (lst.length) await db.from("achados_config").update({ alerta_msg: `Último aviso: #${lst[0].num} (${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })})` }).eq("dono", c.dono);
    } catch (e) {
      res[c.dono] = { erro: (e as Error).message };
      await db.from("achados_config").update({ alerta_msg: (e as Error).message.slice(0, 300) }).eq("dono", c.dono);
    }
  }
  return res;
}

// ---------- Hora do WhatsApp ----------
// O WhatsApp não tem jeito oficial de postar em grupos sozinho. Então, nos horários marcados, o bot
// te manda (no particular do Telegram) a oferta da vez com um botão que abre o WhatsApp com o texto
// pronto: você só escolhe o grupo/canal e envia.
const LOJA_WA: Record<string, string> = { shopee: "na Shopee", meli: "no Mercado Livre", amazon: "na Amazon", tiktok: "no TikTok Shop" };
function textoWhatsApp(o: Oferta) {
  const d = descontoDe(o);
  return [
    `${d && d >= 40 ? "🔥 ACHADÃO" : "🛒 ACHADO DO DIA"} ${LOJA_WA[o.marketplace] || ""}`.trim(), "",
    `*${String(o.titulo).slice(0, 160)}*`, "",
    (o.preco_de && d ? `~De ${brl(Number(o.preco_de))}~\n` : "") + `✅ *Por ${brl(Number(o.preco_por))}*${d ? ` (${d}% OFF)` : ""}`,
    o.cupom ? `🎟️ Cupom: *${o.cupom}*` : null,
    o.nota ? `📌 ${o.nota}` : null, "",
    `👉 ${o.link}`, "",
    "⚠️ Preço e estoque podem mudar a qualquer momento.",
    "_O Cara dos Achados_",
  ].filter((x) => x !== null).join("\n");
}

async function proximaParaWhatsApp(dono: string, minDesc: number) {
  const hoje = new Date().toISOString().slice(0, 10);
  const { data } = await db.from("achados_ofertas").select("*").eq("dono", dono).not("link", "is", null).eq("exemplo", false)
    .is("wa_avisado_em", null).in("status", ["nova", "aprovada", "postada"]).or(`validade.is.null,validade.gte.${hoje}`).limit(300);
  const lst = (data || []).filter((o: Oferta) => (descontoDe(o) || 0) >= minDesc && !(o.canais || []).includes("whatsapp"));
  lst.sort((a: Oferta, b: Oferta) => (b.status === "aprovada" ? 1 : 0) - (a.status === "aprovada" ? 1 : 0) || pontuacao(b) - pontuacao(a));
  return lst[0] || null;
}

async function enviarHoraWhatsApp(dono: string, chat: string, o: Oferta, n?: string) {
  const token = await tgToken(dono);
  const txt = textoWhatsApp(o);
  const d = descontoDe(o);
  const legenda = [
    `🟢 <b>Hora do WhatsApp</b>${n ? ` (${n})` : ""} · achado #${o.num}${d ? ` · ${d}% OFF` : ""}`, "",
    `<b>${escHtml(String(o.titulo).slice(0, 140))}</b>`,
    `${o.preco_de && d ? `De ${brl(Number(o.preco_de))} por ` : ""}<b>${brl(Number(o.preco_por))}</b>`, "",
    "Toque em <b>Enviar no WhatsApp</b>, escolha o grupo ou canal e envie. Se preferir, copie o texto abaixo.",
  ].join("\n");
  const teclado = { inline_keyboard: [[{ text: "📲 Enviar no WhatsApp", url: `https://wa.me/?text=${encodeURIComponent(txt)}` }]] };
  try {
    if (o.imagem) await tg(token, "sendPhoto", { chat_id: chat, photo: o.imagem, caption: legenda, parse_mode: "HTML", reply_markup: teclado });
    else throw new Error("sem foto");
  } catch (_) {
    await tg(token, "sendMessage", { chat_id: chat, text: legenda, parse_mode: "HTML", reply_markup: teclado });
  }
  await tg(token, "sendMessage", { chat_id: chat, text: `<pre>${escHtml(txt)}</pre>`, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  const agora = new Date().toISOString();
  const canais = [...new Set([...(o.canais || []), "whatsapp"])];
  await db.from("achados_ofertas").update({ wa_avisado_em: agora, canais }).eq("id", o.id);
  await db.from("achados_config").update({ wa_ultimo_aviso: agora, wa_msg: `Último aviso: #${o.num} ${String(o.titulo).slice(0, 60)} (${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })})` }).eq("dono", dono);
}

async function whatsappAgendado() {
  const { data: donos } = await db.from("achados_config").select("dono,alerta_chat_id,wa_posts_dia,wa_hora_ini,wa_hora_fim,wa_desconto_min,wa_ultimo_aviso").eq("wa_ativo", true).not("alerta_chat_id", "is", null);
  const res: Record<string, unknown> = {};
  const h = horaSP();
  for (const c of donos || []) {
    if (h < c.wa_hora_ini || h >= c.wa_hora_fim) { res[c.dono] = "fora do horário"; continue; }
    // Espalha os avisos pela janela: 6 posts das 9h às 21h = um a cada 2h
    const intervaloMin = Math.max(20, Math.floor(((c.wa_hora_fim - c.wa_hora_ini) * 60) / c.wa_posts_dia));
    if (c.wa_ultimo_aviso && Date.now() - Date.parse(c.wa_ultimo_aviso) < (intervaloMin * 60 - 30) * 1000) { res[c.dono] = "aguardando intervalo"; continue; }
    try {
      const o = await proximaParaWhatsApp(c.dono, c.wa_desconto_min);
      if (!o) { res[c.dono] = "nada para postar"; await db.from("achados_config").update({ wa_msg: "Nenhuma oferta nova com link e desconto suficiente para o WhatsApp." }).eq("dono", c.dono); continue; }
      await enviarHoraWhatsApp(c.dono, c.alerta_chat_id, o);
      res[c.dono] = `aviso #${o.num}`;
    } catch (e) {
      res[c.dono] = { erro: (e as Error).message };
      await db.from("achados_config").update({ wa_msg: (e as Error).message.slice(0, 300) }).eq("dono", c.dono);
    }
  }
  return res;
}

// ---------- Entrada ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    const tarefa = url.searchParams.get("tarefa");
    if (tarefa) {
      const chave = req.headers.get("x-cron-key") || "";
      const { data: seg } = await db.from("segredos").select("valor").eq("chave", "cron").maybeSingle();
      if (!seg || chave !== seg.valor) return json({ erro: "não autorizado" }, 401);
      if (tarefa !== "postar") return json({ erro: "tarefa desconhecida" }, 400);
      return json({ stories: await storyAgendado(), alertas: await alertasAgendados(), whatsapp: await whatsappAgendado() });
    }

    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(token);
    const email = (u?.user?.email || "").toLowerCase();
    if (!email) return json({ erro: "Faça login novamente." }, 401);
    const { data: dono } = await db.from("achados_donos").select("email").eq("email", email).maybeSingle();
    if (!dono) return json({ erro: "Seu acesso ao Caça Achados não está liberado." }, 403);

    const body = await req.json().catch(() => ({}));
    const oferta = async () => {
      const { data: o } = await db.from("achados_ofertas").select("*").eq("dono", email).eq("id", String(body.id || "")).maybeSingle();
      if (!o) throw new Error("Oferta não encontrada.");
      return o;
    };

    if (body.acao === "gerar") {
      const o = await oferta();
      const a = await artes(o);
      return json({ arte_bio: a.bio, arte_link: a.link, num: o.num, link: o.link, vitrine: `${VITRINE}#a${o.num}` });
    }
    if (body.acao === "story_postado") {
      const o = await oferta();
      const canais = [...new Set([...(o.canais || []), "instagram"])];
      await db.from("achados_ofertas").update({ story_em: new Date().toISOString(), canais }).eq("id", o.id);
      return json({ ok: true });
    }
    if (body.acao === "ig_testar") {
      const t = await igToken(email);
      const eu = await ig("GET", "/me", { fields: "user_id,username,account_type", access_token: t });
      if (eu.account_type && !/BUSINESS|MEDIA_CREATOR|CREATOR/i.test(eu.account_type)) throw new Error("A conta do Instagram precisa ser profissional (Comercial ou Criador de conteúdo).");
      await db.from("achados_config").update({ ig_user_id: String(eu.user_id || eu.id), ig_usuario: eu.username, ig_msg: `Conectado: @${eu.username}` }).eq("dono", email);
      await renovarSeVencendo(email, null).catch(() => {});
      return json({ ok: true, usuario: eu.username });
    }
    if (body.acao === "ig_postar") {
      const o = await oferta();
      if (!o.link) throw new Error("Essa oferta ainda não tem link de afiliado.");
      return json({ ok: true, id: await publicarStory(email, o) });
    }
    if (body.acao === "alerta_vincular") {
      const t = await tgToken(email);
      // deno-lint-ignore no-explicit-any
      const ups: any[] = await tg(t, "getUpdates", { allowed_updates: ["message"], limit: 100 });
      const priv = ups.map((x) => x.message).filter((m) => m && m.chat && m.chat.type === "private").pop();
      if (!priv) throw new Error("Não achei sua conversa com o bot. Abra o bot no Telegram, toque em Iniciar (ou mande /start) e tente de novo.");
      await db.from("achados_config").update({ alerta_chat_id: String(priv.chat.id), alerta_desde: new Date().toISOString(), alerta_msg: `Avisos vão para ${priv.chat.first_name || "você"} no Telegram.` }).eq("dono", email);
      await tg(t, "sendMessage", { chat_id: priv.chat.id, text: "✅ Pronto! Vou te mandar aqui as ofertas da Hora do WhatsApp (com o botão que abre o texto pronto) e os achadões para o Story." });
      return json({ ok: true, nome: priv.chat.first_name || null });
    }
    if (body.acao === "alerta_testar") {
      const { data: cfg } = await db.from("achados_config").select("alerta_chat_id").eq("dono", email).single();
      if (!cfg?.alerta_chat_id) throw new Error("Vincule primeiro a sua conversa com o bot.");
      const hoje = new Date().toISOString().slice(0, 10);
      const { data } = await db.from("achados_ofertas").select("*").eq("dono", email).not("link", "is", null).eq("exemplo", false)
        .in("status", ["nova", "aprovada", "postada"]).or(`validade.is.null,validade.gte.${hoje}`).limit(300);
      const o = (data || []).sort((a: Oferta, b: Oferta) => pontuacao(b) - pontuacao(a))[0];
      if (!o) throw new Error("Não há oferta com link na fila para o teste.");
      await enviarAlerta(email, cfg.alerta_chat_id, o);
      return json({ ok: true, num: o.num });
    }
    if (body.acao === "wa_agora") {
      const { data: cfg } = await db.from("achados_config").select("alerta_chat_id,wa_desconto_min").eq("dono", email).single();
      if (!cfg?.alerta_chat_id) throw new Error("Vincule primeiro a sua conversa com o bot (cartão Aviso de achadão).");
      const o = await proximaParaWhatsApp(email, cfg.wa_desconto_min);
      if (!o) throw new Error("Não há oferta nova com link e desconto suficiente para o WhatsApp.");
      await enviarHoraWhatsApp(email, cfg.alerta_chat_id, o, "pedido agora");
      return json({ ok: true, num: o.num });
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
