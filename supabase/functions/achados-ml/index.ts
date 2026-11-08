// =====================================================================
// Caça Achados · conexão com o Mercado Livre (Supabase Edge Function "achados-ml")
//
//   GET  ?code=…&state=…        → retorno da autorização do Mercado Livre (OAuth)
//   GET  ?tarefa=buscar (cron)  → busca os mais vendidos com desconto de todos os donos conectados
//   POST { acao: "conectar" }   → devolve o endereço de autorização do Mercado Livre
//   POST { acao: "categorias" } → lista as categorias do Mercado Livre Brasil
//   POST { acao: "buscar" }     → busca agora (só do dono logado)
//   POST { acao: "desconectar" }
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
  const espera = ultimo + 250 - Date.now();
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

async function detalharItens(ids: string[], token: string, pos: Map<string, number>): Promise<Achado[]> {
  const out: Achado[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    // deno-lint-ignore no-explicit-any
    const res: any[] = (await ml(`/items?ids=${lote.join(",")}&attributes=id,title,price,original_price,permalink,thumbnail,secure_thumbnail,status`, token)) || [];
    for (const r of res) {
      const b = r && r.code === 200 ? r.body : null;
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
  for (const id of ids) {
    try {
      const p = await ml(`/products/${id}`, token);
      const w = p && p.buy_box_winner;
      if (!p || !w || w.price == null) continue;
      out.push({
        id: w.item_id || id, titulo: p.name, preco_por: Number(w.price),
        preco_de: w.original_price != null ? Number(w.original_price) : null,
        link_produto: p.permalink || `https://www.mercadolivre.com.br/p/${id}`,
        imagem: imgHttps(p.pictures?.[0]?.secure_url || p.pictures?.[0]?.url), posicao: pos.get(id) || 0,
      });
    } catch (_) { /* produto sem vencedor de compra ou indisponível */ }
  }
  return out;
}

async function buscar(dono: string, deadline: number) {
  const { data: cfg } = await db.from("achados_config").select("ml_conectado,ml_categorias,ml_categorias_nomes,desconto_min").eq("dono", dono).single();
  if (!cfg?.ml_conectado) throw new Error("O Mercado Livre não está conectado.");
  const cats: string[] = cfg.ml_categorias || [];
  if (!cats.length) throw new Error("Escolha pelo menos uma categoria em Ajustes.");
  const token = await tokenDe(dono);
  const min = Number(cfg.desconto_min || 0);
  let vistos = 0, achados = 0, novos = 0;
  const avisos: string[] = [];
  for (const cat of cats) {
    if (Date.now() > deadline) { avisos.push("O tempo acabou antes de todas as categorias; o resto entra na próxima busca."); break; }
    try {
      const h = await ml(`/highlights/MLB/category/${cat}`, token);
      // deno-lint-ignore no-explicit-any
      const content: any[] = (h && h.content) || [];
      const pos = new Map<string, number>(content.map((c) => [String(c.id), Number(c.position) || 0]));
      const itens = content.filter((c) => c.type === "ITEM").map((c) => String(c.id));
      const prods = content.filter((c) => c.type === "PRODUCT" || c.type === "USER_PRODUCT").map((c) => String(c.id)).slice(0, 20);
      const lista = [...await detalharItens(itens, token, pos), ...await detalharProdutos(prods, token, pos)];
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
  }
  const msg = `${vistos} mais vendidos conferidos, ${achados} com desconto de ${min}% ou mais (${novos} novos).${avisos.length ? " " + avisos.join(" ") : ""}`;
  await db.from("achados_config").update({ ml_sinc_em: new Date().toISOString(), ml_sinc_ok: avisos.length === 0, ml_sinc_msg: msg.slice(0, 600) }).eq("dono", dono);
  return { vistos, achados, novos, avisos, msg };
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
  const deadline = Date.now() + 120_000;
  try {
    if (req.method === "GET" && url.searchParams.has("code")) return await callback(url);
    if (req.method === "GET" && url.searchParams.has("error")) return new Response(null, { status: 302, headers: { Location: `${APP_URL}#ml-recusado` } });

    const tarefa = url.searchParams.get("tarefa");
    if (tarefa) {
      const chave = req.headers.get("x-cron-key") || "";
      const { data: seg } = await db.from("segredos").select("valor").eq("chave", "cron").maybeSingle();
      if (!seg || chave !== seg.valor) return json({ erro: "não autorizado" }, 401);
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
    if (body.acao === "desconectar") {
      await db.rpc("achados_ml_desconectar", { p_dono: email });
      return json({ ok: true });
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
