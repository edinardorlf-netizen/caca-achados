// =====================================================================
// Caça Achados · conexão com o Mercado Livre (Supabase Edge Function "achados-ml")
//
//   GET  ?code=…&state=…        → retorno da autorização do Mercado Livre (OAuth)
//   GET  ?tarefa=buscar (cron)  → busca os mais vendidos com desconto de todos os donos conectados
//   POST { acao: "conectar" }   → devolve o endereço de autorização do Mercado Livre
//   POST { acao: "categorias" } → lista as categorias do Mercado Livre Brasil
//   POST { acao: "buscar" }     → busca agora (só do dono logado)
//   POST { acao: "desconectar" }
//   POST { acao: "afiliado_ml", link } → aprende o código de afiliado a partir de um link e monta os links
//   POST { acao: "telegram_testar" | "telegram_postar", id } · GET ?tarefa=postar (cron) → posta no Telegram
//
// Só leitura no Mercado Livre (escopo de leitura + offline_access). O link de afiliado
// continua sendo gerado pelo dono no portal de afiliados.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const API = "https://api.mercadolibre.com";
const AUTH = "https://auth.mercadolivre.com.br/authorization";
const REDIRECT = `${SB_URL}/functions/v1/achados-ml`;
const APP_URL = "https://edinardorlf-netizen.github.io/caca-achados/";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Tokens ----------
async function segredos(dono: string) {
  const { data, error } = await db.rpc("achados_ml_segredos", { p_dono: dono });
  if (error) throw new Error(`Erro ao ler o cofre: ${error.message}`);
  return (data || [])[0] || {};
}

async function trocarToken(dono: string, body: Record<string, string>) {
  const r = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const msg = j.message || j.error_description || j.error || `status ${r.status}`;
    if (/invalid_grant|expired|revoked/i.test(String(j.error || msg))) {
      await db.from("achados_config").update({ ml_conectado: false, ml_sinc_ok: false, ml_sinc_msg: "A autorização do Mercado Livre expirou: conecte de novo." }).eq("dono", dono);
    }
    throw new Error(`Mercado Livre recusou o token: ${msg}`);
  }
  const exp = new Date(Date.now() + (Number(j.expires_in || 10800) - 300) * 1000).toISOString();
  const { error } = await db.rpc("achados_ml_gravar_tokens", { p_dono: dono, p_access: j.access_token, p_exp: exp, p_refresh: j.refresh_token || null });
  if (error) throw new Error(`Erro ao guardar o token: ${error.message}`);
  return j;
}

// Access token válido (renova com o refresh token quando vence; o refresh token é de uso único).
async function tokenDe(dono: string): Promise<string> {
  const s = await segredos(dono);
  if (s.access && s.access_exp && Date.parse(s.access_exp) > Date.now()) return s.access;
  if (!s.client_id || !s.secret) throw new Error("Falta o App ID ou a Secret Key do Mercado Livre.");
  if (!s.refresh) throw new Error("O Mercado Livre não está conectado.");
  const j = await trocarToken(dono, { grant_type: "refresh_token", client_id: s.client_id, client_secret: s.secret, refresh_token: s.refresh });
  return j.access_token;
}

