// =====================================================================
// Caça Achados · Estúdio IA (Supabase Edge Function "achados-estudio")
//
// Independente do resto do app: tem a própria lista de produtos (tabela est_produtos) e não mexe
// na fila de ofertas nem nas postagens dos grupos.
//
//   POST { acao: "minerar" }                       → busca produtos na Shopee (mais vendidos + palavras) e dá nota
//   POST { acao: "afiliados", id, afiliados }      → guarda a contagem de afiliados (vista no app da Shopee) e refaz a nota
//   POST { acao: "status", id, status }            → novo | escolhido | dispensado
//   POST { acao: "prompt_foto", id }               → prompt para criar a foto do personagem com o produto (Nano Banana)
//   POST { acao: "prompt_video", id, estilo, imagem? } → prompt de animação com falas (Veo), olhando a foto do personagem se enviada
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const brl = (v: number | null) => (v == null ? "" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
// deno-lint-ignore no-explicit-any
type Linha = any;

const PERSONA_PADRAO = "O Cara dos Achados: direto, bem-humorado e brasileiro. Fala como um amigo que avisa de promoção boa. Frases curtas. Nunca promete estoque, prazo ou preço futuro.";

// ---------- Nota ----------
function nota(p: Linha): { nota: number; motivos: string[] } {
  const m: string[] = []; let s = 0;
  const v = Number(p.vendas) || 0;
  if (v > 0) { s += Math.min(30, Math.log10(v + 1) * 7); if (v >= 1000) m.push(`${v >= 10000 ? "+10 mil" : "+" + Math.floor(v / 1000) + " mil"} vendidos`); }
  const c = Number(p.comissao) || 0;
  if (c > 0) { s += Math.min(15, c) * 2; if (c >= 8) m.push(`comissão ${c}%`); }
  const d = Number(p.desconto) || 0;
  if (d > 0) { s += Math.min(60, d) * 0.4; if (d >= 30) m.push(`${d}% de desconto`); }
  const pr = Number(p.preco_por) || 0;
  if (pr >= 25 && pr <= 250) { s += 8; m.push("faixa de preço que converte"); } else if (pr > 600) s -= 6;
  if (Number(p.nota_estrelas) >= 4.7) { s += 5; m.push(`${Number(p.nota_estrelas).toFixed(1)} estrelas`); }
  if (p.imagem) s += 3;
  if (p.afiliados != null) {
    if (p.afiliados <= 100) { s += 12; m.push(`só ${p.afiliados} afiliados`); }
    else if (p.afiliados <= 300) { s += 8; m.push(`${p.afiliados} afiliados`); }
    else { s -= 10; m.push(`${p.afiliados} afiliados (concorrido)`); }
  }
  return { nota: Math.max(0, Math.min(100, Math.round(s))), motivos: m };
}

// ---------- Shopee ----------
const API = "https://open-api.affiliate.shopee.com.br/graphql";
async function sha256(t: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// deno-lint-ignore no-explicit-any
async function gql(appId: string, secret: string, query: string): Promise<any> {
  const payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000).toString();
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${await sha256(appId + ts + payload + secret)}` }, body: payload });
  const j = await r.json().catch(() => ({}));
  if (j.errors?.length) { const e = j.errors[0]; throw new Error(`Shopee: ${e.message || "erro"}${e.extensions?.code ? ` (${e.extensions.code})` : ""}`); }
  if (!r.ok) throw new Error(`Shopee respondeu ${r.status}`);
  return j.data;
}
const CAMPOS = "itemId productName priceMin priceDiscountRate commissionRate imageUrl offerLink productLink sales ratingStar";

async function minerar(dono: string) {
  const { data: s, error } = await db.rpc("achados_shp_segredo", { p_dono: dono });
  if (error) throw new Error(`Erro ao ler o cofre: ${error.message}`);
  const seg = (s || [])[0] || {};
  if (!seg.app_id || !seg.secret) throw new Error("Falta o AppID ou a Secret da Shopee (em Ajustes).");
  const { data: cfg } = await db.from("achados_config").select("shp_palavras").eq("dono", dono).maybeSingle();
  const palavras: string[] = [...(cfg?.shp_palavras || [])].sort(() => Math.random() - 0.5).slice(0, 6);
  const p0 = 1 + Math.floor(Math.random() * 6);
  const consultas = [
    `{productOfferV2(listType: 2, limit: 50, page: 1){nodes{${CAMPOS}}}}`,
    `{productOfferV2(listType: 2, limit: 50, page: ${p0 + 1}){nodes{${CAMPOS}}}}`,
    ...palavras.map((k) => `{productOfferV2(keyword: ${JSON.stringify(k)}, sortType: 2, limit: 30, page: 1){nodes{${CAMPOS}}}}`),
  ];
  // deno-lint-ignore no-explicit-any
  const vistos = new Map<string, any>();
  const avisos: string[] = [];
  for (const q of consultas) {
    try {
      const d = await gql(seg.app_id, seg.secret, q);
      for (const n of d?.productOfferV2?.nodes || []) if (n?.itemId && n.offerLink && Number(n.priceMin) > 0) vistos.set(String(n.itemId), n);
    } catch (e) { avisos.push((e as Error).message); if (/AppID|liberou|negado|10020|10031|10035/.test((e as Error).message)) break; }
  }
  const { data: antigos } = await db.from("est_produtos").select("item_id,afiliados,status").eq("dono", dono).eq("origem", "shopee").in("item_id", [...vistos.keys()]);
  const ja = new Map((antigos || []).map((a: Linha) => [a.item_id, a]));
  const linhas = [...vistos.values()].map((n) => {
    const antigo = ja.get(String(n.itemId));
    const base = {
      dono, origem: "shopee", item_id: String(n.itemId), titulo: String(n.productName).slice(0, 300), imagem: n.imageUrl || null, link: n.offerLink,
      preco_por: Number(n.priceMin), desconto: Math.round(Number(n.priceDiscountRate || 0)), comissao: Math.round(Number(n.commissionRate || 0) * 1000) / 10,
      vendas: Math.round(Number(n.sales || 0)), nota_estrelas: n.ratingStar != null ? Number(n.ratingStar) : null, afiliados: antigo?.afiliados ?? null,
    };
    const nt = nota(base);
    return { ...base, nota: nt.nota, motivos: nt.motivos, ...(antigo ? {} : { status: "novo" }) };
  });
  for (let i = 0; i < linhas.length; i += 100) {
    const { error: e2 } = await db.from("est_produtos").upsert(linhas.slice(i, i + 100), { onConflict: "dono,origem,item_id" });
    if (e2) throw new Error(`Erro ao salvar: ${e2.message}`);
  }
  return { produtos: linhas.length, avisos };
}

// ---------- Prompts ----------
const ESTILOS: Record<string, { nome: string; ideia: string }> = {
  provador: { nome: "Provador / look do dia", ideia: "A personagem usa a peça e gira mostrando caimento e detalhes, falando de como valoriza." },
  unboxing: { nome: "Unboxing", ideia: "A personagem abre a caixa e mostra o produto pela primeira vez, reagindo ao que vê." },
  uso: { nome: "Demonstração de uso", ideia: "A personagem usa o produto no dia a dia e mostra como funciona, passo a passo." },
  review: { nome: "Review rápido", ideia: "Falando direto para a câmera, a personagem dá 3 motivos para gostar do produto." },
  achadinho: { nome: "Achadinho do dia", ideia: "Fala animada, mostrando o produto e o preço, como quem avisa um amigo de uma promoção." },
  problema: { nome: "Problema e solução", ideia: "Mostra uma situação comum do dia a dia e o produto resolvendo, sem exagerar." },
};

async function chaveIA() { const { data } = await db.from("segredos").select("valor").eq("chave", "anthropic").maybeSingle(); return data?.valor as string | undefined; }
async function persona(dono: string) {
  const { data } = await db.from("achados_config").select("est_persona,est_personagem").eq("dono", dono).maybeSingle();
  return { fala: (data?.est_persona || "").trim() || PERSONA_PADRAO, visual: (data?.est_personagem || "").trim() };
}
function dadosProduto(p: Linha) {
  return [`Produto: ${String(p.titulo).slice(0, 160)}`, `Preço atual: ${brl(Number(p.preco_por))}`, p.desconto ? `Desconto: ${p.desconto}%` : null].filter(Boolean).join("\n");
}

function promptFoto(p: Linha, visual: string) {
  const nome = String(p.titulo).replace(/\s+/g, " ").slice(0, 100);
  return [
    "Use a imagem de referência anexa do meu personagem e a foto do produto.",
    `Crie uma foto realista, vertical (9:16), do MESMO personagem${visual ? ` (${visual})` : ""} usando, segurando ou mostrando este produto: ${nome}.`,
    "O produto deve ficar idêntico à foto do produto anexa: mesma cor, forma e detalhes, bem visível e em destaque.",
    "Mantenha o rosto, o cabelo e o estilo do personagem iguais à referência.",
    "Ambiente natural e coerente com o uso do produto, luz suave de dia, expressão simpática, olhando para a câmera.",
    "Sem texto, sem logotipos, sem marca d'água e sem mãos ou dedos deformados.",
  ].join("\n");
}

function promptVideoModelo(p: Linha, e: { nome: string; ideia: string }, visual: string) {
  const nome = String(p.titulo).replace(/\s+/g, " ").slice(0, 70);
  return [
    `Estilo: ${e.nome}. ${e.ideia}`, "",
    "CLIPE 1 (8 s)",
    `Cena: ${visual || "a personagem da foto"} em ambiente natural, segurando/usando ${nome}. O produto idêntico à foto.`,
    "Câmera: plano médio, vertical 9:16, leve movimento para a frente.",
    `Fala (pt-BR): "Olha o que eu achei hoje! ${p.desconto ? `Está com ${p.desconto}% de desconto` : "Achado do dia"}, por ${brl(Number(p.preco_por))}."`,
    "Áudio: voz natural, som ambiente baixo, sem música alta.", "",
    "CLIPE 2 (8 s)",
    "Cena: close no produto e no rosto sorrindo, mostrando um detalhe.",
    'Fala (pt-BR): "Vale conferir o link. O preço pode mudar, então corre!"',
  ].join("\n");
}

// deno-lint-ignore no-explicit-any
async function claude(chave: string, system: string, content: any[], maxTokens = 1200): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": chave, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: maxTokens, system, messages: [{ role: "user", content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`A IA recusou: ${j?.error?.message || `erro ${r.status}`}`);
  const t = String(j?.content?.[0]?.text || "").trim();
  if (!t) throw new Error("A IA devolveu um texto vazio.");
  return t.slice(0, 3000);
}

async function promptVideo(dono: string, p: Linha, estiloId: string, imagem?: string) {
  const e = ESTILOS[estiloId] || ESTILOS.achadinho;
  const pe = await persona(dono);
  const chave = await chaveIA();
  let texto: string, origem: "ia" | "modelo" = "modelo", aviso = "";
  if (chave) {
    try {
      const sistema = `Você escreve prompts para o Veo (gerador de vídeo do Google) para vídeos curtos de afiliado, em português do Brasil.
Personagem (visual): ${pe.visual || "veja a foto enviada"}.
Voz e jeito de falar: ${pe.fala}
Estilo do vídeo: ${e.nome}. ${e.ideia}
Entregue de 2 a 3 clipes de 8 segundos, cada um neste formato:
CLIPE N (8 s)
Cena: o que aparece (personagem, ambiente, produto)
Câmera: enquadramento e movimento
Ação: o que a personagem faz
Fala (pt-BR): uma fala natural entre aspas, no máximo 20 palavras, que valorize o produto (como ele valoriza quem usa, o que chama atenção)
Áudio: voz e som ambiente
Regras: use a foto enviada (se houver) como referência fiel da personagem e do produto; o produto deve aparecer exatamente como na foto. Use só os dados fornecidos: nunca invente preço, estoque, avaliação, marca, material, tamanho ou prazo; não faça promessa de resultado nem alegação de saúde; não diga "mais vendido" nem "últimas unidades". No último clipe, chame para ver o link e avise que o preço pode mudar. Sem texto na tela e sem logotipos. Responda só com os clipes.`;
      const conteudo = [];
      if (imagem) conteudo.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imagem } });
      conteudo.push({ type: "text", text: dadosProduto(p) });
      texto = await claude(chave, sistema, conteudo); origem = "ia";
    } catch (err) { texto = promptVideoModelo(p, e, pe.visual); aviso = (err as Error).message; }
  } else { texto = promptVideoModelo(p, e, pe.visual); aviso = "Sem chave da IA: usei um prompt-modelo."; }
  await db.from("est_produtos").update({ prompt_video: texto, video_estilo: estiloId }).eq("id", p.id).eq("dono", dono);
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
    if (b.acao === "minerar") return json(await minerar(email));
    const id = String(b.id || "");
    const { data: p } = await db.from("est_produtos").select("*").eq("dono", email).eq("id", id).maybeSingle();
    if (!p) return json({ erro: "Produto não encontrado." }, 404);
    if (b.acao === "afiliados") {
      const n = b.afiliados === "" || b.afiliados == null ? null : Math.max(0, Math.min(1000000, Math.round(Number(b.afiliados))));
      if (n !== null && !Number.isFinite(n)) return json({ erro: "Número inválido." }, 400);
      const nt = nota({ ...p, afiliados: n });
      await db.from("est_produtos").update({ afiliados: n, nota: nt.nota, motivos: nt.motivos }).eq("id", id).eq("dono", email);
      return json({ ok: true, nota: nt.nota });
    }
    if (b.acao === "status") {
      if (!["novo", "escolhido", "dispensado"].includes(b.status)) return json({ erro: "Status inválido." }, 400);
      await db.from("est_produtos").update({ status: b.status }).eq("id", id).eq("dono", email);
      return json({ ok: true });
    }
    if (b.acao === "prompt_foto") {
      const texto = promptFoto(p, (await persona(email)).visual);
      await db.from("est_produtos").update({ prompt_foto: texto }).eq("id", id).eq("dono", email);
      return json({ texto });
    }
    if (b.acao === "prompt_video") {
      const img = typeof b.imagem === "string" && b.imagem.length < 4_000_000 ? b.imagem.replace(/^data:image\/\w+;base64,/, "") : undefined;
      return json(await promptVideo(email, p, String(b.estilo || "achadinho"), img));
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
