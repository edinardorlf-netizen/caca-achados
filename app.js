/* Caça Achados · um sistema Auraxis
   Fila de promoções de afiliado com posts prontos. Dados no Supabase (só o dono vê). */
const CFG = window.ACHADOS_CONFIG;
const sb = supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true } });
const FN = `${CFG.url}/functions/v1/achados-ml`, FN_SHP = `${CFG.url}/functions/v1/achados-shopee`, FN_ST = `${CFG.url}/functions/v1/achados-story`, FN_EST = `${CFG.url}/functions/v1/achados-estudio`, FN_LINK = `${CFG.url}/functions/v1/achados-link`;

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
let igPronto = false, stAtual = null;
let ofertas = [], selId = null, canal = "whatsapp", filtroMkt = "todas", editId = null, canalRT = null, cfgML = null, catsML = null, tgPronto = false, amzTag = null;
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
// Amazon: coloca a tag de associado e limpa o link (amazon.com.br/dp/ASIN?tag=…). Links amzn.to já vêm com a tag.
function afiliar(url){
  if(!url || !amzTag || mktDe(url)!=="amazon") return url;
  try{
    const u = new URL(url);
    if(!/(^|\.)amazon\.com\.br$/i.test(u.hostname)) return url;
    const asin = (u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})/i)||[])[1];
    if(asin) return `https://www.amazon.com.br/dp/${asin.toUpperCase()}?tag=${encodeURIComponent(amzTag)}`;
    u.searchParams.set("tag", amzTag); return u.toString();
  }catch{ return url; }
}
const errMsg = (e) => (e && (e.message || e.error_description || e.erro)) || String(e);

// Banco ↔ tela
const daLinha = (r) => ({ id:r.id, titulo:r.titulo, marketplace:r.marketplace, categoria:r.categoria, link:r.link, linkProduto:r.link_produto,
  precoDe: r.preco_de!=null?Number(r.preco_de):null, precoPor: r.preco_por!=null?Number(r.preco_por):null, cupom:r.cupom, comissao: r.comissao!=null?Number(r.comissao):null,
  validade:r.validade, imagem:r.imagem, nota:r.nota, status:r.status, canais:r.canais||[], exemplo:r.exemplo, fonte:r.fonte, linkAuto:r.link_auto, mlPosicao:r.ml_posicao, criadoEm:r.criado_em, postadoEm:r.postado_em, num:r.num, storyEm:r.story_em, igPostadoEm:r.ig_postado_em, waEm:r.wa_avisado_em });
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
  return {titulo, link:afiliar(url), marketplace:mktDe(url), precoDe:de, precoPor:por, cupom};
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
      aviso ? (o.marketplace==="amazon" ? "🔗 Como associado da Amazon, eu ganho com compras qualificadas." : "🔗 Link de afiliado: posso ganhar comissão, sem custo extra para você.") : null,
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
        <div class="o-meta">${o.num?`<span class="tag">#${o.num}</span>`:""}<span class="tag mk">${m.nome}</span>${o.storyEm||o.igPostadoEm?'<span class="tag ok">Story</span>':""}${o.fonte==="ml"?`<span class="tag">Mais vendido${o.mlPosicao?` #${o.mlPosicao}`:""}</span>`:""}${o.exemplo?'<span class="tag ex">Exemplo</span>':""}${o.cupom?`<span class="tag">Cupom ${esc(o.cupom)}</span>`:""}${o.comissao?`<span class="tag ok">${String(o.comissao).replace(".",",")}% comissão</span>`:""}${vencida(o)?'<span class="tag warn">Vencida</span>':o.validade?`<span class="tag">até ${new Date(o.validade+"T12:00").toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})}</span>`:""}${!o.link?'<span class="tag warn">Sem link de afiliado</span>':o.linkAuto?'<span class="tag ok">Link montado</span>':""}${o.status==="aprovada"?'<span class="tag ok">Aprovada</span>':""}</div>
        <div class="score">Nota ${score(o)}${o.categoria?` · ${esc(o.categoria)}`:""}</div></div>
      <div class="preco">${o.precoDe&&d?`<s>${brl(o.precoDe)}</s>`:""}<strong>${brl(o.precoPor)||"—"}</strong>${d?`<span class="off">-${d}%</span>`:""}</div>
    </div>`; }).join("");
  renderGerador(); renderPostadas(); renderFaixaWA();
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
  $("#btn-story").disabled = !o.link; $("#btn-story").title = o.link ? "" : "Salve o link de afiliado primeiro";
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

// ---------- Próxima para o WhatsApp (botão direto no app) ----------
let waCfg = { min: 30 }, waPulados = new Set();
const textoWA = (o) => { const ant = $("#aviso-afiliado").checked; $("#aviso-afiliado").checked = false; const t = gerarPost(o, "whatsapp"); $("#aviso-afiliado").checked = ant; return t; };
function filaWA(){
  return ofertas.filter(o => o.link && !o.exemplo && !vencida(o) && ["nova","aprovada","postada"].includes(o.status) && !o.waEm && !(o.canais||[]).includes("whatsapp") && (desc(o)||0) >= waCfg.min && !waPulados.has(o.id))
    .sort((a,b)=> (b.status==="aprovada")-(a.status==="aprovada") || score(b)-score(a));
}
function renderFaixaWA(){
  const fila = filaWA(), o = fila[0];
  $("#wa-faixa").hidden = !o; if(!o) return;
  const d = desc(o), m = MKT[o.marketplace]||MKT.outro;
  $("#wa-thumb").innerHTML = o.imagem ? `<img src="${esc(o.imagem)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : `<b>${m.nome}</b>`;
  $("#wa-tit").textContent = `#${o.num||""} ${o.titulo}`;
  $("#wa-preco").innerHTML = `${o.precoDe&&d?`<s>${brl(o.precoDe)}</s> `:""}<strong>${brl(o.precoPor)}</strong>${d?` · ${d}% OFF`:""} · ${m.nome}`;
  $("#wa-enviar").href = "https://wa.me/?text=" + encodeURIComponent(textoWA(o));
  $("#wa-enviar").dataset.id = o.id;
  $("#wa-cont").textContent = fila.length > 1 ? `+${fila.length-1} na fila do WhatsApp` : "última da fila do WhatsApp";
}
async function marcarWA(id){
  const o = ofertas.find(x=>x.id===id); if(!o) return;
  const canais = [...new Set([...(o.canais||[]), "whatsapp"])], agora = new Date().toISOString();
  o.waEm = agora; o.canais = canais; renderFaixaWA();
  const { error } = await sb.from("achados_ofertas").update({ wa_avisado_em: agora, canais }).eq("id", id);
  if(error) toast("Não consegui anotar: "+error.message); else toast("Anotado como enviado no WhatsApp");
}
$("#wa-enviar").addEventListener("click", (e)=>{ const id = e.currentTarget.dataset.id; setTimeout(()=>marcarWA(id), 300); });
$("#wa-pular").onclick = () => { const o = filaWA()[0]; if(o){ waPulados.add(o.id); renderFaixaWA(); } };
// O botão "Abrir no WhatsApp" do gerador também anota a oferta como enviada
$("#btn-wa").addEventListener("click", ()=>{ if(selId) setTimeout(()=>marcarWA(selId), 300); });
async function carregarCfgWA(){ try{ const { data } = await sb.from("achados_config").select("wa_desconto_min").maybeSingle(); waCfg.min = data?.wa_desconto_min ?? 30; renderFaixaWA(); }catch{} }

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
  titulo:$("#f-titulo").value.trim(), marketplace:$("#f-mkt").value, categoria:$("#f-cat").value.trim(), link:afiliar($("#f-link").value.trim()),
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
  try{ await salvarOferta(selId, { link: afiliar(v), link_auto: false }); $("#fl-link").value=""; toast("Link de afiliado salvo"); }catch(err){ toast("Não consegui salvar: "+errMsg(err)); }
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


