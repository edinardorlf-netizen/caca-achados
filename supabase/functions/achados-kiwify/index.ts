// =====================================================================
// Caça Achados · avisos da Kiwify (Supabase Edge Function "achados-kiwify")
//
// A Kiwify chama esta função a cada compra, renovação, atraso, cancelamento, reembolso ou chargeback.
// Ela confere a assinatura do aviso (HMAC-SHA1 do corpo com o token do webhook, no parâmetro ?signature=),
// cadastra ou atualiza o cliente em achados_donos e aplica a regra de acesso (achados_assinatura_aplicar):
// pago → tudo ligado; período pago acabou + 7 dias → automações pausadas; reembolso/chargeback → pausa na hora.
//
// O token fica em segredos.chave = 'kiwify_webhook' (nunca no código).
// Plano: o produto ou o plano cujo nome tiver "robô"/"robo"/"whatsapp" dá o plano 'robo'; o resto, 'base'.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function hmacSha1(chave: string, corpo: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(corpo));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function igual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
// deno-lint-ignore no-explicit-any
const pega = (o: any, ...caminhos: string[]) => {
  for (const c of caminhos) {
    const v = c.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
    if (v != null && v !== "") return v;
  }
  return null;
};

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ erro: "use POST" }, 405);
    const corpo = await req.text(); // corpo cru: a assinatura é calculada sobre ele, sem reformatar
    const { data: seg } = await db.from("segredos").select("valor").eq("chave", "kiwify_webhook").maybeSingle();
    const assinatura = (new URL(req.url).searchParams.get("signature") || "").toLowerCase();
    if (!seg?.valor || !assinatura || !igual(await hmacSha1(seg.valor, corpo), assinatura)) return json({ erro: "assinatura inválida" }, 401);

    const ev = JSON.parse(corpo);
    const tipo = String(pega(ev, "webhook_event_type") || "");
    const email = String(pega(ev, "Customer.email", "customer.email", "Customer.Email") || "").trim().toLowerCase();
    const nome = pega(ev, "Customer.full_name", "Customer.name", "customer.full_name");
    const assinaturaId = pega(ev, "subscription_id", "Subscription.id");
    const chave = `${pega(ev, "order_id") || assinaturaId || "?"}:${tipo}`;

    const { error: dup } = await db.from("achados_kiwify_eventos").insert({ chave, tipo, email: email || null, corpo: ev });
    if (dup && /duplicate/i.test(dup.message)) return json({ ok: true, repetido: true });
    const registra = (resultado: string) => db.from("achados_kiwify_eventos").update({ resultado }).eq("chave", chave);

    if (!email) { await registra("sem e-mail do cliente"); return json({ ok: true }); }
    if (["billet_created", "pix_created", "order_rejected", "subscription_trial_canceled"].includes(tipo)) {
      await registra("ignorado"); return json({ ok: true });
    }

    const nomes = [pega(ev, "Product.product_name", "Product.name", "product.name"), pega(ev, "Subscription.plan.name")].filter(Boolean).join(" ");
    // Sem nome de produto/plano no aviso (ex.: alguns avisos de atraso), mantém o plano que já estava.
    const plano = nomes ? (/rob[oô]|whats/i.test(nomes) ? "robo" : "base") : null;
    const acessoAte = pega(ev, "Subscription.customer_access.access_until", "customer_access.access_until");
    const temAcesso = pega(ev, "Subscription.customer_access.has_access", "customer_access.has_access");

    let status = "ativo";
    if (tipo === "order_refunded" || tipo === "chargeback") status = "reembolsado";
    else if (tipo === "subscription_canceled") status = "cancelado";
    else if (tipo === "subscription_late") status = "atrasado";

    const { data: atual } = await db.from("achados_donos").select("status").eq("email", email).maybeSingle();
    if (atual?.status === "vitalicio") { await registra("dono vitalício: sem mudança"); return json({ ok: true }); }

    const linha: Record<string, unknown> = { email, status, origem: "kiwify", atualizado_em: new Date().toISOString() };
    if (plano) linha.plano = plano;
    if (nome) linha.nome = String(nome).slice(0, 120);
    if (assinaturaId) linha.assinatura_id = String(assinaturaId);
    if (acessoAte) linha.acesso_ate = acessoAte;
    else if (status === "ativo" && temAcesso !== false) linha.acesso_ate = null; // compra sem data de fim (ex.: anual à vista): sem vencimento até novo aviso
    if (status === "reembolsado") linha.acesso_ate = new Date().toISOString();

    const { error } = await db.from("achados_donos").upsert(linha, { onConflict: "email" });
    if (error) { await registra(`erro: ${error.message}`); return json({ erro: error.message }, 500); }
    const { data: r } = await db.rpc("achados_assinatura_aplicar", { p_email: email });
    await registra(`${status} (${plano}) → ${r}`);
    return json({ ok: true, resultado: r });
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
