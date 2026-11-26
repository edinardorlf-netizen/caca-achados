// =====================================================================
// Caça Achados · robô do WhatsApp (Supabase Edge Function "achados-zap")
//
// Quem chama é o programa que roda no computador do cliente (não o app). Cada cliente tem a própria chave,
// gerada no app; ela vai no cabeçalho "x-zap-key" e o banco guarda só o hash (achados_config.zap_chave_hash).
// A chave diz de quem é o robô: ele só enxerga e confirma as ofertas daquele cliente.
//
//   POST { acao: "proximas", teste?: true }  → devolve as ofertas da vez (respeita horário, intervalo e quantidade)
//   POST { acao: "confirmar", ids: [...] }   → marca as ofertas como postadas no WhatsApp
//   POST { acao: "erro", mensagem }          → guarda o erro para aparecer no app
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type Oferta = any;
const brl = (v: number | null) => (v == null ? "" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const descontoDe = (o: Oferta) => (o.preco_de && o.preco_por && Number(o.preco_de) > Number(o.preco_por) ? Math.round((1 - Number(o.preco_por) / Number(o.preco_de)) * 100) : null);
const pontuacao = (o: Oferta) => Math.round((descontoDe(o) || 0) * 1.2 + (o.comissao || 0) * 2 + (o.cupom ? 8 : 0) + (o.ml_posicao ? Math.max(0, 12 - o.ml_posicao) : 0));
const LOJA: Record<string, string> = { shopee: "na Shopee", meli: "no Mercado Livre", amazon: "na Amazon", tiktok: "no TikTok Shop" };

const curto = (t: string, n = 70) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "") + "…"; };
const cabecalho = (d: number | null) => (d && d >= 60 ? "🚨 PREÇO ABSURDO" : d && d >= 40 ? "🔥 ACHADÃO" : "🛒 ACHADO");
const assinar = (nome?: string | null) => (nome && nome.trim() ? `_${nome.trim()}_` : null);
async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function texto(o: Oferta, lk: { tg?: string; wa?: string; nome?: string | null } = {}) {
  const d = descontoDe(o);
  const eco = o.preco_de && d ? Number(o.preco_de) - Number(o.preco_por) : 0;
  return [
    `${cabecalho(d)} ${LOJA[o.marketplace] || ""}`.trim(), "",
    `*${curto(o.titulo)}*`, "",
    (o.preco_de && d ? `~De ${brl(Number(o.preco_de))}~\n` : "") + `✅ *Por ${brl(Number(o.preco_por))}*${d ? ` (${d}% OFF)` : ""}`,
    eco > 0 ? `💸 Você economiza ${brl(eco)}` : null,
    o.cupom ? `🎟️ Cupom: *${o.cupom}*` : null,
    o.nota ? `📌 ${o.nota}` : null, "",
    `🛒 Comprar agora com desconto:\n${o.link}`, "",
    lk.tg || lk.wa ? "💛 Manda pra quem gosta de economizar:" : null,
    lk.wa ? `💬 WhatsApp: ${lk.wa}` : null,
    lk.tg ? `✈️ Telegram: ${lk.tg}` : null,
    lk.tg || lk.wa ? "" : null,
    "⚠️ Preço pode mudar",
    assinar(lk.nome),
  ].filter((x) => x !== null).join("\n");
}

function textoCupons(cs: Oferta[], lk: { tg?: string; wa?: string; nome?: string | null } = {}) {
  const loja = (LOJA[cs[0].loja] || cs[0].loja || "").replace(/^n[oa] /, "").toUpperCase();
  const links = [...new Set(cs.map((c) => c.link).filter(Boolean))];
  const unico = links.length === 1 && cs.every((c) => c.link === links[0]);
  const bloco = (c: Oferta) => {
    const val = c.validade ? String(c.validade).split("-").reverse().join("/") : "";
    return [c.regra ? `🎟️ ${c.regra}` : null, `Cupom: *${c.codigo}*`, val ? `📅 Válido até ${val}` : null, !unico && c.link ? `Resgate aqui:\n${c.link}` : null].filter((x) => x !== null).join("\n");
  };
  return [
    `${cs[0].loja === "meli" ? "💛" : "🧡"} ${cs.length > 1 ? "NOVOS CUPONS" : "NOVO CUPOM"} ${loja}`, "",
    cs.map(bloco).join("\n\n"), "",
    unico ? `Resgate aqui:\n${links[0]}\n` : null,
    lk.wa ? `👊 Convide amigos e familiares para o grupo!\n${lk.wa}\n` : null,
    "⚠️ Sujeito às regras e à disponibilidade da loja",
    assinar(lk.nome),
  ].filter((x) => x !== null).join("\n");
}

