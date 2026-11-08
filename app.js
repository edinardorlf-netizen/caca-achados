/* Caça Achados · um sistema Auraxis
   Fila de promoções de afiliado com posts prontos. Dados no Supabase (só o dono vê). */
const CFG = window.ACHADOS_CONFIG;
const sb = supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true } });
const FN = `${CFG.url}/functions/v1/achados-ml`, FN_SHP = `${CFG.url}/functions/v1/achados-shopee`;

const MKT = {
  shopee:{nome:"Shopee",cor:"var(--shopee)",
    links:[["Ofertas relâmpago","https://shopee.com.br/flash_sale"],["Portal de afiliados (produtos e comissões)","https://affiliate.shopee.com.br/offer/product_offer"]],
    dica:"No portal de afiliados, filtre por comissão e vendas e gere o link curto. Peça acesso à Open API de afiliados no próprio portal: com ela o Caça Achados busca ofertas sozinho."},
  meli:{nome:"Mercado Livre",cor:"var(--meli)",
    links:[["Ofertas do dia","https://www.mercadolivre.com.br/ofertas"],["Gerar link de afiliado","https://www.mercadolivre.com.br/l/afiliados-gerar-link"]],
    dica:"Os mais vendidos com desconto entram na fila sozinhos (aba Mercado Livre). Para cada um, abra o produto logado como afiliado e use “Compartilhar” para pegar o seu link."},
  amazon:{nome:"Amazon",cor:"var(--amazon)",
    links:[["Ofertas do dia","https://www.amazon.com.br/deals"],["Associados Amazon","https://associados.amazon.com.br/"]],
    dica:"Use a barra SiteStripe (aparece logado no Associados) para gerar o link curto amzn.to. A API de produtos só libera depois de algumas vendas qualificadas."},
  tiktok:{nome:"TikTok Shop",cor:"var(--tiktok)",
    links:[["TikTok Shop","https://www.tiktok.com/shop"]],
    dica:"No app: Perfil › Central de criadores › Afiliados › Mercado de produtos. Adicione à sua vitrine e use nas lives e vídeos (carrinho laranja)."},
  outro:{nome:"Outra loja",cor:"var(--outro)",links:[],dica:""},
};
let ofertas = [], selId = null, canal = "whatsapp", filtroMkt = "todas", editId = null, canalRT = null, cfgML = null, catsML = null, tgPronto = false;
const $ = (s) => document.querySelector(s);
const brl = (v) => v == null || isNaN(v) ? "" : Number(v).toLocaleString("pt-BR",{style:"currency",currency:"BRL"});
const num = (s) => { if (s == null || s === "") return null; const t = String(s).replace(/[^\d,.-]/g,""); const v = t.includes(",") ? Number(t.replace(/\./g,"").replace(",",".")) : Number(t); return isFinite(v) ? v : null; };
const desc = (o) => o.precoDe && o.precoPor && o.precoDe > o.precoPor ? Math.round((1 - o.precoPor/o.precoDe)*100) : null;
const hoje = () => new Date().toISOString().slice(0,10);
const vencida = (o) => o.validade && o.validade < hoje();
// Pontuação: desconto pesa mais; comissão, cupom e posição entre os mais vendidos ajudam; vencida zera.
const score = (o) => vencida(o) ? 0 : Math.round((desc(o)||0)*1.2 + (o.comissao||0)*2 + (o.cupom?8:0) + (o.mlPosicao ? Math.max(0, 12 - o.mlPosicao) : 0));
function toast(m){ const t=$("#toast"); t.textContent=m; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true,3200); }
function esc(s){ return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]); }
function mktDe(url){ const u=(url||"").toLowerCase();
  if(/shopee|shp\.ee/.test(u)) return "shopee";
  if(/mercadoli|meli\.la|mercadolibre/.test(u)) return "meli";
  if(/amazon|amzn\./.test(u)) return "amazon";
  if(/tiktok/.test(u)) return "tiktok";
  return "outro"; }
const errMsg = (e) => (e && (e.message || e.error_description || e.erro)) || String(e);

// Banco ↔ tela
const daLinha = (r) => ({ id:r.id, titulo:r.titulo, marketplace:r.marketplace, categoria:r.categoria, link:r.link, linkProduto:r.link_produto,
  precoDe: r.preco_de!=null?Number(r.preco_de):null, precoPor: r.preco_por!=null?Number(r.preco_por):null, cupom:r.cupom, comissao: r.comissao!=null?Number(r.comissao):null,
  validade:r.validade, imagem:r.imagem, nota:r.nota, status:r.status, canais:r.canais||[], exemplo:r.exemplo, fonte:r.fonte, linkAuto:r.link_auto, mlPosicao:r.ml_posicao, criadoEm:r.criado_em, postadoEm:r.postado_em });
const paraLinha = (o) => ({ titulo:o.titulo, marketplace:o.marketplace, categoria:o.categoria||null, link:o.link||null, preco_de:o.precoDe, preco_por:o.precoPor,
  cupom:o.cupom||null, comissao:o.comissao, validade:o.validade||null, imagem:o.imagem||null, nota:o.nota||null });

