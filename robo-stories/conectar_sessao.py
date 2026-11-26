"""Conecta o robô de Stories usando a sessão de um login feito no navegador (Chrome).
Use quando o CONECTAR-INSTAGRAM.bat der "Sua versão do Instagram está desatualizada".
O código de sessão (cookie "sessionid") é colado escondido e fica só no arquivo de sessão, como no celular."""

import json
import sys
from urllib.parse import unquote

from instagrapi.exceptions import ChallengeRequired, LoginRequired

import robo_stories as rs

print("\n=== Conectar o robô de Stories pela sessão do navegador ===")
print("1) No Chrome, entre em instagram.com com a conta da loja.")
print("2) Aperte F12 > Application (Aplicativo) > Cookies > https://www.instagram.com")
print("3) Dê dois cliques no VALOR da linha 'sessionid' e aperte Ctrl+C.")
print("4) Volte aqui e aperte Enter. Eu leio da área de transferência (não aparece na tela) e apago de lá.\n")
input("Copiou? Aperte Enter... ")
import tkinter  # noqa: E402
_tk = tkinter.Tk()
_tk.withdraw()
try:
    sid = _tk.clipboard_get()
except tkinter.TclError:
    sid = ""
_tk.clipboard_clear()
_tk.clipboard_append(" ")
_tk.update()
_tk.destroy()
sid = unquote(sid.strip().strip('"'))  # o Chrome mostra ":" como "%3A"
if len(sid) < 31 or not sid[:1].isdigit():
    sys.exit(f"O que está copiado não parece o sessionid ({len(sid)} caracteres). Copie de novo e rode outra vez.")
cl = rs.novo_cliente()
for f in (rs.SESSAO, rs.SESSAO.with_name(rs.SESSAO.name + ".bak")):
    if f.exists():  # reaproveita o "aparelho" já conhecido pelo Instagram
        try:
            uu = json.loads(f.read_text(encoding="utf-8")).get("uuids")
            if uu:
                cl.set_uuids(uu)
                break
        except Exception:  # noqa: BLE001
            pass
try:
    cl.login_by_sessionid(sid)
    eu = cl.account_info()
except (LoginRequired, ChallengeRequired) as e:
    sys.exit(f"\nNão deu certo: {e}\nO código de sessão pode ter expirado: saia e entre de novo no Chrome e copie outra vez.")
except Exception as e:  # noqa: BLE001
    sys.exit(f"\nNão deu certo: {e}")
finally:
    del sid
cl.dump_settings(rs.SESSAO)
print(f"\nPronto! Conectado como @{eu.username}. Sessão guardada em {rs.SESSAO.name}.")
print("O robô percebe sozinho em até 1 minuto e volta a postar. Pode fechar esta janela.")
rs.avisar(f"conectado ao Instagram (sessão do navegador) como @{eu.username}.")
