// =====================================================================
// Caça Achados · Estúdio IA, etapa 1 (Supabase Edge Function "achados-estudio")
//
//   POST { acao: "minerar" }              → dá nota (0–100) às ofertas abertas e devolve as melhores
//   POST { acao: "escrever", id }         → escreve o gancho da oferta no estilo da Persona (Claude, se houver chave; senão modelos prontos)
//   POST { acao: "aprovar", id, texto? }  → aprova (e salva o texto editado)
//   POST { acao: "rejeitar", id }
//
// A IA só escreve o "gancho" (1–2 frases). Título, preços, cupom e links vêm sempre dos dados da oferta,
// para a IA não inventar preço nem estoque.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type Oferta = any;
const brl = (v: number | null) => (v == null ? "" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const descontoDe = (o: Oferta) => (o.preco_de && o.preco_por && Number(o.preco_de) > Number(o.preco_por) ? Math.round((1 - Number(o.preco_por) / Number(o.preco_de)) * 100) : null);

const PERSONA_PADRAO = "O Cara dos Achados: direto, bem-humorado e brasileiro. Fala como um amigo que avisa de promoção boa. Frases curtas. No máximo 2 emojis. Nunca promete estoque, prazo ou preço futuro.";

// ---------- Minerador ----------
function nota(o: Oferta): { score: number; motivos: string[] } {
  const d = descontoDe(o) || 0, motivos: string[] = [];
  let s = 0;
  const pd = Math.min(d, 80) * 0.7; s += pd; if (d >= 40) motivos.push(`${d}% de desconto`); else if (d >= 20) motivos.push(`${d}% off`);
  if (o.comissao) { s += Math.min(Number(o.comissao), 15) * 2; if (Number(o.comissao) >= 8) motivos.push(`comissão ${Number(o.comissao)}%`); }
  if (o.cupom) { s += 6; motivos.push("tem cupom"); }
  if (o.ml_posicao) { s += Math.max(0, 12 - Number(o.ml_posicao)); if (Number(o.ml_posicao) <= 5) motivos.push(`top ${o.ml_posicao} mais vendidos`); }
  const p = Number(o.preco_por) || 0;
  if (p >= 25 && p <= 250) { s += 8; motivos.push("faixa de preço que converte"); }
  else if (p > 600) s -= 6; // ticket muito alto vende devagar em canal de ofertas
  if (o.imagem) s += 4; else { s -= 6; motivos.push("sem foto"); }
  if (o.afiliados != null) { if (o.afiliados <= 100) { s += 8; motivos.push(`só ${o.afiliados} afiliados`); } else if (o.afiliados <= 300) { s += 4; motivos.push(`${o.afiliados} afiliados`); } else { s -= 8; motivos.push(`${o.afiliados} afiliados (concorrido)`); } }
  if (!o.link) s -= 30;
  return { score: Math.max(0, Math.min(100, Math.round(s))), motivos };
}

async function minerar(dono: string) {
  const hoje = new Date().toISOString().slice(0, 10);
  const { data } = await db.from("achados_ofertas").select("*").eq("dono", dono).eq("exemplo", false)
    .in("status", ["nova", "aprovada"]).or(`validade.is.null,validade.gte.${hoje}`).limit(1000);
  const lst: Oferta[] = data || [];
  for (let i = 0; i < lst.length; i += 50) {
    await Promise.all(lst.slice(i, i + 50).map((o) => {
      const n = nota(o);
      return db.from("achados_ofertas").update({ est_score: n.score, est_motivos: n.motivos }).eq("id", o.id).eq("dono", dono);
    }));
  }
  return { avaliadas: lst.length };
}

// ---------- Persona ----------
const GANCHOS = {
  forte: [
    (o: Oferta, d: number) => `Isso caiu ${d}%. Se estava na sua lista, hoje é o dia.`,
    (o: Oferta, d: number) => `${d}% de desconto numa coisa que muita gente usa todo dia.`,
    (o: Oferta, d: number) => `Olha a diferença de preço: dá pra economizar ${brl(Number(o.preco_de) - Number(o.preco_por))} aqui.`,
  ],
  medio: [
    (o: Oferta, d: number) => `Preço bom (${d}% abaixo). Vale conferir.`,
    (o: Oferta, d: number) => `Achei esse com ${d}% de desconto. Compara e decide.`,
    (o: Oferta, _d: number) => `Caiu pra ${brl(Number(o.preco_por))}. Fica o aviso.`,
  ],
  simples: [
    (o: Oferta, _d: number) => `Achado do dia por ${brl(Number(o.preco_por))}.`,
    (o: Oferta, _d: number) => `Dica rápida: tá ${brl(Number(o.preco_por))} agora.`,
  ],
};
function ganchoModelo(o: Oferta): string {
  const d = descontoDe(o) || 0;
  const grupo = d >= 40 ? GANCHOS.forte : d >= 15 ? GANCHOS.medio : GANCHOS.simples;
  const i = Math.abs([...String(o.id)].reduce((a, c) => a + c.charCodeAt(0), 0)) % grupo.length;
  return grupo[i](o, d);
}

async function ganchoIA(o: Oferta, persona: string, chave: string): Promise<string> {
  const d = descontoDe(o);
  const dados = [
    `Produto: ${String(o.titulo).slice(0, 160)}`, `Loja: ${o.marketplace}`,
    o.preco_de && d ? `Preço antigo: ${brl(Number(o.preco_de))}` : null, `Preço atual: ${brl(Number(o.preco_por))}`, d ? `Desconto: ${d}%` : null,
    o.cupom ? `Cupom: ${o.cupom}` : null, o.nota ? `Observação: ${o.nota}` : null,
  ].filter(Boolean).join("\n");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": chave, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-5-5", max_tokens: 200,
      system: `Você escreve o gancho de uma oferta para WhatsApp e Telegram.\nPersona: ${persona}\nRegras: escreva só 1 ou 2 frases curtas em português do Brasil (máximo 180 caracteres no total). Use apenas os dados fornecidos: nunca invente preço, estoque, prazo, avaliação ou marca. Não repita o título nem coloque links. Responda só com o texto do gancho, sem aspas.`,
      messages: [{ role: "user", content: dados }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`A IA recusou: ${j?.error?.message || `erro ${r.status}`}`);
  const t = String(j?.content?.[0]?.text || "").replace(/^["“]|["”]$/g, "").trim();
  if (!t) throw new Error("A IA devolveu um texto vazio.");
  return t.slice(0, 220);
}

async function escrever(dono: string, id: string) {
  const { data: o } = await db.from("achados_ofertas").select("*").eq("dono", dono).eq("id", id).maybeSingle();
  if (!o) throw new Error("Oferta não encontrada.");
  const { data: c } = await db.from("achados_config").select("est_persona").eq("dono", dono).maybeSingle();
  const persona = (c?.est_persona || "").trim() || PERSONA_PADRAO;
  const { data: seg } = await db.from("segredos").select("valor").eq("chave", "anthropic").maybeSingle();
  let texto: string, origem: "ia" | "modelo" = "modelo", aviso = "";
  if (seg?.valor) {
    try { texto = await ganchoIA(o, persona, seg.valor); origem = "ia"; }
    catch (e) { texto = ganchoModelo(o); aviso = (e as Error).message; }
  } else { texto = ganchoModelo(o); aviso = "Sem chave da IA: usei um modelo pronto."; }
  await db.from("achados_ofertas").update({ est_texto: texto, est_status: "pendente", est_em: new Date().toISOString() }).eq("id", id).eq("dono", dono);
  return { texto, origem, aviso };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(token);
    const email = (u?.user?.email || "").toLowerCase();
    if (!email) return json({ erro: "Faça login novamente." }, 401);
    const { data: dono } = await db.from("achados_donos").select("email").eq("email", email).maybeSingle();
    if (!dono) return json({ erro: "Seu acesso ao Caça Achados não está liberado." }, 403);

    const b = await req.json().catch(() => ({}));
    const id = String(b.id || "");
    if (b.acao === "minerar") return json(await minerar(email));
    if (b.acao === "escrever") return json(await escrever(email, id));
    if (b.acao === "aprovar") {
      const patch: Record<string, unknown> = { est_status: "aprovado", est_em: new Date().toISOString() };
      if (typeof b.texto === "string") patch.est_texto = b.texto.replace(/\s+/g, " ").trim().slice(0, 220);
      await db.from("achados_ofertas").update(patch).eq("id", id).eq("dono", email);
      return json({ ok: true });
    }
    if (b.acao === "afiliados") {
      const n = b.afiliados === "" || b.afiliados == null ? null : Math.max(0, Math.min(1000000, Math.round(Number(b.afiliados))));
      if (n !== null && !Number.isFinite(n)) return json({ erro: "Número inválido." }, 400);
      await db.from("achados_ofertas").update({ afiliados: n }).eq("id", id).eq("dono", email);
      return json({ ok: true });
    }
    if (b.acao === "rejeitar") { await db.from("achados_ofertas").update({ est_status: "rejeitado", est_em: new Date().toISOString() }).eq("id", id).eq("dono", email); return json({ ok: true }); }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
