// =====================================================================
// Caça Achados · robô do WhatsApp (Supabase Edge Function "achados-zap")
//
// Quem chama é o programa que roda no computador (não o app). A chave dele fica em segredos.zap
// e vai no cabeçalho "x-zap-key". Ele só consegue pedir a próxima leva de ofertas e confirmar o que postou.
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
function texto(o: Oferta, lk: { tg?: string; wa?: string } = {}) {
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
    "_O Cara dos Achados_",
  ].filter((x) => x !== null).join("\n");
}

function textoCupom(c: Oferta, lk: { tg?: string; wa?: string } = {}) {
  const val = c.validade ? String(c.validade).split("-").reverse().join("/") : "";
  return [
    `🎁 BÔNUS DO GRUPO · CUPOM ${(LOJA[c.loja] || c.loja || "").replace(/^n[oa] /, "").toUpperCase()}`.trim(), "",
    `🎟️ Cupom: *${c.codigo}*`,
    c.regra ? `📋 ${c.regra}` : null,
    val ? `📅 Válido até ${val}` : null,
    c.link ? `\n👉 Aproveite aqui:\n${c.link}` : null, "",
    lk.wa ? "💛 Manda pra quem gosta de economizar:" : null,
    lk.wa ? `💬 ${lk.wa}` : null,
    lk.wa ? "" : null,
    "⚠️ Sujeito às regras e à disponibilidade da loja",
    "_O Cara dos Achados_",
  ].filter((x) => x !== null).join("\n");
}

// Um cupom por rodada: o que nunca saiu, ou o que saiu há mais de 2 dias e ainda vale.
async function cupomDaVez(dono: string, lk: { tg?: string; wa?: string }) {
  const hoje = new Date().toISOString().slice(0, 10);
  const { data } = await db.from("achados_cupons").select("*").eq("dono", dono).eq("ativo", true).or(`validade.is.null,validade.gte.${hoje}`).limit(100);
  const limite = Date.now() - 48 * 3600 * 1000;
  const lst = (data || []).filter((c: Oferta) => !c.wa_avisado_em || Date.parse(c.wa_avisado_em) < limite);
  lst.sort((a: Oferta, b: Oferta) => (a.wa_avisado_em ? Date.parse(a.wa_avisado_em) : 0) - (b.wa_avisado_em ? Date.parse(b.wa_avisado_em) : 0));
  const c = lst[0];
  return c ? { id: `c:${c.id}`, texto: textoCupom(c, lk), imagem: null } : null;
}

function horaSP() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hourCycle: "h23" }).format(new Date()));
}

async function proximas(dono: string, minDesc: number, qtd: number, maxAfil: number | null = null) {
  const hoje = new Date().toISOString().slice(0, 10);
  const { data } = await db.from("achados_ofertas").select("*").eq("dono", dono).not("link", "is", null).eq("exemplo", false)
    .is("wa_avisado_em", null).in("status", ["nova", "aprovada", "postada"]).or(`validade.is.null,validade.gte.${hoje}`).limit(400);
  const lst = (data || []).filter((o: Oferta) => ((descontoDe(o) || 0) >= minDesc || !!o.cupom) && !(o.canais || []).includes("whatsapp") && !(maxAfil && o.afiliados != null && o.afiliados > maxAfil));
  lst.sort((a: Oferta, b: Oferta) => (b.status === "aprovada" ? 1 : 0) - (a.status === "aprovada" ? 1 : 0) || pontuacao(b) - pontuacao(a));
  return lst.slice(0, qtd);
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ erro: "use POST" }, 405);
    const { data: seg } = await db.from("segredos").select("valor").eq("chave", "zap").maybeSingle();
    if (!seg || (req.headers.get("x-zap-key") || "") !== seg.valor) return json({ erro: "não autorizado" }, 401);
    const body = await req.json().catch(() => ({}));

    const { data: cfgs } = await db.from("achados_config").select("dono,vit_telegram,vit_whatsapp,zap_ativo,zap_ultimo,wa_qtd,wa_intervalo_min,wa_hora_ini,wa_hora_fim,wa_desconto_min,afiliados_max").limit(1);
    const c = (cfgs || [])[0];
    if (!c) return json({ erro: "Sem configuração." }, 404);

    if (body.acao === "proximas") {
      if (body.teste) {
        const l = await proximas(c.dono, c.wa_desconto_min, 1, c.afiliados_max);
        return json({ ofertas: l.map((o: Oferta) => ({ id: o.id, texto: texto(o, { tg: c.vit_telegram || undefined, wa: c.vit_whatsapp || undefined }), imagem: o.imagem || null })), motivo: l.length ? "teste" : "sem ofertas" });
      }
      if (!c.zap_ativo) return json({ ofertas: [], motivo: "desligado" });
      const h = horaSP();
      if (h < c.wa_hora_ini || h >= c.wa_hora_fim) return json({ ofertas: [], motivo: "fora do horário" });
      const intervalo = Math.max(10, Number(c.wa_intervalo_min) || 60);
      if (c.zap_ultimo && Date.now() - Date.parse(c.zap_ultimo) < (intervalo * 60 - 30) * 1000) return json({ ofertas: [], motivo: "aguardando intervalo" });
      const l = await proximas(c.dono, c.wa_desconto_min, Math.max(1, Math.min(30, Number(c.wa_qtd) || 1)), c.afiliados_max);
      const lk = { tg: c.vit_telegram || undefined, wa: c.vit_whatsapp || undefined };
      const cupom = await cupomDaVez(c.dono, lk);
      if (l.length || cupom) await db.from("achados_config").update({ zap_ultimo: new Date().toISOString() }).eq("dono", c.dono);
      const saida = l.map((o: Oferta) => ({ id: o.id, texto: texto(o, lk), imagem: o.imagem || null }));
      if (cupom) saida.splice(Math.min(1, saida.length), 0, cupom); // o cupom entra logo depois da primeira oferta
      return json({ ofertas: saida, motivo: saida.length ? "ok" : "sem ofertas" });
    }
    if (body.acao === "confirmar") {
      const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 50) : [];
      const agora = new Date().toISOString();
      for (const id of ids) {
        if (id.startsWith("c:")) { await db.from("achados_cupons").update({ wa_avisado_em: agora }).eq("id", id.slice(2)).eq("dono", c.dono); continue; }
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
