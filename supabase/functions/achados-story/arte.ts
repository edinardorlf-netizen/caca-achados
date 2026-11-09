// Arte do Story (1080×1920) do Caça Achados: satori (layout → SVG) + resvg (SVG → pixels) + jpeg-js (→ JPEG).
// O Instagram só aceita JPEG na publicação por API.
import satori from "npm:satori@0.12.2";
import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import jpeg from "npm:jpeg-js@0.4.4";

export type Oferta = {
  titulo: string; marketplace: string; preco_de: number | null; preco_por: number | null;
  cupom?: string | null; imagem?: string | null; num?: number | null;
};
export type Recursos = { fontes: { w500: ArrayBuffer; w700: ArrayBuffer; w900: ArrayBuffer }; wasm: ArrayBuffer | Response };
export type Modo = "bio" | "link";

const LOJA: Record<string, [string, string]> = {
  shopee: ["Shopee", "#EE4D2D"], meli: ["Mercado Livre", "#FFE600"], amazon: ["Amazon", "#FF9900"],
  tiktok: ["TikTok Shop", "#FE2C55"], outro: ["Achado", "#FFFFFF"],
};
const PRETO = "#16140F", AMARELO = "#FFC81E", CINZA = "#CFC9BB";

const brl = (v: number | null | undefined) => v == null ? "" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const descontoDe = (o: Oferta) => o.preco_de && o.preco_por && Number(o.preco_de) > Number(o.preco_por)
  ? Math.round((1 - Number(o.preco_por) / Number(o.preco_de)) * 100) : null;

// Elemento no formato que o satori entende (sem JSX)
// deno-lint-ignore no-explicit-any
type El = { type: string; props: Record<string, any> };
// deno-lint-ignore no-explicit-any
const h = (type: string, style: Record<string, any>, ...filhos: (El | string | null | false)[]): El =>
  ({ type, props: { style: { display: "flex", ...style }, children: filhos.filter((f) => f !== null && f !== false) } });
const img = (src: string, style: Record<string, unknown>): El => ({ type: "img", props: { src, style } });

let wasmPronto = false;

export async function gerarArte(o: Oferta, foto: string | null, modo: Modo, r: Recursos): Promise<Uint8Array> {
  if (!wasmPronto) { await initWasm(r.wasm); wasmPronto = true; }
  const d = descontoDe(o);
  const [lojaNome, lojaCor] = LOJA[o.marketplace] || LOJA.outro;
  const titulo = String(o.titulo || "").replace(/\s+/g, " ").trim();
  const tituloCurto = titulo.length > 62 ? titulo.slice(0, 60).replace(/\s+\S*$/, "") + "…" : titulo;
  const codigo = o.num ? `#${o.num}` : "";

  const arvore = h("div", { width: 1080, height: 1920, background: PRETO, flexDirection: "column", alignItems: "center", fontFamily: "Archivo", color: "#fff", padding: "250px 72px 250px" },
    // Topo: marca + loja
    h("div", { width: "100%", justifyContent: "space-between", alignItems: "center" },
      h("div", { flexDirection: "column" },
        h("div", { fontSize: 30, fontWeight: 900, color: AMARELO, letterSpacing: 2 }, "O CARA DOS ACHADOS"),
        h("div", { fontSize: 64, fontWeight: 900, lineHeight: 1, marginTop: 6 }, d && d >= 40 ? "ACHADÃO!" : "ACHADO DO DIA"),
      ),
      h("div", { background: lojaCor, color: lojaCor === "#FFE600" || lojaCor === "#FFFFFF" || lojaCor === "#FF9900" ? PRETO : "#fff", fontSize: 30, fontWeight: 700, padding: "14px 26px", borderRadius: 999 }, lojaNome),
    ),
    // Foto do produto
    h("div", { width: 936, height: 640, marginTop: 40, background: "#fff", borderRadius: 40, alignItems: "center", justifyContent: "center", position: "relative" },
      foto ? img(foto, { width: 580, height: 580, objectFit: "contain" }) : h("div", { fontSize: 60, fontWeight: 900, color: "#999" }, lojaNome),
      d ? h("div", { position: "absolute", top: 32, left: 32, background: AMARELO, color: PRETO, fontSize: 64, fontWeight: 900, padding: "12px 26px", borderRadius: 24 }, `-${d}%`) : null,
    ),
    // Título
    h("div", { width: "100%", marginTop: 36, fontSize: 44, fontWeight: 700, lineHeight: 1.18, maxHeight: 108, overflow: "hidden" }, tituloCurto),
    // Preços
    h("div", { width: "100%", marginTop: 18, alignItems: "flex-end", flexWrap: "wrap" },
      o.preco_de && d ? h("div", { fontSize: 40, fontWeight: 500, color: CINZA, textDecoration: "line-through", marginRight: 24, marginBottom: 14 }, brl(o.preco_de)) : null,
      h("div", { fontSize: 112, fontWeight: 900, color: AMARELO, lineHeight: 1 }, brl(o.preco_por)),
    ),
    o.cupom ? h("div", { width: "100%", marginTop: 22, fontSize: 38, fontWeight: 700, color: "#7EE2A0" }, `Cupom: ${o.cupom}`) : null,
    // Rodapé: chamada
    h("div", { flexGrow: 1 }),
    modo === "link"
      ? h("div", { width: "100%", height: 170, border: `4px dashed ${AMARELO}`, borderRadius: 32, alignItems: "center", justifyContent: "center", fontSize: 40, fontWeight: 700, color: AMARELO }, "TOQUE NO LINK AQUI")
      : h("div", { width: "100%", background: AMARELO, color: PRETO, borderRadius: 32, padding: "28px 40px", flexDirection: "column", alignItems: "center" },
        h("div", { fontSize: 58, fontWeight: 900, lineHeight: 1 }, "LINK NA BIO"),
        codigo ? h("div", { fontSize: 36, fontWeight: 700, marginTop: 12 }, `Procure o achado ${codigo} na vitrine`) : null,
      ),
    h("div", { marginTop: 18, fontSize: 24, fontWeight: 500, color: "#8F897C" }, "Link de afiliado · preço e estoque podem mudar"),
  );

  const svg = await satori(arvore as unknown as Parameters<typeof satori>[0], {
    width: 1080, height: 1920,
    fonts: [
      { name: "Archivo", data: r.fontes.w500, weight: 500, style: "normal" },
      { name: "Archivo", data: r.fontes.w700, weight: 700, style: "normal" },
      { name: "Archivo", data: r.fontes.w900, weight: 900, style: "normal" },
    ],
  });
  const px = new Resvg(svg, { fitTo: { mode: "width", value: 1080 } }).render();
  const out = jpeg.encode({ data: px.pixels, width: px.width, height: px.height }, 88);
  px.free?.();
  return new Uint8Array(out.data);
}

// Baixa a foto do produto e devolve como data URI (o satori não lê WebP: pedimos JPG às lojas).
export async function fotoDataUri(url: string | null | undefined): Promise<string | null> {
  if (!url || !/^https:\/\//i.test(url)) return null;
  try {
    const u = url.replace(/\.webp(\?|$)/i, ".jpg$1");
    const r = await fetch(u, { headers: { Accept: "image/jpeg,image/png" } });
    if (!r.ok) return null;
    const tipo = (r.headers.get("content-type") || "").split(";")[0];
    if (!/image\/(jpeg|png)/.test(tipo)) return null;
    const b = new Uint8Array(await r.arrayBuffer());
    let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return `data:${tipo};base64,${btoa(s)}`;
  } catch { return null; }
}