let ultimo = 0;
// deno-lint-ignore no-explicit-any
async function ml(path: string, token: string): Promise<any> {
  const espera = ultimo + 60 - Date.now();
  if (espera > 0) await sleep(espera);
  ultimo = Date.now();
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (r.status === 404) return null;
  if (r.status === 429) throw new Error("O Mercado Livre pediu uma pausa (muitas consultas). Tente daqui a pouco.");
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Mercado Livre respondeu ${r.status} em ${path.split("?")[0]}: ${t.slice(0, 160)}`);
  }
  return r.json();
}

// ---------- Busca dos mais vendidos com desconto ----------
type Achado = { id: string; titulo: string; preco_por: number; preco_de: number | null; link_produto: string; imagem: string | null; posicao: number };

// deno-lint-ignore no-explicit-any
const imgHttps = (u?: string | null) => (u ? String(u).replace(/^http:/, "https:").replace(/-I\.jpg$/, "-O.jpg") : null);

// O Mercado Livre desativou a consulta em grupo de anúncios (/items?ids=) para apps de terceiros
// ("ResourceDeprecated"). Quando isso acontece, tentamos um a um (/items/{id}); se também for
// recusado, os anúncios avulsos ficam de fora e a categoria segue só com os produtos de catálogo.
let multigetBloqueado = false;
let itemBloqueado = false;
const recusado = (e: unknown) => /\b403\b|deprecated|forbidden/i.test((e as Error)?.message || "");

// deno-lint-ignore no-explicit-any
async function buscarItens(lote: string[], token: string): Promise<any[]> {
  const attrs = "attributes=id,title,price,original_price,permalink,thumbnail,secure_thumbnail,status";
  if (!multigetBloqueado) {
    try {
      // deno-lint-ignore no-explicit-any
      const res: any[] = (await ml(`/items?ids=${lote.join(",")}&${attrs}`, token)) || [];
      return res.map((r) => (r && r.code === 200 ? r.body : null));
    } catch (e) {
      if (!recusado(e)) throw e;
      multigetBloqueado = true;
    }
  }
  if (itemBloqueado) return [];
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (const id of lote) {
    try { out.push(await ml(`/items/${id}?${attrs}`, token)); }
    catch (e) { if (recusado(e)) { itemBloqueado = true; break; } }
  }
  return out;
}

async function detalharItens(ids: string[], token: string, pos: Map<string, number>): Promise<Achado[]> {
  const out: Achado[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const res = await buscarItens(lote, token);
    if (!res.length && itemBloqueado) break;
    for (const b of res) {
      if (!b || b.status !== "active") continue;
      let por = Number(b.price), de = b.original_price != null ? Number(b.original_price) : null;
      // O preço de promoção às vezes só aparece no "sale_price" do item.
      if (de == null) {
        try {
          const sp = await ml(`/items/${b.id}/sale_price`, token);
          if (sp && sp.amount) { por = Number(sp.amount); de = sp.regular_amount != null ? Number(sp.regular_amount) : null; }
        } catch (_) { /* segue com o preço do item */ }
      }
      out.push({ id: b.id, titulo: b.title, preco_por: por, preco_de: de, link_produto: b.permalink, imagem: imgHttps(b.secure_thumbnail || b.thumbnail), posicao: pos.get(b.id) || 0 });
    }
  }
  return out;
}

async function detalharProdutos(ids: string[], token: string, pos: Map<string, number>): Promise<Achado[]> {
  const out: Achado[] = [];
  const fila = [...ids];
  const trabalhador = async () => {
   while (fila.length) {
    const id = fila.shift()!;
    try {
      const p = await ml(`/products/${id}`, token);
      if (!p) continue;
      // O "buy_box_winner" costuma vir vazio; as ofertas do produto ficam em /products/{id}/items.
      let w = p.buy_box_winner;
      if (!w || w.price == null) {
        const its = await ml(`/products/${id}/items`, token).catch(() => null);
        // deno-lint-ignore no-explicit-any
        const rs: any[] = (its && its.results) || [];
        w = rs.filter((r) => r.price != null).sort((a, b) => Number(a.price) - Number(b.price))[0];
      }
      if (!w || w.price == null) continue;
      out.push({
        id: w.item_id || id, titulo: p.name, preco_por: Number(w.price),
        preco_de: w.original_price != null ? Number(w.original_price) : null,
        link_produto: p.permalink || `https://www.mercadolivre.com.br/p/${id}`,
        imagem: imgHttps(p.pictures?.[0]?.secure_url || p.pictures?.[0]?.url), posicao: pos.get(id) || 0,
      });
    } catch (_) { /* produto sem oferta ativa ou indisponível */ }
   }
  };
  await Promise.all([trabalhador(), trabalhador(), trabalhador(), trabalhador()]);
  return out;
}