// Uma mensagem de cupons por rodada: pega o cupom que está há mais tempo sem sair (ou nunca saiu, ou saiu há +2 dias)
// e junta todos os cupons válidos da mesma loja.
async function cupomDaVez(dono: string, lk: { tg?: string; wa?: string; nome?: string | null }) {
  const hoje = new Date().toISOString().slice(0, 10);
  const { data } = await db.from("achados_cupons").select("*").eq("dono", dono).eq("ativo", true).or(`validade.is.null,validade.gte.${hoje}`).limit(100);
  const limite = Date.now() - 48 * 3600 * 1000;
  const vez = (data || []).filter((c: Oferta) => !c.wa_avisado_em || Date.parse(c.wa_avisado_em) < limite)
    .sort((a: Oferta, b: Oferta) => (a.wa_avisado_em ? Date.parse(a.wa_avisado_em) : 0) - (b.wa_avisado_em ? Date.parse(b.wa_avisado_em) : 0))[0];
  if (!vez) return null;
  const grupo = (data || []).filter((c: Oferta) => c.loja === vez.loja).slice(0, 6);
  return { id: `c:${grupo.map((c: Oferta) => c.id).join(",")}`, texto: textoCupons(grupo, lk), imagem: null };
}

function horaSP() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hourCycle: "h23" }).format(new Date()));
}
// Horário de postagem. Aceita virar a meia-noite: das 6 às 4 = das 6h até as 4h da manhã seguinte.
function noHorario(h: number, ini: number, fim: number) {
  return ini < fim ? h >= ini && h < fim : h >= ini || h < fim;
}

// Mensagens em particular pendentes (até 10 por vez, só das últimas 24 h). O texto sai no mesmo formato do grupo.
async function privadasPendentes(c: Oferta) {
  const { data } = await db.from("achados_zap_privadas").select("id,numero,oferta,texto").eq("dono", c.dono)
    .is("enviado_em", null).is("erro", null).gt("criado_em", new Date(Date.now() - 24 * 3600e3).toISOString()).order("id").limit(10);
  const lk = { tg: c.vit_telegram || undefined, wa: c.vit_whatsapp || undefined, nome: c.assinatura };
  return (data || []).map((p: Oferta) => ({ id: p.id, numero: p.numero, texto: p.texto || texto(p.oferta || {}, lk), imagem: p.oferta?.imagem || null }));
}

async function proximas(dono: string, minDesc: number, qtd: number, maxAfil: number | null = null) {
  const hoje = new Date().toISOString().slice(0, 10);
  const { data } = await db.from("achados_ofertas").select("*").eq("dono", dono).not("link", "is", null).eq("exemplo", false)
    .is("wa_avisado_em", null).in("status", ["nova", "aprovada", "postada"]).or(`validade.is.null,validade.gte.${hoje}`)
    .order("status", { ascending: true }).order("criado_em", { ascending: false }).limit(400); // aprovadas e mais novas primeiro (antes o corte de 400 era aleatório)
  const lst = (data || []).filter((o: Oferta) => ((descontoDe(o) || 0) >= minDesc || !!o.cupom) && !(o.canais || []).includes("whatsapp") && !(maxAfil && o.afiliados != null && o.afiliados > maxAfil));
  lst.sort((a: Oferta, b: Oferta) => (b.status === "aprovada" ? 1 : 0) - (a.status === "aprovada" ? 1 : 0) || pontuacao(b) - pontuacao(a));
  // Campanhas ativas (ex.: brinquedos e festas até 22/12): partes fixas de cada rodada, espalhadas no meio das outras ofertas
  const camps = await campanhasAtivas(dono);
  if (!camps.length) return lst.slice(0, qtd);
  const filas: Record<string, Oferta[]> = {};
  for (const c of camps) {
    const { data: cd } = await db.from("achados_ofertas").select("*").eq("dono", dono).not("link", "is", null).eq("exemplo", false)
      .is("wa_avisado_em", null).in("status", ["nova", "aprovada", "postada"]).ilike("categoria", c.filtro_categoria)
      .or(`validade.is.null,validade.gte.${hoje}`).limit(400);
    filas[c.id] = (cd || []).filter((o: Oferta) => ehDaCampanha(o, c) && !(o.canais || []).includes("whatsapp"))
      .sort((a: Oferta, b: Oferta) => (b.status === "aprovada" ? 1 : 0) - (a.status === "aprovada" ? 1 : 0) || pontuacao(b) - pontuacao(a));
  }
  filas.normal = lst.filter((o: Oferta) => !camps.some((c) => mesmaCategoria(o, c)));
  const out: Oferta[] = [];
  for (const vaga of planoDaRodada(qtd, camps)) {
    const o = filas[vaga].shift() || filas.normal.shift() || camps.map((c) => filas[c.id].shift()).find(Boolean);
    if (o) out.push(o);
  }
  return out;
}