// ---------- Story do Instagram ----------
const dataHora = (d) => new Date(d).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
function renderInstagram(t){
  igPronto = !!(t.tem_token && t.usuario);
  $("#ig-status").innerHTML = igPronto ? `<span class="ponto ${cfgML.ig_ativo?"on":""}"></span> Conectado a <b>@${esc(t.usuario)}</b> · automático ${cfgML.ig_ativo?"<b>ligado</b>":"desligado"}${cfgML.ig_ultimo_post?` · último Story ${dataHora(cfgML.ig_ultimo_post)}`:""}${t.token_exp?` · token renova sozinho (vence ${new Date(t.token_exp).toLocaleDateString("pt-BR")})`:""}`
    : t.tem_token ? `<span class="ponto"></span> Token salvo, mas ainda não testado.` : `<span class="ponto"></span> Ainda não conectado. Enquanto isso, use o botão “Story do Instagram” em cada oferta para postar à mão.`;
  $("#ig-int").value = cfgML.ig_intervalo_min ?? 120; $("#ig-ini").value = cfgML.ig_hora_ini ?? 9; $("#ig-fim").value = cfgML.ig_hora_fim ?? 21;
  $("#ig-min").value = cfgML.ig_desconto_min ?? 30; $("#ig-ativo").checked = !!cfgML.ig_ativo;
  $("#ig-msg").textContent = cfgML.ig_msg || "";
}
function renderAlerta(){
  $("#al-status").innerHTML = cfgML.alerta_chat_id ? `<span class="ponto ${cfgML.alerta_ativo?"on":""}"></span> Conversa vinculada · avisos ${cfgML.alerta_ativo?"<b>ligados</b>":"desligados"} a partir de ${cfgML.alerta_min ?? 40}% OFF` : `<span class="ponto"></span> Ainda não vinculado.`;
  $("#al-min").value = cfgML.alerta_min ?? 40; $("#al-ativo").checked = cfgML.alerta_ativo !== false;
  $("#al-msg").textContent = cfgML.alerta_msg || "";
}
const souDono = async () => { const { data:{ user } } = await sb.auth.getUser(); return (user?.email||"").toLowerCase(); };
const limitar = (v,a,b,d) => { const n = Number(v); return isFinite(n) && v!=="" ? Math.max(a, Math.min(b, Math.round(n))) : d; };
$("#f-ig").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const tok = $("#ig-token").value.trim();
  $("#ig-salvar").disabled=true; $("#ig-msg").textContent="Salvando…";
  if(tok){ const { error } = await sb.rpc("achados_salvar_ig", { p_token: tok }); if(error){ $("#ig-msg").textContent = error.message; $("#ig-salvar").disabled=false; return; } }
  $("#ig-token").value="";
  try{ const r = await chamarML("ig_testar", {}, FN_ST); toast(`Instagram conectado: @${r.usuario}`); }
  catch(err){ $("#ig-msg").textContent = errMsg(err); }
  $("#ig-salvar").disabled=false; await carregarML();
});
$("#ig-salvar-agenda").onclick = async () => {
  const patch = { ig_intervalo_min: limitar($("#ig-int").value,30,1440,120), ig_hora_ini: limitar($("#ig-ini").value,0,23,9), ig_hora_fim: limitar($("#ig-fim").value,1,24,21),
    ig_desconto_min: limitar($("#ig-min").value,0,95,30), ig_ativo: $("#ig-ativo").checked };
  if(patch.ig_ativo && !igPronto) return toast("Conecte o Instagram (Salvar e testar) antes de ligar o automático.");
  if(patch.ig_hora_fim <= patch.ig_hora_ini) return toast("A hora final precisa ser depois da inicial.");
  const { error } = await sb.from("achados_config").update(patch).eq("dono", await souDono());
  if(error) return toast("Não consegui salvar: "+error.message);
  toast(patch.ig_ativo ? `Story automático ligado: 1 a cada ${patch.ig_intervalo_min} min, das ${patch.ig_hora_ini}h às ${patch.ig_hora_fim}h` : "Agenda salva (automático desligado)");
  carregarML();
};
function renderWhatsApp(){
  const n = cfgML.wa_qtd ?? 1, cada = cfgML.wa_intervalo_min ?? 60, ini = cfgML.wa_hora_ini ?? 6, fim = cfgML.wa_hora_fim ?? 22;
  $("#wa-status").innerHTML = `<span class="ponto ${cfgML.zap_ativo?"on":""}"></span> ${cfgML.zap_ativo?`<b>Robô ligado</b>: ${n} oferta${n>1?"s":""} a cada ${cada} min, das ${ini}h às ${fim}h (precisa do programa aberto no computador)`:"Robô desligado"}`;
  $("#wa-int").value = cada; $("#wa-n").value = n; $("#wa-ini").value = ini; $("#wa-fim").value = fim; $("#wa-min").value = cfgML.wa_desconto_min ?? 30; $("#wa-ativo").checked = !!cfgML.zap_ativo;
  $("#wa-msg").textContent = cfgML.wa_msg || "";
}
$("#wa-salvar").onclick = async () => {
  const patch = { wa_intervalo_min: limitar($("#wa-int").value,10,1440,60), wa_qtd: limitar($("#wa-n").value,1,30,1), wa_hora_ini: limitar($("#wa-ini").value,0,23,6), wa_hora_fim: limitar($("#wa-fim").value,1,24,22),
    wa_desconto_min: limitar($("#wa-min").value,0,95,30), zap_ativo: $("#wa-ativo").checked, wa_ativo: false };
  if(patch.wa_hora_fim <= patch.wa_hora_ini) return toast("A hora final precisa ser depois da inicial.");
  const { error } = await sb.from("achados_config").update(patch).eq("dono", await souDono());
  if(error) return toast("Não consegui salvar: "+error.message);
  toast(patch.zap_ativo ? `Robô do WhatsApp: ${patch.wa_qtd} oferta(s) a cada ${patch.wa_intervalo_min} min, das ${patch.wa_hora_ini}h às ${patch.wa_hora_fim}h` : "Robô do WhatsApp desligado"); carregarML();
};
$("#wa-agora").onclick = async () => {
  const b=$("#wa-agora"); b.disabled=true; $("#wa-msg").textContent="Mandando…";
  try{ const r = await chamarML("wa_agora", {}, FN_ST); $("#wa-msg").textContent = `Mandei o achado #${r.num} no seu Telegram.`; await carregarOfertas(); }
  catch(err){ $("#wa-msg").textContent = errMsg(err); }
  b.disabled=false;
};
$("#al-vincular").onclick = async () => {
  const b=$("#al-vincular"); b.disabled=true; $("#al-msg").textContent="Procurando a sua conversa com o bot…";
  try{ const r = await chamarML("alerta_vincular", {}, FN_ST); toast(`Vinculado${r.nome?`: ${r.nome}`:""}. Confira a mensagem do bot no Telegram.`); }
  catch(err){ $("#al-msg").textContent = errMsg(err); }
  b.disabled=false; await carregarML();
};
$("#al-testar").onclick = async () => {
  const b=$("#al-testar"); b.disabled=true; $("#al-msg").textContent="Gerando a arte e mandando…";
  try{ const r = await chamarML("alerta_testar", {}, FN_ST); $("#al-msg").textContent = `Aviso de teste enviado (achado #${r.num}). Confira no Telegram.`; }
  catch(err){ $("#al-msg").textContent = errMsg(err); }
  b.disabled=false;
};
$("#al-salvar").onclick = async () => {
  const patch = { alerta_min: limitar($("#al-min").value,10,95,40), alerta_ativo: $("#al-ativo").checked };
  const { error } = await sb.from("achados_config").update(patch).eq("dono", await souDono());
  if(error) return toast("Não consegui salvar: "+error.message);
  toast(patch.alerta_ativo ? `Avisos ligados a partir de ${patch.alerta_min}% OFF` : "Avisos desligados"); carregarML();
};

