// Atualizador do robô. Roda antes do robo.js (pelo INICIAR-LOG.bat).
// Pergunta ao servidor se há versão nova, confere a integridade (SHA-256), testa a sintaxe e guarda a versão anterior.
// Só aceita os arquivos da lista abaixo (nunca .bat, .vbs ou .ps1).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PERMITIDOS = new Set(["robo.js", "package.json"]);
const log = (...a) => console.log(new Date().toLocaleString("pt-BR"), "· atualizador:", ...a);
const cfg = Object.fromEntries(fs.readFileSync(path.join(AQUI, "config.env"), "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const arqVersao = path.join(AQUI, "versao.txt");
const atual = (() => { try { return Number(fs.readFileSync(arqVersao, "utf8")) || 0; } catch { return 0; } })();

async function main() {
  const r = await fetch(cfg.URL, { method: "POST", headers: { "Content-Type": "application/json", "x-zap-key": cfg.CHAVE }, body: JSON.stringify({ acao: "atualizacao", versao: atual }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || `erro ${r.status}`);
  if (j.atual) return log(`já está na versão ${atual}.`);
  log(`atualizando da versão ${atual} para a ${j.versao}…`);

  const novos = [];
  for (const a of j.arquivos || []) {
    if (!PERMITIDOS.has(a.nome)) throw new Error(`arquivo não permitido: ${a.nome}`);
    const hash = crypto.createHash("sha256").update(a.conteudo, "utf8").digest("hex");
    if (hash !== a.sha256) throw new Error(`conferência falhou em ${a.nome}`);
    novos.push(a);
  }
  const voltar = () => { for (const a of novos) { const bak = path.join(AQUI, a.nome + ".bak"); if (fs.existsSync(bak)) fs.copyFileSync(bak, path.join(AQUI, a.nome)); } };
  for (const a of novos) {
    const alvo = path.join(AQUI, a.nome);
    if (fs.existsSync(alvo)) fs.copyFileSync(alvo, alvo + ".bak");
    fs.writeFileSync(alvo, a.conteudo, "utf8");
  }
  const pkg = novos.find((a) => a.nome === "package.json");
  if (pkg) {
    const n = spawnSync("npm install", { cwd: AQUI, shell: true, timeout: 5 * 60 * 1000, encoding: "utf8" });
    if (n.status !== 0) { voltar(); throw new Error("npm install falhou; voltei à versão anterior."); }
  }
  const t = spawnSync(process.execPath, ["--check", path.join(AQUI, "robo.js")], { encoding: "utf8" });
  if (t.status !== 0) { voltar(); throw new Error("a versão nova tem erro de sintaxe; voltei à anterior. " + (t.stderr || "").slice(0, 200)); }
  fs.writeFileSync(arqVersao, String(j.versao));
  log(`pronto, agora na versão ${j.versao}.`);
}
main().catch((e) => log("não atualizei:", e.message));