// ---------- Ler texto compartilhado ----------
function lerTexto(txt){
  const url = (txt.match(/https?:\/\/[^\s<>"']+/i)||[])[0] || "";
  const precos = [...txt.matchAll(/R\$\s*([\d.]+,\d{2}|\d+(?:[.,]\d{2})?)/gi)].map(m=>num(m[1])).filter(v=>v!=null);
  const pct = (txt.match(/(\d{1,2})\s*%\s*(?:off|de desconto)/i)||[])[1];
  const cupom = (txt.match(/cupom[:\s]+([A-Z0-9_-]{4,})/i)||[])[1] || "";
  let titulo = txt.replace(url,"").split(/\n/).map(l=>l.trim()).filter(Boolean)[0] || "";
  const corte = titulo.search(/(\b(de|por|apenas|só)\s*)?R\$|\(?\d{1,2}\s*%\s*off|\bcupom\b/i);
  if (corte > 3) titulo = titulo.slice(0, corte);
  titulo = titulo.replace(/R\$\s*[\d.,]+/g,"").replace(/[-–|:]+\s*$/,"").replace(/\b(confira|olha|veja|achei|compre|aproveite)\b[:!]?/gi,"").replace(/\b(de|por)\s*$/i,"").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,"").replace(/\s{2,}/g," ").trim().slice(0,140);
  let de=null, por=null;
  if(precos.length>=2){ de=Math.max(...precos); por=Math.min(...precos); } else if(precos.length===1){ por=precos[0]; if(pct) de=Math.round(por/(1-pct/100)*100)/100; }
  return {titulo, link:url, marketplace:mktDe(url), precoDe:de, precoPor:por, cupom};
}

// ---------- Posts ----------
function gerarPost(o, c){
  const d = desc(o), aviso = $("#aviso-afiliado").checked;
  const link = o.link || "[cole aqui o seu link de afiliado]";
  const pr = (o.precoDe && d ? (c==="whatsapp" ? `~De ${brl(o.precoDe)}~\n` : `De ${brl(o.precoDe)}\n`) : "");
  const b = (t) => c==="whatsapp" ? `*${t}*` : t;
  const loja = MKT[o.marketplace]?.nome || "";
  if(c==="whatsapp" || c==="telegram"){
    return [
      `${d>=40?"🔥 ACHADÃO":"🛒 ACHADO DO DIA"} ${loja?`${["meli","tiktok"].includes(o.marketplace)?"no":"na"} ${loja}`:""}`.trim(), "",
      b(o.titulo), "",
      pr + `✅ ${b(`Por ${brl(o.precoPor)}`)}${d?` (${d}% OFF)`:""}`,
      o.cupom ? `🎟️ Cupom: ${b(o.cupom)}` : null,
      o.nota ? `📌 ${o.nota}` : null, "",
      `👉 ${link}`, "",
      "⚠️ Preço e estoque podem mudar a qualquer momento.",
      aviso ? "🔗 Link de afiliado: posso ganhar comissão, sem custo extra para você." : null,
      c==="whatsapp" ? "_O Cara dos Achados_" : "— O Cara dos Achados",
    ].filter(x=>x!==null).join("\n");
  }
  if(c==="social"){
    const tags = ["#achadinhos","#ocaradosachados", loja?`#${loja.toLowerCase().replace(/\s/g,"")}`:null, o.categoria?`#${o.categoria.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]/g,"")}`:null, "#promocao","#oferta"].filter(Boolean);
    return [
      `${o.titulo} por ${brl(o.precoPor)}${d?` (${d}% OFF)`:""} 😱`,
      o.cupom ? `Cupom: ${o.cupom}` : null,
      o.marketplace==="tiktok" ? "Tá no carrinho laranja 🧡" : "Link na bio 🔗",
      aviso ? "#publi | link de afiliado" : null, "",
      tags.join(" "),
    ].filter(x=>x!==null).join("\n");
  }
  return [
    `ROTEIRO · ${o.titulo}`, "",
    "1. Gancho (5 s): “Gente, olha o que eu achei hoje!” — mostre o produto na mão ou na tela.",
    `2. O que é (15 s): fale pra que serve e 2 detalhes que chamam atenção.`,
    `3. Preço (10 s): ${o.precoDe&&d?`“Custava ${brl(o.precoDe)}… hoje sai por ${brl(o.precoPor)}, ${d}% de desconto!”`:`“Hoje sai por ${brl(o.precoPor)}!”`}`,
    o.cupom ? `4. Cupom (5 s): “Usa o cupom ${o.cupom} no carrinho.”` : "4. Prova (10 s): avaliações, vendidos ou comparação com loja física.",
    `5. Urgência (10 s): ${o.validade?`“Vale só até ${new Date(o.validade+"T12:00").toLocaleDateString("pt-BR")}.”`:"“Promoção relâmpago, o preço pode subir a qualquer momento.”"}`,
    `6. Chamada (5 s): ${o.marketplace==="tiktok"?"“Toca no carrinho laranja aqui embaixo!”":"“Link fixado aqui no chat / na bio.”"}`,
    o.nota ? `\nLembrete: ${o.nota}` : null,
  ].filter(x=>x!==null).join("\n");
}

// ---------- Render ----------
function render(){
  const ativas = ofertas.filter(o=>o.status==="nova"||o.status==="aprovada");
  $("#n-fila").textContent = ativas.length;
  const lojas = ["todas", ...Object.keys(MKT).filter(k=>ativas.some(o=>o.marketplace===k))];
  $("#filtro-mkt").innerHTML = lojas.map(k=>`<button class="chip" aria-pressed="${filtroMkt===k}" data-k="${k}">${k==="todas"?"Todas":MKT[k].nome} <span style="font-family:var(--f-mono)">${k==="todas"?ativas.length:ativas.filter(o=>o.marketplace===k).length}</span></button>`).join("");
  const ordem = $("#ordem").value;
  let lst = ativas.filter(o=>filtroMkt==="todas"||o.marketplace===filtroMkt);
  lst.sort((a,b)=> ordem==="novas" ? (b.criadoEm||"").localeCompare(a.criadoEm||"") : ordem==="desconto" ? (desc(b)||0)-(desc(a)||0) : ordem==="validade" ? (a.validade||"9").localeCompare(b.validade||"9") : score(b)-score(a));
  const el = $("#lista");
  if(!lst.length){ el.innerHTML = `<div class="vazio">Nenhuma oferta na fila${filtroMkt!=="todas"?" desta loja":""}. Toque em “+ Nova oferta”, cole um link na aba Caçar ou ligue a busca do Mercado Livre.</div>`; }
  else el.innerHTML = lst.map(o=>{
    const d=desc(o), m=MKT[o.marketplace]||MKT.outro;
    return `<div class="oferta" role="button" tabindex="0" data-id="${o.id}" aria-current="${o.id===selId}" style="--c:${m.cor}">
      <div class="thumb">${o.imagem?`<img src="${esc(o.imagem)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`:`<b>${m.nome}</b>`}</div>
      <div style="min-width:0"><div class="o-tit">${esc(o.titulo)}</div>
        <div class="o-meta"><span class="tag mk">${m.nome}</span>${o.fonte==="ml"?`<span class="tag">Mais vendido${o.mlPosicao?` #${o.mlPosicao}`:""}</span>`:""}${o.exemplo?'<span class="tag ex">Exemplo</span>':""}${o.cupom?`<span class="tag">Cupom ${esc(o.cupom)}</span>`:""}${o.comissao?`<span class="tag ok">${String(o.comissao).replace(".",",")}% comissão</span>`:""}${vencida(o)?'<span class="tag warn">Vencida</span>':o.validade?`<span class="tag">até ${new Date(o.validade+"T12:00").toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})}</span>`:""}${!o.link?'<span class="tag warn">Sem link de afiliado</span>':o.linkAuto?'<span class="tag ok">Link montado</span>':""}${o.status==="aprovada"?'<span class="tag ok">Aprovada</span>':""}</div>
        <div class="score">Nota ${score(o)}${o.categoria?` · ${esc(o.categoria)}`:""}</div></div>
      <div class="preco">${o.precoDe&&d?`<s>${brl(o.precoDe)}</s>`:""}<strong>${brl(o.precoPor)||"—"}</strong>${d?`<span class="off">-${d}%</span>`:""}</div>
    </div>`; }).join("");
  renderGerador(); renderPostadas();
}
function renderGerador(){
  const o = ofertas.find(x=>x.id===selId);
  $("#ger").hidden = !o; $("#ger-vazio").hidden = !!o;
  if(!o) return;
  $("#ger-tit").textContent = o.titulo;
  $("#falta-link").hidden = !!o.link;
  if(!o.link){ $("#fl-abrir").href = o.linkProduto || "https://www.mercadolivre.com.br"; $("#fl-abrir").hidden = !o.linkProduto; }
  document.querySelectorAll("#canais button").forEach(b=>b.setAttribute("aria-selected", b.dataset.c===canal));
  $("#post").value = gerarPost(o, canal); atualizaLinks();
  $("#btn-postada").textContent = o.status==="postada" ? "Já postada" : "Marcar como postada";
  $("#btn-tg-post").hidden = !(tgPronto && o.link && o.status!=="postada");
  $("#btn-aprovar").hidden = o.status==="postada";
  $("#btn-aprovar").textContent = o.status==="aprovada" ? "Tirar aprovação" : "Aprovar";
}
function atualizaLinks(){
  const o = ofertas.find(x=>x.id===selId); const txt=$("#post").value;
  $("#btn-wa").href = "https://wa.me/?text="+encodeURIComponent(txt);
  $("#btn-tg").href = "https://t.me/share/url?url="+encodeURIComponent(o?.link||"")+"&text="+encodeURIComponent(o?.link ? txt.replace(o.link,"") : txt);
}
function renderPostadas(){
  const p = ofertas.filter(o=>o.status==="postada").sort((a,b)=>(b.postadoEm||"").localeCompare(a.postadoEm||""));
  const semana = p.filter(o=>o.postadoEm && Date.now()-Date.parse(o.postadoEm) < 7*864e5).length;
  const porLoja = Object.keys(MKT).map(k=>[k,p.filter(o=>o.marketplace===k).length]).filter(x=>x[1]).sort((a,b)=>b[1]-a[1]);
  const mediaDesc = p.length ? Math.round(p.reduce((a,o)=>a+(desc(o)||0),0)/p.length) : 0;
  $("#stats").innerHTML = [[p.length,"posts no total"],[semana,"nos últimos 7 dias"],[mediaDesc+"%","desconto médio postado"],[porLoja[0]?MKT[porLoja[0][0]].nome:"—","loja mais postada"]]
    .map(([v,l])=>`<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  $("#hist").innerHTML = p.length ? p.map(o=>`<tr><td>${o.postadoEm?new Date(o.postadoEm).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):"—"}</td><td>${esc(o.titulo)}</td><td>${MKT[o.marketplace]?.nome||""}</td><td>${(o.canais||[]).map(c=>({whatsapp:"WhatsApp",telegram:"Telegram",social:"TikTok/Insta",live:"Live"})[c]||c).join(", ")||"—"}</td><td class="n">${brl(o.precoPor)}</td><td class="n">${desc(o)!=null?desc(o)+"%":"—"}</td></tr>`).join("")
    : `<tr><td colspan="6" class="hint" style="padding:16px">Quando você marcar uma oferta como postada, ela aparece aqui.</td></tr>`;
}

// ---------- Dados ----------
async function carregarOfertas(){
  const { data, error } = await sb.from("achados_ofertas").select("*").neq("status","descartada").order("criado_em",{ascending:false}).limit(1000);
  if(error){ toast("Não consegui carregar as ofertas: "+error.message); return; }
  ofertas = (data||[]).map(daLinha);
  if(selId && !ofertas.some(o=>o.id===selId)) selId=null;
  if(!selId){ const top = ofertas.filter(o=>o.status==="nova"||o.status==="aprovada").sort((a,b)=>score(b)-score(a))[0]; if(top) selId=top.id; }
  render();
}
function ouvir(){
  if(canalRT) sb.removeChannel(canalRT);
  let t=null;
  canalRT = sb.channel("achados").on("postgres_changes",{event:"*",schema:"public",table:"achados_ofertas"},()=>{ clearTimeout(t); t=setTimeout(carregarOfertas,400); }).subscribe();
}
async function salvarOferta(id, patch){
  const { error } = await sb.from("achados_ofertas").update(patch).eq("id", id);
  if(error) throw error;
  await carregarOfertas();
}

// ---------- Caçar ----------
$("#mkts").innerHTML = ["shopee","meli","amazon","tiktok"].map(k=>{const m=MKT[k];return `<div class="mkt" style="--c:${m.cor}"><h3>${m.nome}</h3><ul>${m.links.map(([t,u])=>`<li><a href="${u}" target="_blank" rel="noopener">${t}</a></li>`).join("")}</ul><div class="api">${m.dica}</div></div>`;}).join("");
$("#btn-ler").onclick = () => {
  const t = $("#colar").value.trim(); if(!t){ $("#colar-msg").textContent="Cole um texto ou link primeiro."; return; }
  const o = lerTexto(t); abrirEditor(o);
  $("#colar-msg").textContent = o.precoPor ? "" : "Não achei o preço no texto: preencha no formulário.";
};

// ---------- Editor ----------
$("#f-mkt").innerHTML = Object.entries(MKT).map(([k,m])=>`<option value="${k}">${m.nome}</option>`).join("");
function abrirEditor(o={}, id=null){
  editId = id;
  $("#ed-tit").textContent = id ? "Editar oferta" : "Nova oferta";
  $("#f-titulo").value=o.titulo||""; $("#f-mkt").value=o.marketplace||"shopee"; $("#f-cat").value=o.categoria||"";
  $("#f-link").value=o.link||""; $("#f-de").value=o.precoDe!=null?String(o.precoDe).replace(".",","):""; $("#f-por").value=o.precoPor!=null?String(o.precoPor).replace(".",","):"";
  $("#f-cupom").value=o.cupom||""; $("#f-com").value=o.comissao!=null?String(o.comissao).replace(".",","):""; $("#f-val").value=o.validade||""; $("#f-img").value=o.imagem||""; $("#f-nota").value=o.nota||"";
  $("#ed-msg").textContent=""; calc();
  const d=$("#editor"); if(d.showModal) d.showModal(); else d.setAttribute("open","");
}
function lerForm(){ return {
  titulo:$("#f-titulo").value.trim(), marketplace:$("#f-mkt").value, categoria:$("#f-cat").value.trim(), link:$("#f-link").value.trim(),
  precoDe:num($("#f-de").value), precoPor:num($("#f-por").value), cupom:$("#f-cupom").value.trim().toUpperCase(), comissao:num($("#f-com").value),
  validade:$("#f-val").value||null, imagem:$("#f-img").value.trim(), nota:$("#f-nota").value.trim() }; }
function calc(){ const o=lerForm(); const d=desc(o); $("#ed-calc").textContent = o.precoPor ? `${d?`${d}% de desconto · `:""}nota ${score(o)}` : ""; }
$("#form").addEventListener("input", (e)=>{ if(e.target.id==="f-link" && !editId && mktDe(e.target.value)!=="outro") $("#f-mkt").value = mktDe(e.target.value); calc(); });
$("#ed-fechar").onclick = () => $("#editor").close?.();
$("#form").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const o = lerForm();
  if(!o.titulo){ $("#ed-msg").textContent="Dê um nome ao produto."; return; }
  if(o.precoPor==null){ $("#ed-msg").textContent="Informe o preço por."; return; }
  $("#ed-salvar").disabled=true;
  try{
    if(editId){
      const antes = ofertas.find(x=>x.id===editId);
      const patch = paraLinha(o); if(!antes || (antes.link||"") !== (o.link||"")) patch.link_auto = false;
      await salvarOferta(editId, patch); selId=editId; toast("Oferta atualizada"); }
    else {
      const { data, error } = await sb.from("achados_ofertas").insert({...paraLinha(o), status:"nova", fonte:"manual"}).select("id").single();
      if(error) throw error;
      selId=data.id; $("#colar").value=""; toast("Oferta salva na fila"); await carregarOfertas();
    }
    $("#editor").close?.(); mostrar("fila");
  }catch(err){ $("#ed-msg").textContent = "Não consegui salvar: "+errMsg(err); }
  $("#ed-salvar").disabled=false;
});
$("#btn-nova").onclick = () => abrirEditor();

// ---------- Fila e gerador ----------
$("#lista").addEventListener("click", (e)=>{ const c=e.target.closest(".oferta"); if(c){ selId=c.dataset.id; render(); if(innerWidth<900) $("#gerador").scrollIntoView({behavior:"smooth",block:"start"}); } });
$("#lista").addEventListener("keydown", (e)=>{ if(e.key==="Enter"){ const c=e.target.closest(".oferta"); if(c){ selId=c.dataset.id; render(); } } });
$("#filtro-mkt").addEventListener("click", (e)=>{ const b=e.target.closest(".chip"); if(b){ filtroMkt=b.dataset.k; render(); } });
$("#ordem").onchange = render;
$("#canais").addEventListener("click", (e)=>{ const b=e.target.closest("button"); if(b){ canal=b.dataset.c; renderGerador(); } });
$("#aviso-afiliado").onchange = renderGerador;
$("#post").addEventListener("input", atualizaLinks);
$("#btn-copiar").onclick = async () => {
  const t=$("#post");
  try{ await navigator.clipboard.writeText(t.value); toast("Texto copiado"); }
  catch{ t.focus(); t.select(); toast("Selecionei o texto: use Copiar do seu aparelho"); }
};
$("#fl-salvar").onclick = async () => {
  const v = $("#fl-link").value.trim();
  if(!/^https?:\/\//i.test(v)){ toast("Cole o link completo, começando com https://"); return; }
  try{ await salvarOferta(selId, { link: v, link_auto: false }); $("#fl-link").value=""; toast("Link de afiliado salvo"); }catch(err){ toast("Não consegui salvar: "+errMsg(err)); }
};
async function setStatus(status){
  const o = ofertas.find(x=>x.id===selId); if(!o) return;
  if(status==="postada" && !o.link){ toast("Antes de postar, salve o seu link de afiliado."); return; }
  const patch = {status};
  if(status==="postada"){ patch.postado_em=new Date().toISOString(); patch.canais=[...new Set([...(o.canais||[]), canal])]; }
  try{ if(status==="descartada") selId=null; await salvarOferta(o.id, patch); toast(status==="postada"?"Marcada como postada":"Oferta descartada"); }
  catch(err){ toast("Não consegui salvar: "+errMsg(err)); }
}
$("#btn-postada").onclick = () => setStatus("postada");
$("#btn-aprovar").onclick = async () => {
  const o = ofertas.find(x=>x.id===selId); if(!o) return;
  const novo = o.status==="aprovada" ? "nova" : "aprovada";
  try{ await salvarOferta(o.id, { status: novo }); toast(novo==="aprovada" ? "Aprovada: entra na frente da fila do Telegram" : "Aprovação retirada"); }
  catch(err){ toast("Não consegui salvar: "+errMsg(err)); }
};
$("#btn-tg-post").onclick = async () => {
  const b=$("#btn-tg-post"); b.disabled=true;
  try{ await chamarML("telegram_postar", { id: selId }); toast("Postado no Telegram"); await carregarOfertas(); }
  catch(err){ toast(errMsg(err)); }
  b.disabled=false;
};
$("#btn-descartar").onclick = () => setStatus("descartada");
$("#btn-editar").onclick = () => { const o=ofertas.find(x=>x.id===selId); if(o) abrirEditor(o, o.id); };

// ---------- Mercado Livre ----------
async function chamarML(acao, extra={}, url=FN){
  const { data:{ session } } = await sb.auth.getSession();
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${session?.access_token||""}`, apikey: CFG.key }, body: JSON.stringify({ acao, ...extra }) });
  const j = await r.json().catch(()=>({}));
  if(!r.ok || j.erro) throw new Error(j.erro || `Erro ${r.status}`);
  return j;
}
async function carregarML(){
  const [st, cf, ts, ss] = await Promise.all([ sb.rpc("achados_ml_status"),
    sb.from("achados_config").select("ml_client_id,ml_categorias,ml_categorias_nomes,desconto_min,ml_afiliado_query,ml_afiliado_em,tg_ativo,tg_intervalo_min,tg_hora_ini,tg_hora_fim,tg_modo,tg_desconto_min,tg_ultimo_post,tg_msg,shp_app_id,shp_ativo,shp_palavras,shp_top,shp_desconto_min,shp_comissao_min,shp_sinc_em,shp_sinc_ok,shp_sinc_msg").maybeSingle(),
    sb.rpc("achados_tg_status"), sb.rpc("achados_shp_status") ]);
  const s = (st.data||[])[0] || {};
  cfgML = cf.data || { ml_categorias:[], ml_categorias_nomes:{}, desconto_min:20 };
  $("#ml-status").innerHTML = s.conectado ? `<span class="ponto on"></span> Conectado${s.nickname?` como <b>${esc(s.nickname)}</b>`:""}`
    : s.tem_app && s.tem_secret ? `<span class="ponto"></span> App salvo. Falta autorizar o acesso no Mercado Livre.` : `<span class="ponto"></span> Ainda não conectado`;
  $("#ml-sinc").textContent = s.sinc_em ? `Última busca: ${new Date(s.sinc_em).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})} · ${s.sinc_msg||""}` : (s.sinc_msg||"");
  $("#ml-acoes").innerHTML = s.conectado ? `<button class="btn ghost sm" id="ml-trocar" type="button">Trocar Secret Key</button><button class="btn ghost sm" id="ml-desc" type="button">Desconectar</button>` : (s.tem_app && s.tem_secret ? `<button class="btn amarelo" id="ml-con" type="button">Conectar Mercado Livre</button>` : "");
  $("#ml-id").value = cfgML.ml_client_id || "";
  $("#ml-app").hidden = !!s.conectado;
  $("#ml-min").value = cfgML.desconto_min ?? 20;
  if(s.conectado && !catsML){ try{ catsML = (await chamarML("categorias")).categorias || []; }catch(e){ $("#ml-cats").innerHTML = `<span class="erro">${esc(errMsg(e))}</span>`; } }
  renderCats(s.conectado);
  renderAfiliado(); renderTelegram((ts.data||[])[0] || {}); renderShopee((ss.data||[])[0] || {});
}
function renderShopee(t){
  const pronto = !!(t.tem_app && t.tem_secret);
  $("#shp-status").innerHTML = pronto ? `<span class="ponto ${cfgML.shp_sinc_ok===false?"":"on"}"></span> AppID salvo${cfgML.shp_ativo?" · busca automática <b>ligada</b>":" · busca automática desligada"}` : `<span class="ponto"></span> Aguardando a Shopee liberar a Open API.`;
  $("#shp-sinc").textContent = cfgML.shp_sinc_em ? `Última busca: ${new Date(cfgML.shp_sinc_em).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})} · ${cfgML.shp_sinc_msg||""}` : (cfgML.shp_sinc_msg||"");
  $("#shp-id").value = cfgML.shp_app_id || "";
  $("#shp-palavras").value = (cfgML.shp_palavras||[]).join("\n");
  $("#shp-min").value = cfgML.shp_desconto_min ?? 30; $("#shp-com").value = cfgML.shp_comissao_min ?? 0;
  $("#shp-top").checked = cfgML.shp_top !== false; $("#shp-ativo").checked = cfgML.shp_ativo !== false;
}
function renderAfiliado(){
  const q = cfgML.ml_afiliado_query;
  const nomes = q ? q.split("&").map(p=>decodeURIComponent(p.split("=")[0])).join(", ") : "";
  $("#af-status").innerHTML = q ? `<span class="ponto on"></span> Ligado desde ${new Date(cfgML.ml_afiliado_em).toLocaleDateString("pt-BR")} · código em: <code>${esc(nomes)}</code>` : `<span class="ponto"></span> Desligado: as ofertas do Mercado Livre chegam sem link de afiliado.`;
  $("#af-acoes").innerHTML = q ? `<button class="btn ghost sm" id="af-remover" type="button">Desligar e apagar links montados</button>` : "";
}
function renderTelegram(t){
  tgPronto = !!(t.tem_token && t.chat_id);
  $("#tg-status").innerHTML = tgPronto ? `<span class="ponto ${cfgML.tg_ativo?"on":""}"></span> Bot salvo · canal <b>${esc(t.chat_nome||t.chat_id)}</b> · automático ${cfgML.tg_ativo?"<b>ligado</b>":"desligado"}${cfgML.tg_ultimo_post?` · último post ${new Date(cfgML.tg_ultimo_post).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}`:""}` : `<span class="ponto"></span> Ainda não configurado.`;
  $("#tg-chat").value = t.chat_id || "";
  $("#tg-int").value = cfgML.tg_intervalo_min ?? 60; $("#tg-ini").value = cfgML.tg_hora_ini ?? 8; $("#tg-fim").value = cfgML.tg_hora_fim ?? 22;
  $("#tg-min").value = cfgML.tg_desconto_min ?? 30; $("#tg-modo").value = cfgML.tg_modo || "todas"; $("#tg-ativo").checked = !!cfgML.tg_ativo;
  $("#tg-msg").textContent = cfgML.tg_msg || "";
  renderGerador();
}
$("#af-salvar").onclick = async () => {
  const v = $("#af-link").value.trim();
  if(!/^https?:\/\//i.test(v)){ $("#af-msg").textContent = "Cole o link completo, começando com https://"; return; }
  const b=$("#af-salvar"); b.disabled=true; $("#af-msg").textContent="Lendo o link…";
  try{ const r = await chamarML("afiliado_ml", { link: v }); $("#af-link").value=""; $("#af-msg").textContent = `Pronto! Código encontrado (${r.parametros.join(", ")}). ${r.aplicados} oferta(s) já ganharam link de afiliado.`; await carregarOfertas(); await carregarML(); }
  catch(err){ $("#af-msg").textContent = errMsg(err); }
  b.disabled=false;
};
$("#af-acoes").addEventListener("click", async (e)=>{
  if(e.target.id!=="af-remover") return;
  try{ await chamarML("afiliado_ml_remover"); toast("Link automático desligado"); await carregarOfertas(); await carregarML(); }catch(err){ toast(errMsg(err)); }
});
$("#f-tg").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const tok = $("#tg-token").value.trim(), chat = $("#tg-chat").value.trim();
  $("#tg-salvar").disabled=true; $("#tg-msg").textContent="Salvando…";
  const { error } = await sb.rpc("achados_salvar_tg", { p_token: tok || null, p_chat: chat });
  if(error){ $("#tg-msg").textContent = error.message; $("#tg-salvar").disabled=false; return; }
  $("#tg-token").value="";
  try{ const r = await chamarML("telegram_testar"); toast(`Telegram conectado: @${r.bot} → ${r.chat}`); }
  catch(err){ $("#tg-msg").textContent = errMsg(err); }
  $("#tg-salvar").disabled=false; await carregarML();
});
$("#f-shp").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const id = $("#shp-id").value.trim(), sec = $("#shp-sec").value.trim();
  if(!/^\d{4,20}$/.test(id)){ $("#shp-msg").textContent="O AppID da Shopee é só números."; return; }
  $("#shp-salvar").disabled=true; $("#shp-msg").textContent="Salvando…";
  const { error } = await sb.rpc("achados_salvar_shopee", { p_app_id: id, p_secret: sec || null });
  if(error){ $("#shp-msg").textContent = error.message; $("#shp-salvar").disabled=false; return; }
  $("#shp-sec").value="";
  try{ const r = await chamarML("testar", {}, FN_SHP); $("#shp-msg").textContent = "Shopee conectada!" + (r.exemplo ? ` Exemplo: ${r.exemplo.titulo}` : ""); }
  catch(err){ $("#shp-msg").textContent = errMsg(err); }
  $("#shp-salvar").disabled=false; carregarML();
});
$("#shp-salvar-busca").onclick = async () => {
  const lim = (v,a,b,d) => { const n = Number(v); return isFinite(n) && v!=="" ? Math.max(a, Math.min(b, n)) : d; };
  const palavras = [...new Set($("#shp-palavras").value.split(/\n|,/).map(x=>x.trim()).filter(Boolean))].slice(0,12);
  const patch = { shp_palavras: palavras, shp_desconto_min: Math.round(lim($("#shp-min").value,0,95,30)), shp_comissao_min: lim($("#shp-com").value,0,100,0), shp_top: $("#shp-top").checked, shp_ativo: $("#shp-ativo").checked };
  const { data:{ user } } = await sb.auth.getUser();
  const { error } = await sb.from("achados_config").update(patch).eq("dono", (user?.email||"").toLowerCase());
  if(error) return toast("Não consegui salvar: "+error.message);
  toast(`Salvo: ${palavras.length} palavra(s), desconto mínimo ${patch.shp_desconto_min}%`); carregarML();
};
$("#shp-buscar").onclick = async () => {
  const b=$("#shp-buscar"); b.disabled=true; b.textContent="Buscando… (até 2 min)";
  try{ const r = await chamarML("buscar", {}, FN_SHP); toast(r.msg || "Busca concluída"); await carregarOfertas(); }
  catch(err){ toast(errMsg(err)); }
  b.disabled=false; b.textContent="Buscar agora"; carregarML();
};
$("#tg-salvar-agenda").onclick = async () => {
  const lim = (v,a,b,d) => { const n = Number(v); return isFinite(n) && v!=="" ? Math.max(a, Math.min(b, Math.round(n))) : d; };
  const patch = { tg_intervalo_min: lim($("#tg-int").value,10,1440,60), tg_hora_ini: lim($("#tg-ini").value,0,23,8), tg_hora_fim: lim($("#tg-fim").value,1,24,22),
    tg_desconto_min: lim($("#tg-min").value,0,95,30), tg_modo: $("#tg-modo").value, tg_ativo: $("#tg-ativo").checked };
  if(patch.tg_ativo && !tgPronto) return toast("Salve o bot e o canal antes de ligar o automático.");
  if(patch.tg_hora_fim <= patch.tg_hora_ini) return toast("A hora final precisa ser depois da inicial.");
  const { data:{ user } } = await sb.auth.getUser();
  const { error } = await sb.from("achados_config").update(patch).eq("dono", (user?.email||"").toLowerCase());
  if(error) return toast("Não consegui salvar: "+error.message);
  toast(patch.tg_ativo ? `Automático ligado: 1 post a cada ${patch.tg_intervalo_min} min, das ${patch.tg_hora_ini}h às ${patch.tg_hora_fim}h` : "Agenda salva (automático desligado)");
  carregarML();
};
function renderCats(conectado){
  if(!conectado){ $("#ml-cats").innerHTML = `<span class="hint">Conecte o Mercado Livre para escolher as categorias.</span>`; return; }
  if(!catsML) return;
  const sel = new Set(cfgML.ml_categorias||[]);
  $("#ml-cats").innerHTML = catsML.map(c=>`<button type="button" class="chip" data-id="${esc(c.id)}" data-nome="${esc(c.name)}" aria-pressed="${sel.has(c.id)}">${esc(c.name)}</button>`).join("");
}
$("#ml-cats").addEventListener("click",(e)=>{ const b=e.target.closest(".chip[data-id]"); if(b) b.setAttribute("aria-pressed", b.getAttribute("aria-pressed")!=="true"); });
$("#ml-acoes").addEventListener("click", async (e)=>{
  if(e.target.id==="ml-con"){
    e.target.disabled=true;
    try{ const { url } = await chamarML("conectar"); location.href = url; }catch(err){ toast(errMsg(err)); e.target.disabled=false; }
  }
  if(e.target.id==="ml-trocar"){ $("#ml-app").hidden=false; $("#ml-sec").focus(); return; }
  if(e.target.id==="ml-desc"){
    try{ await chamarML("desconectar"); catsML=null; toast("Mercado Livre desconectado"); carregarML(); }catch(err){ toast(errMsg(err)); }
  }
});
$("#f-mlapp").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const id = $("#ml-id").value.trim(), sec = $("#ml-sec").value.trim();
  if(!/^\d{5,25}$/.test(id)){ $("#ml-msg").textContent="O App ID é só números (aparece na sua aplicação no DevCenter)."; return; }
  $("#ml-salvar").disabled=true;
  const { error } = await sb.rpc("achados_salvar_ml", { p_client_id:id, p_secret: sec || null });
  $("#ml-salvar").disabled=false;
  if(error){ $("#ml-msg").textContent = error.message; return; }
  const jaConectado = !$("#ml-acoes #ml-desc") ? false : true;
  $("#ml-sec").value=""; $("#ml-msg").textContent = jaConectado ? "Secret Key trocada. A conexão continua valendo." : "Salvo. Agora toque em “Conectar Mercado Livre” e autorize."; carregarML();
});
$("#ml-salvar-busca").onclick = async () => {
  const sel = [...document.querySelectorAll('#ml-cats .chip[aria-pressed="true"]')];
  const ids = sel.map(b=>b.dataset.id), nomes = Object.fromEntries(sel.map(b=>[b.dataset.id,b.dataset.nome]));
  const min = Math.max(0, Math.min(90, Number($("#ml-min").value)||0));
  const { data:{ user } } = await sb.auth.getUser();
  const { error } = await sb.from("achados_config").update({ ml_categorias: ids, ml_categorias_nomes: nomes, desconto_min: min }).eq("dono", (user?.email||"").toLowerCase());
  if(error) return toast("Não consegui salvar: "+error.message);
  cfgML = { ...cfgML, ml_categorias: ids, ml_categorias_nomes: nomes, desconto_min: min };
  toast(ids.length ? `Salvo: ${ids.length} categoria(s), desconto mínimo de ${min}%` : "Salvo. Escolha pelo menos uma categoria para a busca rodar.");
};
$("#ml-buscar").onclick = async () => {
  const b=$("#ml-buscar"); b.disabled=true; b.textContent="Buscando… (até 2 min)";
  try{ const r = await chamarML("buscar"); toast(r.msg || "Busca concluída"); await carregarOfertas(); await carregarML(); }
  catch(err){ toast(errMsg(err)); }
  b.disabled=false; b.textContent="Buscar agora";
};

// ---------- Abas ----------
function mostrar(v){
  ["cacar","fila","postadas","ajustes"].forEach(k=>{ $("#v-"+k).hidden = k!==v; $("#tab-"+k).setAttribute("aria-selected", k===v); });
  try{ localStorage.setItem("ca-aba", v); }catch{}
  if(v==="ajustes") carregarML();
}
document.querySelector("nav.abas").addEventListener("click",(e)=>{ const b=e.target.closest("button[data-v]"); if(b) mostrar(b.dataset.v); });

// ---------- Login ----------
let modoLogin = "entrar";
$("#l-modo").onclick = () => {
  modoLogin = modoLogin === "entrar" ? "criar" : "entrar";
  $("#l-btn").textContent = modoLogin === "entrar" ? "Entrar" : "Criar conta";
  $("#l-modo").textContent = modoLogin === "entrar" ? "Primeiro acesso? Criar conta" : "Já tenho conta: entrar";
  $("#l-dica").textContent = modoLogin === "entrar" ? "Entre com seu e-mail e senha do Caça Achados." : "Crie sua senha (mínimo 8 caracteres). Depois confirme pelo link que chega no seu e-mail.";
  $("#l-senha").autocomplete = modoLogin === "entrar" ? "current-password" : "new-password";
  $("#l-erro").textContent = ""; $("#l-ok").hidden = true;
};
$("#f-login").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const email = $("#l-email").value.trim(), senha = $("#l-senha").value;
  $("#l-erro").textContent=""; $("#l-ok").hidden = true;
  if(!email || senha.length < 8){ $("#l-erro").textContent = "Informe o e-mail e uma senha de pelo menos 8 caracteres."; return; }
  $("#l-btn").disabled=true;
  if(modoLogin === "entrar"){
    const { error } = await sb.auth.signInWithPassword({ email, password: senha });
    if(error) $("#l-erro").textContent = /invalid/i.test(error.message) ? "E-mail ou senha incorretos." : /confirm/i.test(error.message) ? "Confirme o e-mail pelo link que enviamos antes de entrar." : error.message;
  } else {
    const { data, error } = await sb.auth.signUp({ email, password: senha, options: { emailRedirectTo: location.origin + location.pathname } });
    if(error) $("#l-erro").textContent = error.message;
    else if(!data.session){ $("#l-ok").hidden = false; $("#l-ok").textContent = "Conta criada. Abra o link de confirmação que chegou no seu e-mail e depois entre aqui."; }
  }
  $("#l-btn").disabled=false;
});
$("#btn-sair").onclick = () => sb.auth.signOut();

async function entrar(session){
  $("#v-login").hidden = !!session; $("#v-app").hidden = !session;
  if(!session){ ofertas=[]; return; }
  const { data: eu } = await sb.rpc("achados_eu");
  if(!eu){ $("#v-app").hidden = true; $("#v-login").hidden = false; $("#l-erro").textContent = "Este e-mail não tem acesso ao Caça Achados."; await sb.auth.signOut(); return; }
  let aba = "fila"; try{ aba = localStorage.getItem("ca-aba") || "fila"; }catch{}
  // Volta da autorização do Mercado Livre
  const h = location.hash;
  if(/^#ml-/.test(h)){
    aba = "ajustes";
    toast({ "#ml-ok":"Mercado Livre conectado! Escolha as categorias e o desconto mínimo.", "#ml-expirou":"A autorização demorou demais. Toque em Conectar de novo.", "#ml-recusado":"A autorização foi recusada no Mercado Livre.", "#ml-erro":"Não consegui concluir a conexão. Veja a mensagem na tela." }[h] || "");
    history.replaceState(null, "", location.pathname);
  }
  mostrar(aba);
  await carregarOfertas(); ouvir();
}
let ultimoUsuario = undefined;
sb.auth.onAuthStateChange((_ev, session) => {
  const u = session?.user?.id || null;
  if (u === ultimoUsuario) return; // renovação de token: nada muda na tela
  ultimoUsuario = u;
  setTimeout(() => entrar(session), 0); // fora do callback, como pede o supabase-js
});