// Janela do Story: gera as artes no servidor e deixa baixar / compartilhar / publicar
async function prepararDownload(a, url, nome){
  a.removeAttribute("href"); a.setAttribute("aria-disabled","true");
  try{
    const blob = await (await fetch(url)).blob();
    const arq = new File([blob], nome, { type: "image/jpeg" });
    a.href = URL.createObjectURL(blob); a.download = nome; a.removeAttribute("aria-disabled");
    return arq;
  }catch{ a.href = url; a.target = "_blank"; a.removeAttribute("aria-disabled"); return null; }
}
async function abrirStory(){
  const o = ofertas.find(x=>x.id===selId); if(!o) return;
  if(!o.link) return toast("Salve o link de afiliado antes de fazer o Story.");
  const d=$("#story"); d.showModal ? d.showModal() : d.setAttribute("open","");
  $("#st-tit").textContent = `Story · achado #${o.num||""}`; $("#st-msg").textContent = "Gerando as artes… (a primeira vez leva alguns segundos)";
  $("#st-img-link").removeAttribute("src"); $("#st-img-bio").removeAttribute("src"); $("#st-cod").textContent = "";
  $("#st-ig-postar").hidden = !igPronto; $("#st-compartilhar")?.remove();
  let r;
  try{ r = await chamarML("gerar", { id: o.id }, FN_ST); }
  catch(err){ $("#st-msg").textContent = errMsg(err); return; }
  stAtual = { id: o.id, ...r };
  sb.from("achados_ofertas").update({ story_gerado_em: new Date().toISOString() }).eq("id", o.id).then(()=>{}); // entra na Vitrine pelo código
  $("#st-img-link").src = r.arte_link; $("#st-img-bio").src = r.arte_bio;
  $("#st-cod").textContent = `Na Vitrine, o código #${r.num} leva direto a este achado.`;
  $("#st-msg").textContent = o.storyEm || o.igPostadoEm ? `Este achado já foi para o Story${o.igPostadoEm?` (automático em ${dataHora(o.igPostadoEm)})`:""}${o.storyEm?` (à mão em ${dataHora(o.storyEm)})`:""}.` : "Pronto! Escolha a arte.";
  const arqLink = await prepararDownload($("#st-baixar-link"), r.arte_link, `achado-${r.num}-story.jpg`);
  await prepararDownload($("#st-baixar-bio"), r.arte_bio, `achado-${r.num}-story-bio.jpg`);
  // No celular: compartilhar direto para o Instagram (o link vai junto no texto para você copiar)
  if(arqLink && navigator.canShare && navigator.canShare({ files: [arqLink] })){
    const b = document.createElement("button"); b.className = "btn sm"; b.type = "button"; b.id = "st-compartilhar"; b.textContent = "Compartilhar no Instagram";
    b.onclick = async () => { try{ await navigator.clipboard.writeText(r.link); toast("Link copiado: cole na figurinha de link"); }catch{} try{ await navigator.share({ files: [arqLink] }); }catch{} };
    $("#st-baixar-link").after(b);
  }
}
$("#btn-story").onclick = abrirStory;
$("#st-fechar").onclick = () => $("#story").close?.();
$("#st-copiar").onclick = async () => {
  if(!stAtual) return;
  try{ await navigator.clipboard.writeText(stAtual.link); toast("Link de afiliado copiado: cole na figurinha de link"); }
  catch{ prompt("Copie o link:", stAtual.link); }
};
$("#st-postei").onclick = async () => {
  if(!stAtual) return;
  try{ await chamarML("story_postado", { id: stAtual.id }, FN_ST); toast("Anotado: Story postado"); $("#story").close?.(); await carregarOfertas(); }
  catch(err){ toast(errMsg(err)); }
};
$("#st-ig-postar").onclick = async () => {
  if(!stAtual) return;
  const b=$("#st-ig-postar"); b.disabled=true; b.textContent="Publicando…";
  try{ await chamarML("ig_postar", { id: stAtual.id }, FN_ST); toast("Story publicado no Instagram"); $("#story").close?.(); await carregarOfertas(); }
  catch(err){ $("#st-msg").textContent = errMsg(err); }
  b.disabled=false; b.textContent="Publicar agora no Instagram";
};