async function buscar(dono: string, deadline: number) {
  const { data: cfg } = await db.from("achados_config").select("ml_conectado,ml_categorias,ml_categorias_nomes,desconto_min,ml_cat_cursor").eq("dono", dono).single();
  if (!cfg?.ml_conectado) throw new Error("O Mercado Livre não está conectado.");
  const todas: string[] = cfg.ml_categorias || [];
  if (!todas.length) throw new Error("Escolha pelo menos uma categoria em Ajustes.");
  // Rodízio: cada busca começa de onde a anterior parou, para todas as categorias serem visitadas
  const ini = Math.max(0, Number(cfg.ml_cat_cursor || 0)) % todas.length;
  const cats = [...todas.slice(ini), ...todas.slice(0, ini)];
  let feitas = 0;
  const token = await tokenDe(dono);
  const min = Number(cfg.desconto_min || 0);
  let vistos = 0, achados = 0, novos = 0, itensAvulsos = 0;
  const avisos: string[] = [];
  multigetBloqueado = false; itemBloqueado = false;
  for (const cat of cats) {
    if (Date.now() > deadline) break;
    try {
      const h = await ml(`/highlights/MLB/category/${cat}`, token);
      // deno-lint-ignore no-explicit-any
      const content: any[] = (h && h.content) || [];
      const pos = new Map<string, number>(content.map((c) => [String(c.id), Number(c.position) || 0]));
      const itens = content.filter((c) => c.type === "ITEM").map((c) => String(c.id));
      const prods = content.filter((c) => c.type === "PRODUCT" || c.type === "USER_PRODUCT").map((c) => String(c.id)).slice(0, 20);
      let doItens: Achado[] = [];
      try { doItens = await detalharItens(itens, token, pos); }
      catch (e) { avisos.push(`${(cfg.ml_categorias_nomes || {})[cat] || cat}: anúncios avulsos indisponíveis (${(e as Error).message.slice(0, 80)})`); }
      const lista = [...doItens, ...await detalharProdutos(prods, token, pos)];
      if (itens.length) itensAvulsos += itens.length;
      vistos += lista.length;
      const bons = lista.filter((a) => a.preco_de && a.preco_de > a.preco_por && Math.round((1 - a.preco_por / a.preco_de) * 100) >= min);
      achados += bons.length;
      if (bons.length) {
        const ids = bons.map((a) => a.id);
        const { data: ja } = await db.from("achados_ofertas").select("ml_item_id").eq("dono", dono).in("ml_item_id", ids);
        const jaTem = new Set((ja || []).map((x) => x.ml_item_id));
        novos += ids.filter((x) => !jaTem.has(x)).length;
        const nomeCat = (cfg.ml_categorias_nomes || {})[cat] || null;
        const linhas = bons.map((a) => ({
          dono, titulo: a.titulo, marketplace: "meli", fonte: "ml", ml_item_id: a.id, ml_categoria: cat, ml_posicao: a.posicao,
          categoria: nomeCat, link_produto: a.link_produto, preco_de: a.preco_de, preco_por: a.preco_por, imagem: a.imagem,
        }));
        const { error } = await db.from("achados_ofertas").upsert(linhas, { onConflict: "dono,ml_item_id" });
        if (error) throw new Error(`Erro ao salvar ofertas: ${error.message}`);
      }
    } catch (e) {
      avisos.push(`${(cfg.ml_categorias_nomes || {})[cat] || cat}: ${(e as Error).message}`);
    }
    feitas++;
  }
  await db.from("achados_config").update({ ml_cat_cursor: (ini + feitas) % todas.length }).eq("dono", dono);
  const rodizio = feitas < todas.length ? ` ${feitas} de ${todas.length} categorias nesta busca; as outras entram na próxima.` : "";
  // Monta o link de afiliado nas ofertas novas (se o modelo do link já foi configurado)
  const { data: nAfil } = await db.rpc("achados_aplicar_afiliado", { p_dono: dono });
  const nota = itemBloqueado && itensAvulsos ? ` ${itensAvulsos} anúncios avulsos ficaram de fora (o Mercado Livre não libera mais esses dados para apps de terceiros); os produtos de catálogo entraram normalmente.` : "";
  const msg = `${vistos} mais vendidos conferidos, ${achados} com desconto de ${min}% ou mais (${novos} novos).${nAfil ? ` ${nAfil} com link de afiliado montado.` : ""}${rodizio}${nota}${avisos.length ? " " + avisos.join(" ") : ""}`;
  await db.from("achados_config").update({ ml_sinc_em: new Date().toISOString(), ml_sinc_ok: avisos.length === 0, ml_sinc_msg: msg.slice(0, 600) }).eq("dono", dono);
  return { vistos, achados, novos, avisos, msg };
}

