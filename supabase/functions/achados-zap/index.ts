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

function texto(o: Oferta) {
  const d = descontoDe(o);
  return [
    `${d && d >= 40 ? "🔥 ACHADÃO" : "🛒 ACHADO DO DIA"} ${LOJA[o.marketplace] || ""}`.trim(), "",
    `*${String(o.titulo).slice(0, 160)}*`, "",
    (o.preco_de && d ? `~De ${brl(Number(o.preco_de))}~\n` : "") + `✅ *Por ${brl(Number(o.preco_por))}*${d ? ` (${d}% OFF)` : ""}`,
    o.cupom ? `🎟️ Cupom: *${o.cupom}*` : null,
    o.nota ? `📌 ${o.nota}` : null, "",
    `👉 ${o.link}`, "",
    "⚠️ Preço e estoque podem mudar a qualquer momento.",
    "_O Cara dos Achados_",
  ].filter((x) => x !== null).join("\n");
}

function horaSP() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hourCycle: "h23" }).format(new Date()));
}

async function proximas(dono: string, minDesc: number, qtd: number) {
  const hoje = new Date().toISOString().slice(0, 10);
  const { data } = await db.from("achados_ofertas").select("*").eq("dono", dono).not("link", "is", null).eq("exemplo", false)
    .is("wa_avisado_em", null).in("status", ["nova", "aprovada", "postada"]).or(`validade.is.null,validade.gte.${hoje}`).limit(400);
  const lst = (data || []).filter((o: Oferta) => (descontoDe(o) || 0) >= minDesc && !(o.canais || []).includes("whatsapp"));
  lst.sort((a: Oferta, b: Oferta) => (b.status === "aprovada" ? 1 : 0) - (a.status === "aprovada" ? 1 : 0) || pontuacao(b) - pontuacao(a));
  return lst.slice(0, qtd);
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ erro: "use POST" }, 405);
    const { data: seg } = await db.from("segredos").select("valor").eq("chave", "zap").maybeSingle();
    if (!seg || (req.headers.get("x-zap-key") || "") !== seg.valor) return json({ erro: "não autorizado" }, 401);
    const body = await req.json().catch(() => ({}));

    const { data: cfgs } = await db.from("achados_config").select("dono,zap_ativo,zap_ultimo,wa_qtd,wa_intervalo_min,wa_hora_ini,wa_hora_fim,wa_desconto_min").limit(1);
    const c = (cfgs || [])[0];
    if (!c) return json({ erro: "Sem configuração." }, 404);

    if (body.acao === "proximas") {
      if (body.teste) {
        const l = await proximas(c.dono, c.wa_desconto_min, 1);
        return json({ ofertas: l.map((o: Oferta) => ({ id: o.id, texto: texto(o), imagem: o.imagem || null })), motivo: l.length ? "teste" : "sem ofertas" });
      }
      if (!c.zap_ativo) return json({ ofertas: [], motivo: "desligado" });
      const h = horaSP();
      if (h < c.wa_hora_ini || h >= c.wa_hora_fim) return json({ ofertas: [], motivo: "fora do horário" });
      const intervalo = Math.max(10, Number(c.wa_intervalo_min) || 60);
      if (c.zap_ultimo && Date.now() - Date.parse(c.zap_ultimo) < (intervalo * 60 - 30) * 1000) return json({ ofertas: [], motivo: "aguardando intervalo" });
      const l = await proximas(c.dono, c.wa_desconto_min, Math.max(1, Math.min(30, Number(c.wa_qtd) || 1)));
      if (l.length) await db.from("achados_config").update({ zap_ultimo: new Date().toISOString() }).eq("dono", c.dono);
      return json({ ofertas: l.map((o: Oferta) => ({ id: o.id, texto: texto(o), imagem: o.imagem || null })), motivo: l.length ? "ok" : "sem ofertas" });
    }
    if (body.acao === "confirmar") {
      const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 50) : [];
      const agora = new Date().toISOString();
      for (const id of ids) {
        const { data: o } = await db.from("achados_ofertas").select("canais").eq("id", id).eq("dono", c.dono).maybeSingle();
        if (!o) continue;
        await db.from("achados_ofertas").update({ wa_avisado_em: agora, canais: [...new Set([...(o.canais || []), "whatsapp"])] }).eq("id", id).eq("dono", c.dono);
      }
      await db.from("achados_config").update({ wa_msg: `Robô postou ${ids.length} oferta(s) no canal (${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })})` }).eq("dono", c.dono);
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