// ---------- Mercado Livre ----------
async function chamarML(acao, extra={}, url=FN){
  const { data:{ session } } = await sb.auth.getSession();
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${session?.access_token||""}`, apikey: CFG.key }, body: JSON.stringify({ acao, ...extra }) });
  const j = await r.json().catch(()=>({}));
  if(!r.ok || j.erro) throw new Error(j.erro || `Erro ${r.status}`);
  return j;
}
async function carregarML(){
  const [st, cf, ts, ss, is] = await Promise.all([ sb.rpc("achados_ml_status"),
    sb.from("achados_config").select("ml_client_id,ml_categorias,ml_categorias_nomes,desconto_min,ml_afiliado_query,ml_afiliado_em,tg_ativo,tg_intervalo_min,tg_qtd,tg_hora_ini,tg_hora_fim,tg_modo,tg_desconto_min,tg_ultimo_post,tg_msg,ig_ativo,ig_intervalo_min,ig_hora_ini,ig_hora_fim,ig_desconto_min,ig_ultimo_post,ig_msg,ig_usuario,alerta_ativo,alerta_min,alerta_chat_id,alerta_msg,wa_ativo,zap_ativo,wa_intervalo_min,wa_qtd,wa_hora_ini,wa_hora_fim,wa_desconto_min,wa_ultimo_aviso,wa_msg,shp_app_id,shp_ativo,shp_palavras,shp_top,shp_desconto_min,shp_comissao_min,shp_sinc_em,shp_sinc_ok,shp_sinc_msg,amz_tag,vit_slug,vit_telegram,vit_whatsapp,vit_instagram,vit_tiktok").maybeSingle(),
    sb.rpc("achados_tg_status"), sb.rpc("achados_shp_status"), sb.rpc("achados_ig_status") ]);
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
  renderAfiliado(); renderTelegram((ts.data||[])[0] || {}); renderShopee((ss.data||[])[0] || {}); renderInstagram((is.data||[])[0] || {}); renderAlerta(); renderWhatsApp();
  amzTag = cfgML.amz_tag || null; $("#amz-tag").value = amzTag || "";
  const vurl = new URL("vitrine.html", location.href); if(cfgML.vit_slug && cfgML.vit_slug!=="ocaradosachados") vurl.searchParams.set("c", cfgML.vit_slug);
  $("#vit-url").value = vurl.toString(); $("#vit-abrir").href = vurl.toString();
  ["telegram","whatsapp","instagram","tiktok"].forEach(k=> $("#vit-"+k).value = cfgML["vit_"+k] || "");
  $("#amz-status").innerHTML = amzTag ? `<span class="ponto on"></span> Tag <b>${esc(amzTag)}</b> ativa nos links da Amazon.` : `<span class="ponto"></span> Sem tag: os links da Amazon ficam como você colar.`;
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
  $("#tg-int").value = cfgML.tg_intervalo_min ?? 60; $("#tg-qtd").value = cfgML.tg_qtd ?? 1; $("#tg-ini").value = cfgML.tg_hora_ini ?? 8; $("#tg-fim").value = cfgML.tg_hora_fim ?? 22;
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
$("#vit-copiar").onclick = async () => { try{ await navigator.clipboard.writeText($("#vit-url").value); toast("Link da Vitrine copiado"); }catch{ $("#vit-url").select(); toast("Selecionei o link: use Copiar do seu aparelho"); } };
$("#vit-salvar").onclick = async () => {
  const regras = { telegram:/^https:\/\/(t\.me|telegram\.me)\//i, whatsapp:/^https:\/\/(whatsapp\.com|chat\.whatsapp\.com|wa\.me)\//i, instagram:/^https:\/\/(www\.)?instagram\.com\//i, tiktok:/^https:\/\/(www\.)?tiktok\.com\//i };
  const nomes = { telegram:"Telegram", whatsapp:"WhatsApp", instagram:"Instagram", tiktok:"TikTok" };
  const patch = {};
  for(const k of Object.keys(regras)){
    let v = $("#vit-"+k).value.trim();
    if(v && !/^https?:\/\//i.test(v)) v = "https://" + v.replace(/^\/+/, "");
    v = v.replace(/^http:/i, "https:");
    if(v && !regras[k].test(v)) return toast(`O link do ${nomes[k]} não parece certo (ex.: ${$("#vit-"+k).placeholder}).`);
    patch["vit_"+k] = v || null;
  }
  const { data:{ user } } = await sb.auth.getUser();
  const { error } = await sb.from("achados_config").update(patch).eq("dono", (user?.email||"").toLowerCase());
  if(error) return toast("Não consegui salvar: "+error.message);
  toast("Canais salvos na Vitrine"); carregarML();
};
$("#amz-salvar").onclick = async () => {
  const t = $("#amz-tag").value.trim();
  if(t && !/^[A-Za-z0-9_-]{3,40}-2\d$/.test(t)) return toast("A tag da Amazon termina em -20 (ex.: ocaradosachados-20).");
  const { data:{ user } } = await sb.auth.getUser();
  const { error } = await sb.from("achados_config").update({ amz_tag: t || null }).eq("dono", (user?.email||"").toLowerCase());
  if(error) return toast("Não consegui salvar: "+error.message);
  toast(t ? "Tag da Amazon salva" : "Tag removida"); carregarML();
};
$("#tg-salvar-agenda").onclick = async () => {
  const lim = (v,a,b,d) => { const n = Number(v); return isFinite(n) && v!=="" ? Math.max(a, Math.min(b, Math.round(n))) : d; };
  const patch = { tg_intervalo_min: lim($("#tg-int").value,10,1440,60), tg_qtd: lim($("#tg-qtd").value,1,30,1), tg_hora_ini: lim($("#tg-ini").value,0,23,8), tg_hora_fim: lim($("#tg-fim").value,1,24,22),
    tg_desconto_min: lim($("#tg-min").value,0,95,30), tg_modo: $("#tg-modo").value, tg_ativo: $("#tg-ativo").checked };
  if(patch.tg_ativo && !tgPronto) return toast("Salve o bot e o canal antes de ligar o automático.");
  if(patch.tg_hora_fim <= patch.tg_hora_ini) return toast("A hora final precisa ser depois da inicial.");
  const { data:{ user } } = await sb.auth.getUser();
  const { error } = await sb.from("achados_config").update(patch).eq("dono", (user?.email||"").toLowerCase());
  if(error) return toast("Não consegui salvar: "+error.message);
  toast(patch.tg_ativo ? `Automático ligado: ${patch.tg_qtd} oferta(s) a cada ${patch.tg_intervalo_min} min, das ${patch.tg_hora_ini}h às ${patch.tg_hora_fim}h` : "Agenda salva (automático desligado)");
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


// ---------- Estúdio IA ----------
async function carregarEstudio(){
  try{
    const [{ data: c }, { data: ia }] = await Promise.all([ sb.from("achados_config").select("est_persona").maybeSingle(), sb.rpc("achados_ia_status") ]);
    $("#est-persona").value = c?.est_persona || "";
    $("#est-ia-status").innerHTML = ia ? `<span class="ponto on"></span> Chave da IA salva: os ganchos são escritos pelo Claude.` : `<span class="ponto"></span> Sem chave: uso modelos de gancho prontos (funciona, só é menos variado).`;
  }catch{}
  try{ const { data: c2 } = await sb.from("achados_config").select("afiliados_max").maybeSingle(); $("#est-afil-max").value = c2?.afiliados_max || ""; }catch{}
  const { data, error } = await sb.from("achados_ofertas").select("id,titulo,marketplace,preco_de,preco_por,imagem,link,est_score,est_motivos,est_texto,est_status,afiliados")
    .in("status",["nova","aprovada"]).eq("exemplo",false).not("est_score","is",null).neq("est_status","rejeitado").order("est_score",{ascending:false}).limit(24);
  if(error){ $("#est-lista").innerHTML = `<p class="hint">Não consegui carregar: ${esc(error.message)}</p>`; return; }
  if(!(data||[]).length){ $("#est-lista").innerHTML = `<p class="hint">Toque em <b>Minerar agora</b> para avaliar as ofertas.</p>`; return; }
  $("#est-lista").innerHTML = data.map(o=>{
    const d = o.preco_de && o.preco_por && o.preco_de>o.preco_por ? Math.round((1-o.preco_por/o.preco_de)*100) : null;
    const st = o.est_status==="aprovado" ? `<span class="chip" aria-pressed="true">Aprovada</span>` : "";
    return `<div class="card" data-id="${o.id}">
      <div class="row" style="justify-content:space-between"><b>Nota ${o.est_score}</b>${st}</div>
      <div>${esc(String(o.titulo).slice(0,90))}</div>
      <div class="hint">${o.preco_de&&d?`<s>${brl(o.preco_de)}</s> `:""}<b>${brl(o.preco_por)}</b>${d?` · ${d}% OFF`:""} · ${esc(MKT[o.marketplace]?.nome||o.marketplace)}</div>
      <div class="hint">${esc((o.est_motivos||[]).join(" · "))}</div>
      <label class="hint">Afiliados no produto (veja na página dele no app da Shopee, "Afiliados Promovidos"): <input class="in est-afil" type="number" min="0" inputmode="numeric" value="${o.afiliados ?? ""}" placeholder="ex.: 190" style="width:90px"></label>
      <textarea class="in est-txt" rows="2" placeholder="Toque em Escrever para gerar o gancho">${esc(o.est_texto||"")}</textarea>
      <div class="row"><button class="btn sm est-escrever" type="button">${o.est_texto?"Reescrever":"Escrever"}</button><button class="btn amarelo sm est-aprovar" type="button">Aprovar</button><button class="btn ghost sm est-rejeitar" type="button">Rejeitar</button></div>
    </div>`; }).join("");
}
$("#est-minerar").onclick = async () => {
  const b=$("#est-minerar"); b.disabled=true; $("#est-msg").textContent="Avaliando…";
  try{ const r = await chamarML("minerar", {}, FN_EST); $("#est-msg").textContent = `${r.avaliadas} ofertas avaliadas.`; await carregarEstudio(); }
  catch(err){ $("#est-msg").textContent = errMsg(err); }
  b.disabled=false;
};
$("#est-salvar").onclick = async () => {
  const chave = $("#est-chave").value.trim();
  const { error } = await sb.from("achados_config").update({ est_persona: $("#est-persona").value.trim() || null }).eq("dono", await souDono());
  if(error) return toast("Não consegui salvar: "+error.message);
  if(chave){ const { error: e2 } = await sb.rpc("achados_salvar_ia", { p_chave: chave }); if(e2) return toast("Não consegui guardar a chave: "+e2.message); $("#est-chave").value=""; }
  toast("Persona salva"); carregarEstudio();
};
$("#est-remover-chave").onclick = async () => { const { error } = await sb.rpc("achados_salvar_ia", { p_chave: "" }); if(error) return toast(error.message); toast("Chave removida"); carregarEstudio(); };
$("#est-afil-max").onchange = async () => {
  const v = parseInt($("#est-afil-max").value,10);
  const { error } = await sb.from("achados_config").update({ afiliados_max: v>0 ? v : null }).eq("dono", await souDono());
  toast(error ? "Não consegui salvar: "+error.message : (v>0 ? `Só postarei produtos com até ${v} afiliados (quando o número estiver preenchido)` : "Filtro de afiliados desligado"));
};
$("#est-lista").addEventListener("change", async (e)=>{
  const inp = e.target.closest(".est-afil"); const card = e.target.closest("[data-id]"); if(!inp || !card) return;
  try{ await chamarML("afiliados", { id: card.dataset.id, afiliados: inp.value }, FN_EST); toast("Número de afiliados salvo"); }catch(err){ toast(errMsg(err)); }
});
$("#est-lista").addEventListener("click", async (e)=>{
  const bt = e.target.closest("button"); const card = e.target.closest("[data-id]"); if(!bt || !card) return;
  const id = card.dataset.id, txt = card.querySelector(".est-txt");
  bt.disabled = true;
  try{
    if(bt.classList.contains("est-escrever")){ const r = await chamarML("escrever", { id }, FN_EST); txt.value = r.texto; if(r.aviso) toast(r.aviso); bt.textContent="Reescrever"; }
    else if(bt.classList.contains("est-aprovar")){ if(!txt.value.trim()){ toast("Escreva o gancho antes de aprovar."); } else { await chamarML("aprovar", { id, texto: txt.value }, FN_EST); toast("Aprovada: sai com este gancho nos grupos e no Telegram"); carregarEstudio(); } }
    else if(bt.classList.contains("est-rejeitar")){ await chamarML("rejeitar", { id }, FN_EST); card.remove(); }
  }catch(err){ toast(errMsg(err)); }
  bt.disabled = false;
});

// ---------- Cupons bônus ----------
const LOJA_CP = { shopee:"Shopee", meli:"Mercado Livre", amazon:"Amazon", tiktok:"TikTok Shop" };
async function carregarCupons(){
  const { data, error } = await sb.from("achados_cupons").select("*").order("criado_em",{ascending:false}).limit(100);
  if(error){ $("#cp-lista").innerHTML = `<p class="hint">Não consegui carregar: ${esc(error.message)}</p>`; return; }
  const hoje = new Date().toISOString().slice(0,10);
  $("#cp-lista").innerHTML = (data||[]).length ? data.map(c=>{
    const venc = c.validade && c.validade < hoje;
    const quando = c.wa_avisado_em ? "último envio: "+new Date(c.wa_avisado_em).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}) : "ainda não enviado";
    return `<div class="card" data-id="${c.id}">
      <div class="row" style="justify-content:space-between"><b>${esc(c.codigo)}</b><span class="hint">${esc(LOJA_CP[c.loja]||c.loja)}${venc?" · vencido":""}${!c.ativo?" · pausado":""}</span></div>
      ${c.regra?`<div>${esc(c.regra)}</div>`:""}
      <div class="hint">${c.validade?"Válido até "+c.validade.split("-").reverse().join("/")+" · ":""}${quando}</div>
      <div class="row"><button class="btn ghost sm cp-alt" type="button">${c.ativo?"Pausar":"Ativar"}</button><button class="btn ghost sm cp-ap" type="button">Apagar</button></div>
    </div>`; }).join("") : `<p class="hint">Nenhum cupom cadastrado ainda.</p>`;
}
$("#cp-gerar").onclick = async () => {
  const url = $("#cp-link").value.trim();
  if(!url){ $("#cp-msg").textContent = "Cole no campo o endereço da página do cupom (shopee.com.br)."; return; }
  if($("#cp-loja").value !== "shopee"){ $("#cp-msg").textContent = "Só a Shopee gera o link sozinha. Nas outras lojas, cole o link gerado no portal de afiliados."; return; }
  const b=$("#cp-gerar"); b.disabled=true; $("#cp-msg").textContent = "Gerando…";
  try{ const r = await chamarML("gerar", { loja:"shopee", url }, FN_LINK); $("#cp-link").value = r.link; $("#cp-msg").textContent = "Link de afiliado gerado."; }
  catch(err){ $("#cp-msg").textContent = errMsg(err); }
  b.disabled=false;
};
$("#cp-salvar").onclick = async () => {
  const codigo = $("#cp-cod").value.trim().toUpperCase();
  if(!codigo){ $("#cp-msg").textContent = "Digite o código do cupom."; return; }
  const link = $("#cp-link").value.trim();
  if(link && !/^https?:\/\//i.test(link)){ $("#cp-msg").textContent = "O link precisa começar com https://"; return; }
  let linkFinal = link;
  if(link && $("#cp-loja").value==="shopee" && /^https?:\/\/(www\.)?shopee\.com\.br/i.test(link)){
    try{ linkFinal = (await chamarML("gerar", { loja:"shopee", url:link }, FN_LINK)).link; }
    catch(err){ $("#cp-msg").textContent = "Não gerei o link de afiliado: "+errMsg(err); return; }
  }
  const { error } = await sb.from("achados_cupons").insert({ dono: await souDono(), loja: $("#cp-loja").value, codigo, regra: $("#cp-regra").value.trim()||null, validade: $("#cp-val").value||null, link: linkFinal||null });
  if(error){ $("#cp-msg").textContent = "Não consegui salvar: "+error.message; return; }
  ["#cp-cod","#cp-regra","#cp-val","#cp-link"].forEach(s=>$(s).value=""); $("#cp-msg").textContent = "Cupom salvo: sai na próxima rodada."; carregarCupons();
};
$("#cp-lista").addEventListener("click", async (e)=>{
  const bt = e.target.closest("button"); const card = e.target.closest("[data-id]"); if(!bt || !card) return;
  const id = card.dataset.id;
  if(bt.classList.contains("cp-ap")){ if(!confirm("Apagar este cupom?")) return; await sb.from("achados_cupons").delete().eq("id", id); }
  else if(bt.classList.contains("cp-alt")){ const ativo = bt.textContent.trim()==="Ativar"; await sb.from("achados_cupons").update({ ativo }).eq("id", id); }
  carregarCupons();
});

// ---------- Abas ----------
function mostrar(v){
  ["cacar","fila","cupons","estudio","postadas","ajustes"].forEach(k=>{ $("#v-"+k).hidden = k!==v; $("#tab-"+k).setAttribute("aria-selected", k===v); });
  try{ localStorage.setItem("ca-aba", v); }catch{}
  if(v==="ajustes") carregarML();
  if(v==="estudio") carregarEstudio();
  if(v==="cupons") carregarCupons();
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
  try{ const { data } = await sb.from("achados_config").select("amz_tag").maybeSingle(); amzTag = data?.amz_tag || null; }catch{}
  await carregarOfertas(); ouvir(); carregarCfgWA();
}
let ultimoUsuario = undefined;
sb.auth.onAuthStateChange((_ev, session) => {
  const u = session?.user?.id || null;
  if (u === ultimoUsuario) return; // renovação de token: nada muda na tela
  ultimoUsuario = u;
  setTimeout(() => entrar(session), 0); // fora do callback, como pede o supabase-js
});