// ---------- Link de afiliado do Mercado Livre (modelo) ----------
// O dono cola um link de afiliado (curto ou completo). Seguimos os redirecionamentos até o endereço
// final e guardamos só os parâmetros que identificam o afiliado, para repetir em qualquer produto.
const PARAM_AFILIADO = /^(matt_[a-z_]+|forceinapp|aff[a-z_]*|tracking_id_afiliado)$/i; // "ref" fica de fora: é cifrado e vale só para o produto do link
const DOMINIO_ML = /(^|\.)(mercadolivre\.com(\.br)?|mercadolibre\.com|meli\.la)$/i;

async function resolverLink(link: string) {
  let atual = link.trim();
  const caminho: string[] = [atual];
  for (let i = 0; i < 8; i++) {
    const u = new URL(atual);
    if (!DOMINIO_ML.test(u.hostname)) throw new Error("O link precisa ser do Mercado Livre.");
    if ([...u.searchParams.keys()].some((k) => PARAM_AFILIADO.test(k))) break;
    // Verificação anti-robô do Mercado Livre: o endereço de destino vem no parâmetro "go".
    const go = u.searchParams.get("go");
    if (/verification|captcha/i.test(u.pathname) && go) { atual = new URL(go, atual).toString(); caminho.push(atual); break; }
    const r = await fetch(atual, { redirect: "manual", headers: { "User-Agent": "CacaAchados/1.0", Accept: "text/html" } });
    const loc = r.headers.get("location");
    await r.body?.cancel();
    if (!(r.status >= 300 && r.status < 400) || !loc) break;
    atual = new URL(loc, atual).toString();
    caminho.push(atual);
  }
  const final = new URL(atual);
  const params = [...final.searchParams.entries()].filter(([k]) => PARAM_AFILIADO.test(k));
  return { final: atual, caminho, params, todos: [...final.searchParams.keys()] };
}

