# =====================================================================
# Caça Achados · Robô de Stories do Instagram (com a figurinha de link)
#
# Roda no computador (desktop), ao lado do robô do WhatsApp. A cada minuto pergunta ao servidor do
# Caça Achados se é hora de uma rodada; o servidor escolhe as ofertas e já manda a arte pronta
# ("TOQUE NO LINK AQUI"). O robô posta cada Story com a figurinha de link em cima do quadro amarelo,
# com uma pausa de alguns minutos entre um e outro, e confirma no servidor.
#
# ATENÇÃO: usa a biblioteca não oficial instagrapi (imita o aplicativo do celular). O Instagram não
# permite automação fora da API oficial e pode pedir login de novo, bloquear ações por um tempo ou
# desativar a conta. O dono aceitou esse risco (21/11/2026).
#
# A senha do Instagram NÃO fica guardada: só a sessão (sessao-instagram.json), como no celular.
#
#   python robo_stories.py conectar   → entra no Instagram (pede usuário, senha e código) e guarda a sessão
#   python robo_stories.py teste      → posta 1 Story agora (a melhor oferta), para conferir
#   python robo_stories.py            → fica ligado seguindo a agenda do app (Ajustes > Instagram)
# =====================================================================
import getpass
import json
import logging
import random
import sys
import tempfile
import time
from pathlib import Path

import requests
from instagrapi import Client
from instagrapi.exceptions import (
    ChallengeRequired,
    FeedbackRequired,
    LoginRequired,
    PleaseWaitFewMinutes,
    TwoFactorRequired,
)
from instagrapi.types import StoryLink

VERSAO = 1
AQUI = Path(__file__).resolve().parent
SESSAO = AQUI / "sessao-instagram.json"
URL_PADRAO = "https://airbtbqorhrrzqhucmzu.supabase.co/functions/v1/achados-story"

# Onde fica a figurinha de link: em cima do quadro "TOQUE NO LINK AQUI" da arte (1080×1920).
# Valores em fração da tela (0 a 1). O quadro vai de y≈1453 a y≈1623 → centro em 0,80.
LINK_X, LINK_Y, LINK_LARG, LINK_ALT = 0.5, 0.80, 0.56, 0.075

# Pausa entre um Story e outro da mesma rodada (segundos) — espaçado para parecer gente.
PAUSA_ENTRE = (240, 540)
ESPERA_BLOQUEIO = 6 * 3600  # o Instagram bloqueou ações: espera 6 h antes de tentar de novo

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%d/%m %H:%M:%S")
log = logging.info
for barulho in ("instagrapi", "public_request", "private_request", "urllib3"):
    logging.getLogger(barulho).setLevel(logging.WARNING)


def ler_config():
    cfg = {}
    arq = AQUI / "config.env"
    if arq.exists():
        for linha in arq.read_text(encoding="utf-8-sig").splitlines():
            linha = linha.strip()
            if linha and not linha.startswith("#") and "=" in linha:
                k, v = linha.split("=", 1)
                cfg[k.strip()] = v.strip().strip('"')
    if not cfg.get("CHAVE"):
        sys.exit("Falta a CHAVE no config.env (é a mesma do robô do WhatsApp). Rode o INSTALAR.bat de novo.")
    cfg.setdefault("URL", URL_PADRAO)
    return cfg


CFG = ler_config()


def api(corpo):
    r = requests.post(CFG["URL"], json=corpo, headers={"x-zap-key": CFG["CHAVE"]}, timeout=180)
    try:
        j = r.json()
    except ValueError:
        j = {}
    if r.status_code >= 400 or j.get("erro"):
        raise RuntimeError(j.get("erro") or f"servidor respondeu {r.status_code}")
    return j


def avisar(msg):
    """Avisa o dono no Telegram (e no app). Nunca derruba o robô."""
    log(msg)
    try:
        api({"acao": "story_aviso", "mensagem": msg})
    except Exception as e:  # noqa: BLE001
        log(f"(não consegui mandar o aviso: {e})")


def novo_cliente():
    cl = Client()
    cl.delay_range = [2, 6]
    cl.set_locale("pt_BR")
    cl.set_country("BR")
    cl.set_country_code(55)
    cl.set_timezone_offset(-3 * 3600)
    return cl


# ---------- conectar (uma vez, ou quando o Instagram pedir) ----------
def conectar():
    print("\n=== Conectar o Instagram ao robô de Stories ===")
    print("A senha NÃO fica guardada. Fica só a sessão, como no celular.\n")
    usuario = input("Usuário do Instagram (sem @): ").strip().lstrip("@")
    senha = getpass.getpass("Senha (não aparece enquanto digita): ")
    cl = novo_cliente()
    if SESSAO.exists():  # reaproveita o "aparelho" já conhecido pelo Instagram
        try:
            antigo = json.loads(SESSAO.read_text(encoding="utf-8"))
            cl.set_settings({k: antigo[k] for k in ("uuids", "device_settings", "user_agent") if k in antigo})
        except Exception:  # noqa: BLE001
            pass
    cl.challenge_code_handler = lambda username, escolha: input(
        f"O Instagram mandou um código de segurança ({escolha}). Digite aqui: ").strip()
    try:
        cl.login(usuario, senha)
    except TwoFactorRequired:
        codigo = input("Código da verificação em duas etapas (app ou SMS): ").strip()
        cl.login(usuario, senha, verification_code=codigo)
    del senha
    eu = cl.account_info()
    cl.dump_settings(SESSAO)
    print(f"\nPronto! Conectado como @{eu.username}. Sessão guardada em {SESSAO.name}.")
    print("Agora pode fechar esta janela. O robô liga sozinho (ou use INICIAR-STORIES.bat).")
    avisar(f"conectado ao Instagram como @{eu.username}.")


