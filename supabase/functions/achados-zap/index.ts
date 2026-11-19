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
    .is("wa_avisado_em", null).in("status", ["nova", "aprovada", "postada"]).or(`validade.is.null,validade.gte.${hoje}`).limit(400);
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
      const privadas = await privadasPendentes(c);
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
        const { data: tok } = await db.rpc("achados_tg_token", { p_dono: c.dono });
        const { data: al } = await db.from("achados_config").select("alerta_chat_id").eq("dono", c.dono).maybeSingle();
        if (tok && al?.alerta_chat_id) await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: al.alerta_chat_id, text: `🆕 O robô criou o grupo "${body.nome}" do WhatsApp (o anterior encheu).\nNovo link de entrada: ${link}` }) });
      } catch (_) { /* o aviso é só um extra */ }
      return json({ ok: true });
    }
    if (body.acao === "erro") {
      await db.from("achados_config").update({ wa_msg: `Robô: ${String(body.mensagem || "erro").slice(0, 250)}` }).eq("dono", c.dono);
      return json({ ok: true });
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