// ---------- Telegram ----------
const brl = (v: number | null) => (v == null || isNaN(v) ? "" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const escHtml = (s: string) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
// deno-lint-ignore no-explicit-any
const descontoDe = (o: any) => (o.preco_de && o.preco_por && Number(o.preco_de) > Number(o.preco_por) ? Math.round((1 - Number(o.preco_por) / Number(o.preco_de)) * 100) : null);
// deno-lint-ignore no-explicit-any
const pontuacao = (o: any) => Math.round((descontoDe(o) || 0) * 1.2 + (o.comissao || 0) * 2 + (o.cupom ? 8 : 0) + (o.ml_posicao ? Math.max(0, 12 - o.ml_posicao) : 0));
const LOJA: Record<string, string> = { shopee: "na Shopee", meli: "no Mercado Livre", amazon: "na Amazon", tiktok: "no TikTok Shop" };

// deno-lint-ignore no-explicit-any
function postTelegram(o: any) {
  const d = descontoDe(o);
  const linhas = [
    `${d && d >= 40 ? "🔥 ACHADÃO" : "🛒 ACHADO DO DIA"} ${LOJA[o.marketplace] || ""}`.trim(), "",
    `<b>${escHtml(String(o.titulo).slice(0, 200))}</b>`, "",
    o.preco_de && d ? `<s>De ${brl(Number(o.preco_de))}</s>` : null,
    `✅ <b>Por ${brl(Number(o.preco_por))}</b>${d ? ` (${d}% OFF)` : ""}`,
    o.cupom ? `🎟️ Cupom: <b>${escHtml(o.cupom)}</b>` : null,
    o.nota ? `📌 ${escHtml(o.nota)}` : null, "",
    `👉 <a href="${escHtml(o.link)}">Pegar a oferta</a>`, "",
    "⚠️ Preço e estoque podem mudar a qualquer momento.",
    "— O Cara dos Achados",
  ];
  return linhas.filter((x) => x !== null).join("\n");
}

async function tg(token: string, metodo: string, corpo: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram: ${j.description || `erro ${r.status}`}`);
  return j.result;
}

async function configTg(dono: string) {
  const { data: tok } = await db.rpc("achados_tg_token", { p_dono: dono });
  const { data: cfg } = await db.from("achados_config").select("tg_chat_id,tg_ativo,tg_intervalo_min,tg_hora_ini,tg_hora_fim,tg_modo,tg_desconto_min,tg_ultimo_post,tg_qtd").eq("dono", dono).single();
  if (!tok) throw new Error("Falta o token do bot do Telegram.");
  if (!cfg?.tg_chat_id) throw new Error("Falta o canal ou grupo do Telegram.");
  return { token: tok as string, cfg };
}

// deno-lint-ignore no-explicit-any
async function enviarOferta(dono: string, token: string, chat: string, o: any) {
  const texto = postTelegram(o);
  try {
    if (o.imagem && texto.length <= 1024) await tg(token, "sendPhoto", { chat_id: chat, photo: o.imagem, caption: texto, parse_mode: "HTML" });
    else throw new Error("sem foto");
  } catch (_) {
    await tg(token, "sendMessage", { chat_id: chat, text: texto, parse_mode: "HTML", link_preview_options: { is_disabled: false } });
  }
  const agora = new Date().toISOString();
  const canais = [...new Set([...(o.canais || []), "telegram"])];
  await db.from("achados_ofertas").update({ status: "postada", postado_em: agora, canais }).eq("id", o.id).eq("dono", dono);
  await db.from("achados_config").update({ tg_ultimo_post: agora, tg_msg: `Postado: ${String(o.titulo).slice(0, 80)}` }).eq("dono", dono);
}

async function proximaOferta(dono: string, modo: string, minDesc: number) {
  const hoje = new Date().toISOString().slice(0, 10);
  let q = db.from("achados_ofertas").select("*").eq("dono", dono).not("link", "is", null).eq("exemplo", false)
    .or(`validade.is.null,validade.gte.${hoje}`).limit(300);
  q = modo === "aprovadas" ? q.eq("status", "aprovada") : q.in("status", ["nova", "aprovada"]);
  const { data } = await q;
  // deno-lint-ignore no-explicit-any
  const lst = (data || []).filter((o: any) => (descontoDe(o) || 0) >= minDesc);
  // deno-lint-ignore no-explicit-any
  lst.sort((a: any, b: any) => (b.status === "aprovada" ? 1 : 0) - (a.status === "aprovada" ? 1 : 0) || pontuacao(b) - pontuacao(a));
  return lst[0] || null;
}

function horaSP() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hourCycle: "h23" }).format(new Date()));
}

async function postarAgendado() {
  const { data: donos } = await db.from("achados_config").select("dono").eq("tg_ativo", true);
  const res: Record<string, unknown> = {};
  for (const { dono } of donos || []) {
    try {
      const { token, cfg } = await configTg(dono);
      const h = horaSP();
      if (h < cfg.tg_hora_ini || h >= cfg.tg_hora_fim) { res[dono] = "fora do horário"; continue; }
      if (cfg.tg_ultimo_post && Date.now() - Date.parse(cfg.tg_ultimo_post) < (cfg.tg_intervalo_min * 60 - 30) * 1000) { res[dono] = "aguardando intervalo"; continue; }
      const qtd = Math.max(1, Math.min(30, Number(cfg.tg_qtd) || 1));
      let feitos = 0;
      for (let i = 0; i < qtd; i++) {
        const o = await proximaOferta(dono, cfg.tg_modo, cfg.tg_desconto_min);
        if (!o) break;
        if (i > 0) await sleep(1500); // o Telegram limita as mensagens por minuto
        await enviarOferta(dono, token, cfg.tg_chat_id, o);
        feitos++;
      }
      if (!feitos) { res[dono] = "nada para postar"; await db.from("achados_config").update({ tg_msg: "Nenhuma oferta com link e desconto suficiente na fila." }).eq("dono", dono); continue; }
      if (feitos > 1) await db.from("achados_config").update({ tg_msg: `Postei ${feitos} ofertas de uma vez` }).eq("dono", dono);
      res[dono] = `postadas ${feitos}`;
    } catch (e) {
      res[dono] = { erro: (e as Error).message };
      await db.from("achados_config").update({ tg_msg: (e as Error).message.slice(0, 300) }).eq("dono", dono);
    }
  }
  return res;
}

// ---------- Retorno da autorização ----------
async function callback(url: URL) {
  const volta = (q: string) => new Response(null, { status: 302, headers: { Location: `${APP_URL}#ml-${q}` } });
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code || !/^[a-f0-9]{32,64}$/.test(state)) return volta("erro");
  const { data: cfg } = await db.from("achados_config").select("dono,ml_state_em").eq("ml_state", state).maybeSingle();
  if (!cfg || !cfg.ml_state_em || Date.now() - Date.parse(cfg.ml_state_em) > 15 * 60e3) return volta("expirou");
  const dono = cfg.dono;
  await db.from("achados_config").update({ ml_state: null }).eq("dono", dono);
  try {
    const s = await segredos(dono);
    const j = await trocarToken(dono, { grant_type: "authorization_code", client_id: s.client_id, client_secret: s.secret, code, redirect_uri: REDIRECT });
    const eu = await ml("/users/me", j.access_token).catch(() => null);
    await db.from("achados_config").update({ ml_conectado: true, ml_user_id: eu?.id ?? j.user_id ?? null, ml_nickname: eu?.nickname ?? null, ml_sinc_msg: null }).eq("dono", dono);
    return volta("ok");
  } catch (e) {
    await db.from("achados_config").update({ ml_sinc_ok: false, ml_sinc_msg: String((e as Error).message).slice(0, 300) }).eq("dono", dono);
    return volta("erro");
  }
}