// ---------- Campanhas (ex.: brinquedos; Natal e formatura) ----------
type Campanha = { id: string; fracao: number; filtro_categoria: string; desconto_min: number; ordem: number };
async function campanhasAtivas(dono: string): Promise<Campanha[]> {
  const { data } = await db.from("achados_campanha").select("id,fracao,filtro_categoria,desconto_min,ordem").eq("dono", dono)
    .gt("ate", new Date().toISOString()).gt("fracao", 0).order("ordem");
  return data || [];
}
const mesmaCategoria = (o: Oferta, c: Campanha) => String(o.categoria || "").toLowerCase().includes(c.filtro_categoria.replace(/%/g, "").toLowerCase());
const ehDaCampanha = (o: Oferta, c: Campanha) => mesmaCategoria(o, c) && !/cesto|organizador/i.test(String(o.titulo)) && (descontoDe(o) || 0) >= c.desconto_min;
const vez = (i: number, n: number, k: number) => Math.floor(((i + 1) * k) / n) > Math.floor((i * k) / n);
// Diz de quem é cada vaga da rodada. Cada campanha, na ordem, pega a sua fração das vagas que sobraram, espalhadas.
// Ex. 20 vagas: brinquedos 25% → 5; festas 2/3 das 15 restantes → 10; 5 normais.
function planoDaRodada(qtd: number, camps: Campanha[]) {
  const vagas: string[] = Array(qtd).fill("normal");
  let livres = [...Array(qtd).keys()];
  for (const c of camps) {
    const n = livres.length, k = Math.round(n * Number(c.fracao));
    const pegas = livres.filter((_, i) => vez(i, n, k));
    pegas.forEach((p) => (vagas[p] = c.id));
    livres = livres.filter((p) => !pegas.includes(p));
  }
  return vagas;
}

// ---------- Vigia (cron a cada 5 min): avisa no Telegram quando o robô para de dar sinal e quando volta ----------
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
async function vigia() {
  const { data: cs } = await db.from("achados_config")
    .select("dono,zap_visto_em,zap_vigia_estado,alerta_chat_id,wa_hora_ini,wa_hora_fim").eq("rec_robo", true).eq("zap_ativo", true);
  const res: Record<string, string> = {};
  const h = horaSP();
  for (const c of cs || []) {
    const visto = c.zap_visto_em ? Date.parse(c.zap_visto_em) : 0;
    const parado = Date.now() - visto > 10 * 60 * 1000;
    const dentro = noHorario(h, c.wa_hora_ini, c.wa_hora_fim);
    let msg: string | null = null, estado: string | null = c.zap_vigia_estado;
    if (parado && dentro && estado !== "parado") {
      estado = "parado";
      msg = `⚠️ O robô do WhatsApp parou de dar sinal${visto ? ` (último sinal às ${hhmm(visto)})` : ""}. Confira se o computador está ligado e a janela do robô aberta.`;
    } else if (!parado && estado === "parado") {
      estado = null;
      msg = "✅ O robô do WhatsApp voltou a funcionar.";
    }
    if (msg) {
      await db.from("achados_config").update({ zap_vigia_estado: estado, zap_vigia_em: new Date().toISOString() }).eq("dono", c.dono);
      try {
        const { data: tok } = await db.rpc("achados_tg_token", { p_dono: c.dono });
        if (tok && c.alerta_chat_id) await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: c.alerta_chat_id, text: msg }) });
      } catch (_) { /* o aviso é só um extra */ }
    }
    res[c.dono] = estado || (dentro ? "ok" : "fora do horário");
  }
  return res;
}

