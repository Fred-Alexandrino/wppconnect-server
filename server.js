/**
 * server.js — Baileys (WhatsApp Web API sem Chrome)
 * 
 * Conecta ao WhatsApp via QR code, escuta mensagens dos grupos
 * e encaminha mensagens de falha para o servidor principal (app.py)
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const express = require("express");
const axios   = require("axios");
const pino    = require("pino");
const path    = require("path");
const fs      = require("fs");

const app = express();
app.use(express.json());

const SERVIDOR_URL    = process.env.SERVIDOR_URL || "";
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || "";
const PORT            = process.env.PORT || 3000;
const GRUPOS_IDS      = (process.env.GRUPOS_IDS || "").split(",").map(g => g.trim()).filter(Boolean);
const AUTH_FOLDER     = "./auth_info";

let qrCodeAtual   = null;
let statusConexao = "desconectado";
let sock          = null;

// ── Inicia conexão com WhatsApp ───────────────────────────────────────────
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    browser: ["Painel Falhas", "Chrome", "1.0"],
  });

  // Salva credenciais quando atualizar
  sock.ev.on("creds.update", saveCreds);

  // Monitora conexão
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      // Converte QR para imagem base64 usando qrcode
      const QRCode = require("qrcode");
      QRCode.toDataURL(qr, (err, url) => {
        if (!err) {
          qrCodeAtual = url;
          statusConexao = "aguardando_qr";
          console.log("📱 QR Code gerado — acesse /qr para escanear");
        }
      });
    }

    if (connection === "open") {
      statusConexao = "conectado";
      qrCodeAtual   = null;
      console.log("✅ WhatsApp conectado!");
    }

    if (connection === "close") {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      const reconectar = codigo !== DisconnectReason.loggedOut;
      console.log(`⚠️  Conexão encerrada (código ${codigo}). Reconectando: ${reconectar}`);
      statusConexao = "desconectado";
      if (reconectar) {
        setTimeout(conectar, 5000);
      } else {
        // Usuário deslogou — limpa auth e reinicia
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        setTimeout(conectar, 3000);
      }
    }
  });

  // Escuta mensagens
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        // Ignora mensagens próprias
        if (msg.key.fromMe) continue;

        // Só grupos
        const grupoId = msg.key.remoteJid;
        if (!grupoId.endsWith("@g.us")) continue;

        // Filtra grupos se configurado
        if (GRUPOS_IDS.length > 0) {
          const permitido = GRUPOS_IDS.some(g => grupoId.includes(g));
          if (!permitido) continue;
        }

        // Extrai texto
        const texto =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          "";

        if (!texto) continue;

        // Só encaminha se parecer mensagem de falha
        const ehFalha = /🔴|🟡|🟢|🟠/.test(texto) || /Usina:/i.test(texto);
        if (!ehFalha) continue;

        console.log(`\n📨 Falha recebida de ${grupoId}`);
        console.log(`   ${texto.substring(0, 80)}...`);

        // Encaminha para o servidor principal
        if (SERVIDOR_URL) {
          const headers = { "Content-Type": "application/json" };
          if (WEBHOOK_SECRET) headers["X-Webhook-Secret"] = WEBHOOK_SECRET;

          const payload = {
            event: "messages.upsert",
            data: {
              key: { remoteJid: grupoId, fromMe: false },
              message: { conversation: texto },
            },
          };

          const resp = await axios.post(`${SERVIDOR_URL}/webhook`, payload, { headers, timeout: 15000 });
          console.log(`   ✅ Gravado: ${JSON.stringify(resp.data)}`);
        }
      } catch (err) {
        console.error("❌ Erro ao processar mensagem:", err.message);
      }
    }
  });
}

// ── Endpoints ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", wpp: statusConexao });
});

app.get("/qr", (req, res) => {
  if (statusConexao === "conectado") {
    return res.send(`
      <html><body style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;background:#f0f0f0;">
        <div style="text-align:center;">
          <h2 style="color:#25D366;">✅ WhatsApp Conectado!</h2>
          <p>O sistema está funcionando e escutando os grupos.</p>
          <a href="/grupos" style="color:#128C7E;">Ver grupos conectados</a>
        </div>
      </body></html>
    `);
  }
  if (qrCodeAtual) {
    return res.send(`
      <html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;background:#f0f0f0;">
        <h2>Escaneie o QR Code com o WhatsApp</h2>
        <p style="color:#666;">WhatsApp → três pontinhos → Aparelhos conectados → Conectar aparelho</p>
        <img src="${qrCodeAtual}" style="width:300px;height:300px;border:8px solid white;border-radius:12px;" />
        <p style="color:#999;font-size:13px;margin-top:16px;">Página atualiza em 15 segundos</p>
        <script>setTimeout(() => location.reload(), 15000);</script>
      </body></html>
    `);
  }
  res.send(`
    <html><body style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;background:#f0f0f0;">
      <div style="text-align:center;">
        <h2>⏳ Aguarde...</h2>
        <p>Gerando QR Code, isso leva ~30 segundos.</p>
        <script>setTimeout(() => location.reload(), 5000);</script>
      </div>
    </body></html>
  `);
});

app.get("/grupos", async (req, res) => {
  if (!sock || statusConexao !== "conectado") {
    return res.json({ erro: "WhatsApp não conectado" });
  }
  try {
    const grupos = await sock.groupFetchAllParticipating();
    const lista = Object.entries(grupos).map(([id, g]) => ({ id, nome: g.subject }));
    res.json({ total: lista.length, grupos: lista });
  } catch (err) {
    res.json({ erro: err.message });
  }
});

app.get("/status", (req, res) => {
  res.json({
    status: statusConexao,
    grupos_configurados: GRUPOS_IDS,
    servidor_principal: SERVIDOR_URL || "não configurado",
  });
});

// ── Inicia ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  conectar().catch(err => console.error("❌ Erro ao conectar:", err));
});