def carregar():
    if not SESSAO.exists():
        return None
    cl = novo_cliente()
    cl.load_settings(SESSAO)
    try:
        cl.account_info()  # confere se a sessão ainda vale
    except (LoginRequired, ChallengeRequired):
        return None
    return cl


def esperar_conexao():
    avisar("o Instagram pediu para entrar de novo. No desktop, abra CONECTAR-INSTAGRAM.bat e faça o login. "
           "O robô fica esperando e volta sozinho.")
    antes = SESSAO.stat().st_mtime if SESSAO.exists() else 0
    while True:
        time.sleep(60)
        agora = SESSAO.stat().st_mtime if SESSAO.exists() else 0
        if agora != antes:
            cl = carregar()
            if cl:
                avisar("sessão do Instagram renovada. Voltei a postar.")
                return cl
            antes = agora


# ---------- postar ----------
def postar(cl, o):
    r = requests.get(o["arte"], timeout=60)
    r.raise_for_status()
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False, dir=AQUI) as f:
        f.write(r.content)
        caminho = Path(f.name)
    try:
        link = StoryLink(webUri=o["link"], x=LINK_X, y=LINK_Y, width=LINK_LARG, height=LINK_ALT)
        cl.photo_upload_to_story(caminho, links=[link])
    finally:
        caminho.unlink(missing_ok=True)
    cl.dump_settings(SESSAO)  # mantém os cookies em dia
    api({"acao": "story_confirmar", "id": o["id"]})


def rodada(cl, ofertas):
    """Posta as ofertas da rodada. Devolve o cliente (pode ter sido trocado depois de um login novo)."""
    for i, o in enumerate(ofertas):
        if i > 0:
            pausa = random.randint(*PAUSA_ENTRE)
            log(f"Próximo Story em {pausa // 60} min.")
            time.sleep(pausa)
        try:
            postar(cl, o)
            log(f"Story {i + 1}/{len(ofertas)} publicado: #{o.get('num')} {str(o.get('titulo'))[:60]}")
        except (LoginRequired, ChallengeRequired):
            cl = esperar_conexao()
            return cl  # as que sobraram voltam na próxima rodada
        except (FeedbackRequired, PleaseWaitFewMinutes) as e:
            avisar(f"o Instagram bloqueou as postagens por um tempo ({str(e)[:120]}). Vou esperar 6 horas.")
            time.sleep(ESPERA_BLOQUEIO)
            return cl
        except Exception as e:  # noqa: BLE001
            log(f"Story #{o.get('num')} falhou: {e}")
            try:
                api({"acao": "story_confirmar", "id": o["id"], "erro": f"#{o.get('num')}: {str(e)[:200]}"})
            except Exception:  # noqa: BLE001
                pass
    return cl


def ligado(teste=False):
    log(f"Robô de Stories versão {VERSAO}.")
    cl = carregar()
    if not cl:
        if not SESSAO.exists():
            sys.exit("Ainda não conectado. Abra CONECTAR-INSTAGRAM.bat primeiro.")
        cl = esperar_conexao()
    log("Instagram conectado.")
    if teste:
        r = api({"acao": "story_teste"})
        if not r.get("ofertas"):
            sys.exit("Não há oferta com link para o teste.")
        rodada(cl, r["ofertas"][:1])
        log("Teste feito. Confira o Story no Instagram (a figurinha deve ficar em cima do quadro amarelo).")
        return
    ultimo_motivo = None
    while True:
        try:
            r = api({"acao": "story_proximas"})
            ofertas = r.get("ofertas") or []
            if ofertas:
                log(f"Rodada: {len(ofertas)} Story(s).")
                cl = rodada(cl, ofertas)
            elif r.get("motivo") != ultimo_motivo:
                log(f"Nada agora ({r.get('motivo')}).")
            ultimo_motivo = r.get("motivo")
        except Exception as e:  # noqa: BLE001  (internet, servidor fora do ar...)
            log(f"Erro: {e}")
        time.sleep(60 + random.randint(0, 30))


if __name__ == "__main__":
    modo = (sys.argv[1] if len(sys.argv) > 1 else "ligado").lower()
    if modo == "conectar":
        try:
            conectar()
        except Exception as e:  # noqa: BLE001
            print(f"\nNão deu certo: {e}\nConfira usuário e senha e tente de novo. Se o Instagram pedir, aprove o login no celular.")
        input("\nAperte Enter para fechar.")
    else:
        ligado(teste=(modo == "teste"))