// ---------- Preços do Mercado Livre pelo robô (v6) ----------
// Em 24/11/2026 o Mercado Livre passou a recusar (403) os preços de produtos para apps de terceiros.
// A lista dos mais vendidos e os dados do produto (nome, foto) continuam liberados: o servidor monta a fila
// (achados_ml_precos) e o robô do computador abre cada página, lê o preço "de"/"por" e devolve aqui.
// Com desconto, vira oferta normal (com link de afiliado) e entra na fila do WhatsApp.
const ML = "https://api.mercadolibre.com";
async function mlGet(path: string, token: string) {
  const r = await fetch(ML + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) return null;
  return await r.json().catch(() => null);
}
async function mlEncher(dono: string) {
  const { data: cfg } = await db.from("achados_config").select("ml_conectado,ml_categorias,ml_categorias_nomes,ml_preco_cursor,ml_preco_ativo").eq("dono", dono).maybeSingle();
  if (!cfg?.ml_conectado || !cfg.ml_preco_ativo) return 0;
  const cats: string[] = cfg.ml_categorias || [];
  if (!cats.length) return 0;
  const { data: seg } = await db.rpc("achados_ml_segredos", { p_dono: dono });
  const token = (seg || [])[0]?.access;
  if (!token) return 0; // o achados-ml renova o token de hora em hora
  let novos = 0;
  for (let tent = 0; tent < 3 && !novos; tent++) {
    const i = (Number(cfg.ml_preco_cursor || 0) + tent) % cats.length;
    const cat = cats[i];
    const h = await mlGet(`/highlights/MLB/category/${cat}`, token);
    // deno-lint-ignore no-explicit-any
    const prods = ((h?.content || []) as any[]).filter((x) => x.type === "PRODUCT").slice(0, 20);
    const ids = prods.map((x) => String(x.id));
    if (!ids.length) continue;
    const limite = new Date(Date.now() - 24 * 3600e3).toISOString();
    const { data: ja } = await db.from("achados_ml_precos").select("produto_id,conferido_em").eq("dono", dono).in("produto_id", ids);
    // deno-lint-ignore no-explicit-any
    const recentes = new Set((ja || []).filter((x: any) => !x.conferido_em || x.conferido_em > limite).map((x: any) => x.produto_id));
    for (const p of prods) {
      const id = String(p.id);
      if (recentes.has(id)) continue;
      const d = await mlGet(`/products/${id}`, token);
      if (!d?.name) continue;
      const foto = d.pictures?.[0]?.secure_url || d.pictures?.[0]?.url || null;
      await db.from("achados_ml_precos").upsert({
        dono, produto_id: id, titulo: d.name, imagem: foto ? String(foto).replace(/^http:/, "https:") : null,
        link_produto: `https://www.mercadolivre.com.br/p/${id}`, ml_categoria: cat,
        categoria: (cfg.ml_categorias_nomes || {})[cat] || null, posicao: Number(p.position) || null,
        pedido_em: new Date().toISOString(), conferido_em: null, erro: null,
      }, { onConflict: "dono,produto_id" });
      novos++;
    }
    await db.from("achados_config").update({ ml_preco_cursor: (i + 1) % cats.length }).eq("dono", dono);
  }
  return novos;
}
async function mlPendente(dono: string) {
  const pega = () => db.from("achados_ml_precos").select("produto_id,link_produto,titulo").eq("dono", dono).is("conferido_em", null)
    .order("posicao", { ascending: true, nullsFirst: false }).order("pedido_em").limit(1).maybeSingle();
  let { data } = await pega();
  if (!data) { await mlEncher(dono); ({ data } = await pega()); }
  if (!data) return { item: null };
  return { item: { produto_id: data.produto_id, url: data.link_produto, titulo: data.titulo } };
}
// deno-lint-ignore no-explicit-any
async function mlSalvarPreco(dono: string, body: any) {
  const id = String(body.produto_id || "");
  const agora = new Date().toISOString();
  if (!body.bloqueio && !/^MLB\d+$/.test(id)) return { erro: "produto inválido" };
  if (body.bloqueio) {
    const msg = String(body.erro || "O Mercado Livre pediu verificação.").slice(0, 300);
    await db.from("achados_config").update({ ml_preco_msg: `${agora.slice(0, 16)} ${msg}` }).eq("dono", dono);
    const { data: al } = await db.from("achados_config").select("zap_aviso_numero").eq("dono", dono).maybeSingle();
    if (al?.zap_aviso_numero) await db.from("achados_zap_privadas").insert({ dono, numero: al.zap_aviso_numero, texto: `🛑 *Preços do Mercado Livre*\n${msg}\nO robô parou de abrir páginas do Mercado Livre por 6 horas.` });
    return { ok: true };
  }
  const por = Number(body.preco_por), de = body.preco_de != null ? Number(body.preco_de) : null;
  if (body.erro || !(por > 0)) {
    await db.from("achados_ml_precos").update({ conferido_em: agora, erro: String(body.erro || "sem preço na página").slice(0, 200) }).eq("dono", dono).eq("produto_id", id);
    return { ok: true, oferta: false };
  }
  const { data: r } = await db.from("achados_ml_precos").update({ conferido_em: agora, erro: null, preco_por: por, preco_de: de }).eq("dono", dono).eq("produto_id", id).select("*").maybeSingle();
  if (!r) return { erro: "produto não está na fila" };
  const { data: cf } = await db.from("achados_config").select("desconto_min").eq("dono", dono).maybeSingle();
  const desc = de && de > por ? Math.round((1 - por / de) * 100) : 0;
  if (!de || de <= por || desc < Number(cf?.desconto_min || 0) || desc < 1) return { ok: true, oferta: false, desconto: desc };
  const { error } = await db.from("achados_ofertas").upsert({
    dono, titulo: r.titulo, marketplace: "meli", fonte: "ml", ml_item_id: id, ml_categoria: r.ml_categoria, ml_posicao: r.posicao,
    categoria: r.categoria, link_produto: r.link_produto, preco_de: de, preco_por: por, imagem: r.imagem,
  }, { onConflict: "dono,ml_item_id" });
  if (error) return { erro: error.message };
  await db.rpc("achados_aplicar_afiliado", { p_dono: dono });
  await db.from("achados_config").update({ ml_preco_msg: `${agora.slice(0, 16)} oferta pelo robô: ${String(r.titulo).slice(0, 60)} (${desc}% OFF)` }).eq("dono", dono);
  return { ok: true, oferta: true, desconto: desc };
}

