// =====================================================================
// Caça Achados · Shopee (Supabase Edge Function "achados-shopee")
//
// Usa a Open API oficial de afiliados da Shopee (GraphQL). Cada oferta já vem com o
// link de afiliado do dono ("offerLink") e a comissão.
//
//   GET  ?tarefa=buscar (cron, x-cron-key) → busca para todos os donos com a Shopee configurada
//   POST { acao: "testar" }  → confere o AppID/Secret com uma consulta pequena
//   POST { acao: "buscar" }  → busca agora (só do dono logado)
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const API = "https://open-api.affiliate.shopee.com.br/graphql";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ERROS: Record<string, string> = {
  "10020": "AppID ou Secret inválidos (ou relógio fora do horário).",
  "10030": "Limite de consultas da Shopee atingido. Tente daqui a pouco.",
  "10031": "Acesso negado pela Shopee.",
  "10035": "A Shopee ainda não liberou a Open API para a sua conta de afiliado.",
};

async function sha256(texto: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Assinatura: SHA256(AppId + Timestamp + Payload + Secret), conforme a documentação oficial
// deno-lint-ignore no-explicit-any
async function gql(appId: string, secret: string, query: string): Promise<any> {
  const payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000).toString();
  const assinatura = await sha256(appId + ts + payload + secret);
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${assinatura}` },
    body: payload,
  });
  const j = await r.json().catch(() => ({}));
  if (j.errors?.length) {
    const e = j.errors[0];
    const cod = String(e.extensions?.code ?? "");
    throw new Error(ERROS[cod] || `Shopee: ${e.message || "erro"}${cod ? ` (${cod})` : ""}`);
  }
  if (!r.ok) throw new Error(`Shopee respondeu ${r.status}`);
  return j.data;
}

const CAMPOS = "itemId productName priceMin priceMax priceDiscountRate commissionRate imageUrl productLink offerLink sales ratingStar shopName periodEndTime";

async function credenciais(dono: string) {
  const { data, error } = await db.rpc("achados_shp_segredo", { p_dono: dono });
  if (error) throw new Error(`Erro ao ler o cofre: ${error.message}`);
  const s = (data || [])[0] || {};
  if (!s.app_id || !s.secret) throw new Error("Falta o AppID ou a Secret da Shopee.");
  return { appId: s.app_id as string, secret: s.secret as string };
}

async function buscar(dono: string, deadline: number) {
  const { appId, secret } = await credenciais(dono);
  const { data: cfg } = await db.from("achados_config").select("shp_palavras,shp_top,shp_desconto_min,shp_comissao_min,shp_cursor,shp_pag").eq("dono", dono).single();
  const consultas: { nome: string; q: string; pg?: number }[] = [];
  // Mais vendidos: 5 páginas de 50 por busca, em rodízio (página 1 sempre, para pegar o topo do momento)
  const pag0 = Math.max(2, Number(cfg?.shp_pag || 2));
  const paginas = cfg?.shp_top !== false ? [1, pag0, pag0 + 1, pag0 + 2, pag0 + 3] : [];
  for (const pg of paginas) consultas.push({ nome: "Mais vendidos", pg, q: `{productOfferV2(listType: 2, limit: 50, page: ${pg}){nodes{${CAMPOS}}}}` });
  // Rodízio (como as categorias do Mercado Livre): até 10 palavras por busca, continuando de onde a anterior parou
  const todas: string[] = cfg?.shp_palavras || [];
  const ini = todas.length ? Math.max(0, Number(cfg?.shp_cursor || 0)) % todas.length : 0;
  const daVez = [...todas.slice(ini), ...todas.slice(0, ini)].slice(0, 10);
  if (todas.length) await db.from("achados_config").update({ shp_cursor: (ini + daVez.length) % todas.length }).eq("dono", dono);
  for (const p of daVez) {
    consultas.push({ nome: p, q: `{productOfferV2(keyword: ${JSON.stringify(p)}, sortType: 2, limit: 30, page: 1){nodes{${CAMPOS}}}}` });
  }
  const minDesc = Number(cfg?.shp_desconto_min ?? 30), minCom = Number(cfg?.shp_comissao_min ?? 0);
  // deno-lint-ignore no-explicit-any
  const vistos = new Map<string, { o: any; cat: string }>();
  const avisos: string[] = [];
  let fimLista = false, semPalavra = false;
  for (const c of consultas) {
    if (Date.now() > deadline) { avisos.push("O tempo acabou; o resto entra na próxima busca."); break; }
    if (semPalavra && !c.pg) continue;
    try {
      const d = await gql(appId, secret, c.q);
      const nodes = d?.productOfferV2?.nodes || [];
      if (c.pg && c.pg > 1 && nodes.length < 50) fimLista = true;
      for (const n of nodes) if (n?.itemId && !vistos.has(String(n.itemId))) vistos.set(String(n.itemId), { o: n, cat: c.nome });
    } catch (e) {
      const m = (e as Error).message;
      if (/AppID|liberou|negado/.test(m)) throw e; // problema de acesso: não adianta seguir
      // A Shopee às vezes desliga a busca por palavra (erro 10000): avisa uma vez e segue só com os mais vendidos
      if (!c.pg && /10000/.test(m)) { semPalavra = true; avisos.push("Busca por palavra indisponível na Shopee agora (erro 10000); usando só os mais vendidos."); continue; }
      avisos.push(`${c.nome}: ${m}`);
    }
  }
  if (paginas.length) await db.from("achados_config").update({ shp_pag: fimLista || pag0 + 4 > 40 ? 2 : pag0 + 4 }).eq("dono", dono);
  const hoje = Date.now() / 1000;
  const bons = [...vistos.values()].filter(({ o }) => {
    const desc = Number(o.priceDiscountRate || 0), com = Number(o.commissionRate || 0) * 100;
    return o.offerLink && Number(o.priceMin) > 0 && desc >= minDesc && com >= minCom && (!o.periodEndTime || o.periodEndTime > hoje);
  });
  let novos = 0;
  if (bons.length) {
    const ids = bons.map(({ o }) => String(o.itemId));
    const { data: ja } = await db.from("achados_ofertas").select("shp_item_id").eq("dono", dono).in("shp_item_id", ids);
    const jaTem = new Set((ja || []).map((x) => x.shp_item_id));
    novos = ids.filter((x) => !jaTem.has(x)).length;
    const linhas = bons.map(({ o, cat }) => {
      const por = Number(o.priceMin), desc = Number(o.priceDiscountRate || 0);
      const de = desc > 0 && desc < 100 ? Math.round((por / (1 - desc / 100)) * 100) / 100 : null;
      const fim = o.periodEndTime ? new Date(o.periodEndTime * 1000).toISOString().slice(0, 10) : null;
      return {
        dono, titulo: String(o.productName).slice(0, 300), marketplace: "shopee", fonte: "shopee", shp_item_id: String(o.itemId),
        categoria: cat === "Mais vendidos" ? null : cat, link: o.offerLink, link_produto: o.productLink, preco_de: de, preco_por: por,
        comissao: o.commissionRate != null ? Math.round(Number(o.commissionRate) * 1000) / 10 : null,
        imagem: o.imageUrl || null, validade: fim && fim < "2100-01-01" ? fim : null,
      };
    });
    const { error } = await db.from("achados_ofertas").upsert(linhas, { onConflict: "dono,shp_item_id" });
    if (error) throw new Error(`Erro ao salvar ofertas: ${error.message}`);
  }
  const rodizio = todas.length > daVez.length ? ` ${daVez.length} de ${todas.length} palavras nesta busca; as outras entram na próxima.` : "";
  const msg = `${vistos.size} produtos conferidos, ${bons.length} com ${minDesc}% OFF ou mais (${novos} novos).${rodizio}${avisos.length ? " " + avisos.join(" ") : ""}`;
  await db.from("achados_config").update({ shp_sinc_em: new Date().toISOString(), shp_sinc_ok: avisos.filter((a) => !a.startsWith("Busca por palavra")).length === 0, shp_sinc_msg: msg.slice(0, 600) }).eq("dono", dono);
  return { vistos: vistos.size, achados: bons.length, novos, avisos, msg };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const deadline = Date.now() + 120_000;
  try {
    const tarefa = url.searchParams.get("tarefa");
    if (tarefa) {
      const chave = req.headers.get("x-cron-key") || "";
      const { data: seg } = await db.from("segredos").select("valor").eq("chave", "cron").maybeSingle();
      if (!seg || chave !== seg.valor) return json({ erro: "não autorizado" }, 401);
      if (tarefa !== "buscar") return json({ erro: "tarefa desconhecida" }, 400);
      const { data: donos } = await db.from("achados_config").select("dono").eq("shp_ativo", true).not("shp_app_id", "is", null).not("shp_secret_id", "is", null);
      const res: Record<string, unknown> = {};
      for (const d of donos || []) {
        try { res[d.dono] = await buscar(d.dono, deadline); }
        catch (e) {
          res[d.dono] = { erro: (e as Error).message };
          await db.from("achados_config").update({ shp_sinc_em: new Date().toISOString(), shp_sinc_ok: false, shp_sinc_msg: (e as Error).message }).eq("dono", d.dono);
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
    if (body.acao === "testar") {
      const { appId, secret } = await credenciais(email);
      const d = await gql(appId, secret, `{productOfferV2(listType: 2, limit: 1, page: 1){nodes{itemId productName offerLink}}}`);
      const n = d?.productOfferV2?.nodes?.[0];
      await db.from("achados_config").update({ shp_sinc_ok: true, shp_sinc_msg: "Shopee conectada." }).eq("dono", email);
      return json({ ok: true, exemplo: n ? { titulo: n.productName, link: n.offerLink } : null });
    }
    if (body.acao === "buscar") {
      try { return json(await buscar(email, deadline)); }
      catch (e) {
        await db.from("achados_config").update({ shp_sinc_em: new Date().toISOString(), shp_sinc_ok: false, shp_sinc_msg: (e as Error).message }).eq("dono", email);
        throw e;
      }
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