// ---------- Entrada ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const deadline = Date.now() + 110_000;
  try {
    if (req.method === "GET" && url.searchParams.has("code")) return await callback(url);
    if (req.method === "GET" && url.searchParams.has("error")) return new Response(null, { status: 302, headers: { Location: `${APP_URL}#ml-recusado` } });

    const tarefa = url.searchParams.get("tarefa");
    if (tarefa) {
      const chave = req.headers.get("x-cron-key") || "";
      const { data: seg } = await db.from("segredos").select("valor").eq("chave", "cron").maybeSingle();
      if (!seg || chave !== seg.valor) return json({ erro: "não autorizado" }, 401);
      if (tarefa === "postar") return json(await postarAgendado());
      if (tarefa !== "buscar") return json({ erro: "tarefa desconhecida" }, 400);
      const { data: donos } = await db.from("achados_config").select("dono").eq("ml_conectado", true);
      const res: Record<string, unknown> = {};
      for (const d of donos || []) {
        try { res[d.dono] = await buscar(d.dono, deadline); }
        catch (e) {
          res[d.dono] = { erro: (e as Error).message };
          await db.from("achados_config").update({ ml_sinc_em: new Date().toISOString(), ml_sinc_ok: false, ml_sinc_msg: (e as Error).message }).eq("dono", d.dono);
        }
      }
      return json(res);
    }

    // Ações do app: só o dono do Caça Achados
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(token);
    const email = (u?.user?.email || "").toLowerCase();
    if (!email) return json({ erro: "Faça login novamente." }, 401);
    const { data: dono } = await db.from("achados_donos").select("email").eq("email", email).maybeSingle();
    if (!dono) return json({ erro: "Seu acesso ao Caça Achados não está liberado." }, 403);

    const body = await req.json().catch(() => ({}));
    if (body.acao === "conectar") {
      const s = await segredos(email);
      if (!s.client_id || !s.secret) return json({ erro: "Salve primeiro o App ID e a Secret Key." }, 400);
      const state = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
      await db.from("achados_config").update({ ml_state: state, ml_state_em: new Date().toISOString() }).eq("dono", email);
      const q = new URLSearchParams({ response_type: "code", client_id: s.client_id, redirect_uri: REDIRECT, state });
      return json({ url: `${AUTH}?${q}` });
    }
    if (body.acao === "categorias") {
      const t = await tokenDe(email);
      const cats = (await ml("/sites/MLB/categories", t)) || [];
      return json({ categorias: cats });
    }
    if (body.acao === "buscar") return json(await buscar(email, deadline));
    if (body.acao === "afiliado_ml") {
      const link = String(body.link || "");
      if (!/^https?:\/\//i.test(link)) return json({ erro: "Cole o link completo, começando com https://" }, 400);
      const r = await resolverLink(link);
      if (!r.params.length) {
        const onde = new URL(r.final);
        return json({ erro: `Não encontrei o seu código de afiliado nesse link (ele termina em ${onde.hostname}${onde.pathname.slice(0, 40)}${r.todos.length ? `, com: ${r.todos.slice(0, 12).join(", ")}` : ", sem parâmetros"}). Gere pelo portal de afiliados escolhendo “link completo”, ou use o Compartilhar logado como afiliado.` }, 422);
      }
      const query = r.params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      await db.from("achados_config").update({ ml_afiliado_query: query, ml_afiliado_exemplo: r.final.slice(0, 1000), ml_afiliado_em: new Date().toISOString() }).eq("dono", email);
      const { data: n } = await db.rpc("achados_aplicar_afiliado", { p_dono: email });
      return json({ ok: true, parametros: r.params.map(([k]) => k), aplicados: n || 0 });
    }
    if (body.acao === "afiliado_ml_remover") {
      await db.from("achados_ofertas").update({ link: null, link_auto: false }).eq("dono", email).eq("link_auto", true).in("status", ["nova", "aprovada"]);
      await db.from("achados_config").update({ ml_afiliado_query: null, ml_afiliado_exemplo: null, ml_afiliado_em: null }).eq("dono", email);
      return json({ ok: true });
    }
    if (body.acao === "telegram_testar") {
      const { token, cfg } = await configTg(email);
      const bot = await tg(token, "getMe", {});
      const chat = await tg(token, "getChat", { chat_id: cfg.tg_chat_id });
      await tg(token, "sendMessage", { chat_id: cfg.tg_chat_id, text: "✅ Caça Achados conectado. As ofertas vão aparecer aqui.\n— O Cara dos Achados" });
      const nome = chat.title || chat.username || String(chat.id);
      await db.from("achados_config").update({ tg_chat_nome: nome, tg_msg: `Conectado: @${bot.username} → ${nome}` }).eq("dono", email);
      return json({ ok: true, bot: bot.username, chat: nome });
    }
    if (body.acao === "telegram_postar") {
      const { token, cfg } = await configTg(email);
      const { data: o } = await db.from("achados_ofertas").select("*").eq("dono", email).eq("id", String(body.id || "")).maybeSingle();
      if (!o) return json({ erro: "Oferta não encontrada." }, 404);
      if (!o.link) return json({ erro: "Essa oferta ainda não tem link de afiliado." }, 400);
      await enviarOferta(email, token, cfg.tg_chat_id, o);
      return json({ ok: true });
    }
    if (body.acao === "desconectar") {
      await db.rpc("achados_ml_desconectar", { p_dono: email });
      return json({ ok: true });
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