// Modo principal: páginas de lista (Ofertas do dia + busca por palavra com filtro de desconto).
// Cada página traz 30–60 produtos já com o preço "de"/"por", então o robô abre poucas páginas.
const PAGINAS_OFERTAS = 8;
async function mlListaProxima(dono: string) {
  const { data: cfg } = await db.from("achados_config").select("ml_preco_ativo,ml_lista_cursor,ml_palavras,desconto_min").eq("dono", dono).maybeSingle();
  if (!cfg?.ml_preco_ativo) return { url: null };
  const pal: string[] = (cfg.ml_palavras || []).map((p: string) => String(p).trim()).filter(Boolean);
  const total = PAGINAS_OFERTAS + pal.length;
  const i = Number(cfg.ml_lista_cursor || 0) % total;
  await db.from("achados_config").update({ ml_lista_cursor: (i + 1) % total }).eq("dono", dono);
  if (i < PAGINAS_OFERTAS) return { url: `https://www.mercadolivre.com.br/ofertas?page=${i + 1}`, rotulo: `Ofertas do dia, página ${i + 1}` };
  const p = pal[i - PAGINAS_OFERTAS];
  const slug = p.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const min = Math.max(10, Number(cfg.desconto_min || 0));
  return { url: `https://lista.mercadolivre.com.br/${slug}_Desconto_${min}-100_NoIndex_True`, rotulo: `Busca: ${p}` };
}
// deno-lint-ignore no-explicit-any
async function mlListaSalvar(dono: string, body: any) {
  // deno-lint-ignore no-explicit-any
  const itens: any[] = Array.isArray(body.itens) ? body.itens.slice(0, 80) : [];
  const { data: cf } = await db.from("achados_config").select("desconto_min").eq("dono", dono).maybeSingle();
  const min = Number(cf?.desconto_min || 0);
  const linhas = [];
  for (const it of itens) {
    const id = String(it.id || "");
    const por = Number(it.por), de = it.de != null ? Number(it.de) : null;
    const link = String(it.link || "");
    if (!/^MLB\d+$/.test(id) || !(por > 0) || !de || de <= por) continue;
    if (!/^https:\/\/(www|produto)\.mercadolivre\.com\.br\//.test(link)) continue;
    const desc = Math.round((1 - por / de) * 100);
    if (desc < Math.max(1, min) || linhas.some((l) => l.ml_item_id === id)) continue;
    linhas.push({ dono, titulo: String(it.titulo || "").slice(0, 300), marketplace: "meli", fonte: "ml", ml_item_id: id,
      link_produto: link, preco_de: de, preco_por: por, imagem: it.imagem ? String(it.imagem).slice(0, 500) : null,
      categoria: body.rotulo ? String(body.rotulo).slice(0, 80) : null });
  }
  let novos = 0;
  if (linhas.length) {
    const { data: ja } = await db.from("achados_ofertas").select("ml_item_id").eq("dono", dono).in("ml_item_id", linhas.map((l) => l.ml_item_id));
    const tem = new Set((ja || []).map((x) => x.ml_item_id));
    novos = linhas.filter((l) => !tem.has(l.ml_item_id)).length;
    // Os que já existem só têm o preço atualizado (o título/categoria/foto originais ficam).
    const novas = linhas.filter((l) => !tem.has(l.ml_item_id));
    if (novas.length) { const { error } = await db.from("achados_ofertas").insert(novas); if (error) return { erro: error.message }; }
    for (const l of linhas.filter((l) => tem.has(l.ml_item_id))) {
      await db.from("achados_ofertas").update({ preco_de: l.preco_de, preco_por: l.preco_por }).eq("dono", dono).eq("ml_item_id", l.ml_item_id);
    }
    await db.rpc("achados_aplicar_afiliado", { p_dono: dono });
  }
  const msg = `${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} · ${body.rotulo || "lista"}: ${itens.length} lidos, ${linhas.length} com desconto, ${novos} novos.`;
  await db.from("achados_config").update({ ml_preco_msg: msg, ml_sinc_em: new Date().toISOString(), ml_sinc_ok: true, ml_sinc_msg: `Robô (navegador): ${msg}` }).eq("dono", dono);
  return { ok: true, lidos: itens.length, com_desconto: linhas.length, novos };
}

// ---------- Amazon pelo robô (v12, 26/11/2026) ----------
// Sem API de afiliados ainda (precisa de 10 vendas em 30 dias): o robô do desktop abre amazon.com.br/deals no
// Chrome (a mesma lógica das tarefas do notebook) e manda os cards. Só entra com de > por e 25% OFF ou mais.
// O amz_asin é único por dono, então o notebook e o desktop nunca duplicam.
const AMZ_PAGINAS = [0, 60, 120, 180];
const AMZ_FILA_MAX = 80;
const AMZ_BRINQ = /hot wheels|barbie|boneca|brinquedo|lego/i;
const AMZ_BELEZA = /shampoo|m[aá]scara|capilar|leave-in|protetor solar|secador|s[eé]rum|desodorante|aparador|barbeador|escova de dente|perfume|maquiagem|hidratante/i;
const quando = () => new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
async function amzListaProxima(dono: string) {
  const { data: cfg } = await db.from("achados_config").select("amz_ativo,amz_cursor").eq("dono", dono).maybeSingle();
  if (!cfg?.amz_ativo) return { url: null, motivo: "desligado" };
  const { count } = await db.from("achados_ofertas").select("id", { count: "exact", head: true }).eq("dono", dono)
    .eq("marketplace", "amazon").eq("exemplo", false).is("wa_avisado_em", null).in("status", ["nova", "aprovada"]);
  if ((count || 0) >= AMZ_FILA_MAX) return { url: null, motivo: `fila cheia (${count})` };
  const i = Number(cfg.amz_cursor || 0) % AMZ_PAGINAS.length;
  await db.from("achados_config").update({ amz_cursor: (i + 1) % AMZ_PAGINAS.length }).eq("dono", dono);
  const ini = AMZ_PAGINAS[i];
  return ini
    ? { url: `https://www.amazon.com.br/deals?promotionsSearchStartIndex=${ini}&promotionsSearchPageSize=60`, rotulo: `Ofertas, a partir do ${ini + 1}º` }
    : { url: "https://www.amazon.com.br/deals", rotulo: "Ofertas, início" };
}
// deno-lint-ignore no-explicit-any
async function amzListaSalvar(dono: string, body: any) {
  // deno-lint-ignore no-explicit-any
  const itens: any[] = Array.isArray(body.itens) ? body.itens.slice(0, 300) : [];
  const { data: cf } = await db.from("achados_config").select("amz_tag").eq("dono", dono).maybeSingle();
  const tag = String(cf?.amz_tag || "").trim();
  if (!tag) return { erro: "sem amz_tag no achados_config" };
  // deno-lint-ignore no-explicit-any
  const linhas: any[] = [];
  for (const it of itens) {
    const a = String(it.a || "").toUpperCase(), t = String(it.t || "").replace(/\s+/g, " ").trim();
    const por = Number(it.p), de = Number(it.d);
    if (!/^[A-Z0-9]{10}$/.test(a) || t.length < 10 || !(por > 0) || !(de > por)) continue;
    if (Math.round((1 - por / de) * 100) < 25 || linhas.some((l) => l.amz_asin === a)) continue;
    const img = String(it.i || "");
    const prod = `https://www.amazon.com.br/dp/${a}`;
    linhas.push({ dono, titulo: t.slice(0, 300), marketplace: "amazon", fonte: "amazon", amz_asin: a, link_produto: prod,
      link: `${prod}?tag=${encodeURIComponent(tag)}`, link_auto: false, status: "nova", preco_de: de, preco_por: por,
      imagem: /^https:\/\/m\.media-amazon\.com\//.test(img) ? img.slice(0, 500) : null,
      categoria: AMZ_BRINQ.test(t) ? "Brinquedos" : AMZ_BELEZA.test(t) ? "Beleza e Cosméticos" : null });
  }
  let novos = 0, atualizados = 0;
  if (linhas.length) {
    const { data: ja } = await db.from("achados_ofertas").select("amz_asin,wa_avisado_em").eq("dono", dono).in("amz_asin", linhas.map((l) => l.amz_asin));
    const tem = new Map((ja || []).map((x) => [x.amz_asin, x.wa_avisado_em]));
    const novas = linhas.filter((l) => !tem.has(l.amz_asin));
    if (novas.length) {
      // upsert com ignoreDuplicates: se o notebook gravou o mesmo ASIN no meio tempo, não dá erro nem duplica
      const { data: ins, error } = await db.from("achados_ofertas").upsert(novas, { onConflict: "dono,amz_asin", ignoreDuplicates: true }).select("id");
      if (error) return { erro: error.message };
      novos = (ins || []).length;
    }
    for (const l of linhas.filter((l) => tem.has(l.amz_asin) && !tem.get(l.amz_asin))) {
      await db.from("achados_ofertas").update({ preco_de: l.preco_de, preco_por: l.preco_por }).eq("dono", dono).eq("amz_asin", l.amz_asin).is("wa_avisado_em", null);
      atualizados++;
    }
  }
  const msg = `${quando()} · desktop · ${String(body.rotulo || "ofertas").slice(0, 60)}: ${itens.length} lidos, ${linhas.length} com 25%+, ${novos} novos, ${atualizados} com preço atualizado.`;
  await db.from("achados_config").update({ amz_msg: msg }).eq("dono", dono);
  return { ok: true, lidos: itens.length, com_desconto: linhas.length, novos, atualizados };
}
// deno-lint-ignore no-explicit-any
async function amzBloqueio(dono: string, body: any) {
  const det = String(body.erro || "").slice(0, 200);
  await db.from("achados_config").update({ amz_msg: `${quando()} · desktop · BLOQUEIO: a Amazon pediu verificação; busca parada por 6 h. ${det}`.trim() }).eq("dono", dono);
  const { data: al } = await db.from("achados_config").select("zap_aviso_numero").eq("dono", dono).maybeSingle();
  if (al?.zap_aviso_numero) await db.from("achados_zap_privadas").insert({ dono, numero: al.zap_aviso_numero, texto: `🛑 *Amazon*\nA Amazon pediu verificação; a busca da Amazon no desktop parou por 6 h.${det ? `\n${det}` : ""}` });
  return { ok: true };
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ erro: "use POST" }, 405);
    if (new URL(req.url).searchParams.get("tarefa") === "vigia") {
      const { data: seg } = await db.from("segredos").select("valor").eq("chave", "cron").maybeSingle();
      if (!seg || (req.headers.get("x-cron-key") || "") !== seg.valor) return json({ erro: "não autorizado" }, 401);
      return json(await vigia());
    }
    const chave = (req.headers.get("x-zap-key") || "").trim();
    if (chave.length < 16) return json({ erro: "não autorizado" }, 401);
    const { data: c } = await db.from("achados_config")
      .select("dono,assinatura,rec_robo,vit_telegram,vit_whatsapp,zap_ativo,zap_ultimo,wa_qtd,wa_intervalo_min,wa_hora_ini,wa_hora_fim,wa_desconto_min,afiliados_max")
      .eq("zap_chave_hash", await sha256(chave)).maybeSingle();
    if (!c) return json({ erro: "Chave do robô inválida. Gere uma chave nova no app (Ajustes > Robô do WhatsApp) e cole no config.env." }, 401);
    if (!c.rec_robo) return json({ erro: "O robô do WhatsApp é um complemento e não está ativo nesta conta." }, 403);
    await db.from("achados_config").update({ zap_visto_em: new Date().toISOString() }).eq("dono", c.dono); // sinal de vida para a vigia
    const body = await req.json().catch(() => ({}));

    if (body.acao === "proximas") {
      // Mensagens em particular (ex.: prévia das ofertas no celular do dono): vão junto em toda resposta, a qualquer hora.
      // (robô v5 em diante pede "sem_privadas" e busca pela ação "privadas", senão mandaria duas vezes)
      const privadas = body.sem_privadas ? [] : await privadasPendentes(c);
      if (body.teste) {
        const l = await proximas(c.dono, c.wa_desconto_min, 1, c.afiliados_max);
        return json({ privadas, ofertas: l.map((o: Oferta) => ({ id: o.id, texto: texto(o, { tg: c.vit_telegram || undefined, wa: c.vit_whatsapp || undefined, nome: c.assinatura }), imagem: o.imagem || null })), motivo: l.length ? "teste" : "sem ofertas" });
      }
      if (!c.zap_ativo) return json({ privadas, ofertas: [], motivo: "desligado" });
      const h = horaSP();
      if (!noHorario(h, c.wa_hora_ini, c.wa_hora_fim)) return json({ privadas, ofertas: [], motivo: "fora do horário" });
      const intervalo = Math.max(10, Number(c.wa_intervalo_min) || 60);
      if (c.zap_ultimo && Date.now() - Date.parse(c.zap_ultimo) < (intervalo * 60 - 30) * 1000) return json({ privadas, ofertas: [], motivo: "aguardando intervalo" });
      const l = await proximas(c.dono, c.wa_desconto_min, Math.max(1, Math.min(30, Number(c.wa_qtd) || 1)), c.afiliados_max);
      const lk = { tg: c.vit_telegram || undefined, wa: c.vit_whatsapp || undefined, nome: c.assinatura };
      const cupom = await cupomDaVez(c.dono, lk);
      if (l.length || cupom) await db.from("achados_config").update({ zap_ultimo: new Date().toISOString() }).eq("dono", c.dono);
      const saida = l.map((o: Oferta) => ({ id: o.id, texto: texto(o, lk), imagem: o.imagem || null }));
      if (cupom) saida.splice(Math.min(1, saida.length), 0, cupom); // o cupom entra logo depois da primeira oferta
      return json({ privadas, ofertas: saida, motivo: saida.length ? "ok" : "sem ofertas" });
    }
    // v5 do robô: pergunta a cada 20 s só pelas mensagens em particular, para mandar na hora (mesmo no meio de uma rodada).
    if (body.acao === "privadas") return json({ privadas: await privadasPendentes(c) });
    if (body.acao === "confirmar_privada") {
      const id = Number(body.id);
      if (!id) return json({ erro: "id inválido" }, 400);
      await db.from("achados_zap_privadas").update(body.erro ? { erro: String(body.erro).slice(0, 250) } : { enviado_em: new Date().toISOString(), erro: null })
        .eq("id", id).eq("dono", c.dono);
      return json({ ok: true });
    }
    if (body.acao === "confirmar") {
      const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 50) : [];
      const agora = new Date().toISOString();
      for (const id of ids) {
        if (id.startsWith("c:")) { await db.from("achados_cupons").update({ wa_avisado_em: agora }).in("id", id.slice(2).split(",")).eq("dono", c.dono); continue; }
        const { data: o } = await db.from("achados_ofertas").select("canais").eq("id", id).eq("dono", c.dono).maybeSingle();
        if (!o) continue;
        await db.from("achados_ofertas").update({ wa_avisado_em: agora, canais: [...new Set([...(o.canais || []), "whatsapp"])] }).eq("id", id).eq("dono", c.dono);
      }
      await db.from("achados_config").update({ wa_msg: `Robô postou ${ids.length} oferta(s) no canal (${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })})` }).eq("dono", c.dono);
      return json({ ok: true });
    }
    if (body.acao === "atualizacao") {
      // O robô pergunta se há código novo. Só devolve os arquivos quando a versão do servidor é maior que a dele.
      const { data: v } = await db.from("zap_codigo").select("versao,arquivos").order("versao", { ascending: false }).limit(1).maybeSingle();
      const minha = Number(body.versao) || 0;
      if (!v || v.versao <= minha) return json({ atual: true, versao: v?.versao ?? minha });
      return json({ atual: false, versao: v.versao, arquivos: v.arquivos });
    }
    if (body.acao === "novo_grupo") {
      const link = String(body.link || "");
      if (!/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+$/.test(link)) return json({ erro: "link inválido" }, 400);
      // O link de entrada (rodapé das mensagens e Vitrine) passa a ser o do grupo mais novo.
      await db.from("achados_config").update({ vit_whatsapp: link, wa_msg: `Novo grupo criado: ${String(body.nome || "").slice(0, 60)}` }).eq("dono", c.dono);
      try {
        const { data: al } = await db.from("achados_config").select("alerta_chat_id,zap_aviso_numero").eq("dono", c.dono).maybeSingle();
        // Aviso no WhatsApp particular do dono; sem número cadastrado, vai pelo Telegram.
        if (al?.zap_aviso_numero) {
          await db.from("achados_zap_privadas").insert({ dono: c.dono, numero: al.zap_aviso_numero, texto: `🆕 O robô criou o grupo "${body.nome}" (o anterior encheu).\nNovo link de entrada: ${link}` });
          return json({ ok: true });
        }
        const { data: tok } = await db.rpc("achados_tg_token", { p_dono: c.dono });
        if (tok && al?.alerta_chat_id) await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: al.alerta_chat_id, text: `🆕 O robô criou o grupo "${body.nome}" do WhatsApp (o anterior encheu).\nNovo link de entrada: ${link}` }) });
      } catch (_) { /* o aviso é só um extra */ }
      return json({ ok: true });
    }
    // v6 do robô: preços do Mercado Livre lidos no navegador do computador (a API bloqueou os preços).
    if (body.acao === "ml_precos_pendentes") return json(await mlPendente(c.dono));
    if (body.acao === "ml_preco") return json(await mlSalvarPreco(c.dono, body));
    if (body.acao === "ml_lista_proxima") return json(await mlListaProxima(c.dono));
    if (body.acao === "ml_lista") return json(await mlListaSalvar(c.dono, body));
    // v12 do robô: ofertas da Amazon lidas no Chrome do desktop.
    if (body.acao === "amz_lista_proxima") return json(await amzListaProxima(c.dono));
    if (body.acao === "amz_lista") return json(await amzListaSalvar(c.dono, body));
    if (body.acao === "amz_bloqueio") return json(await amzBloqueio(c.dono, body));
    if (body.acao === "erro") {
      await db.from("achados_config").update({ wa_msg: `Robô: ${String(body.mensagem || "erro").slice(0, 250)}` }).eq("dono", c.dono);
      return json({ ok: true });
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
