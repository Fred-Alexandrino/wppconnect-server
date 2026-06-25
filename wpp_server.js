/**
 * server.js — WPPConnect + encaminhamento para o servidor principal
 * 
 * Este serviço:
 * 1. Conecta ao WhatsApp via QR code (igual WhatsApp Web)
 * 2. Escuta mensagens dos grupos configurados
 * 3. Encaminha mensagens de falha para o servidor principal (app.py no Render)
 */

const wppconnect = require("@wppconnect-team/wppconnect");
const express    = require("express");
const axios      = require("axios");

const app  = express();
app.use(express.json());

// ── Configuração via variáveis de ambiente ────────────────────────────────
const SERVIDOR_PRINCIPAL = process.env.SERVIDOR_URL;      // URL do app.py no Render
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET || "";
const PORT               = process.env.PORT || 3000;
const SESSION_NAME       = process.env.SESSION_NAME || "painel-falhas";

// IDs dos grupos permitidos (separados por vírgula). Se vazio, aceita todos os grupos.
const GRUPOS_PERMITIDOS  = (process.env.GRUPOS_IDS || "")
  .split(",")
  .map(g => g.trim())
  .filter(Boolean);

let clienteWpp = null;
let qrCodeAtual = null;
let statusConexao = "desconectado";

// ── Inicia WPPConnect ─────────────────────────────────────────────────────
async function iniciarWPP() {
  console.log("🟡 Iniciando WPPConnect...");

  clienteWpp = await wppconnect.create({
    session: SESSION_NAME,
    catchQR: (base64Qr, asciiQR) => {
      console.log("\n📱 QR CODE GERADO — escaneie com o WhatsApp:");
      console.log(asciiQR);
      qrCodeAtual = base64Qr;
      statusConexao = "aguardando_qr";
    },
    statusFind: (statusSession) => {
      console.log("Status WPP:", statusSession);
      if (statusSession === "inChat" || statusSession === "isLogged") {
        statusConexao = "conectado";
        qrCodeAtual = null;
        console.log("✅ WhatsApp conectado!");
      }
    },
    headless: true,
    devtools: false,
    useChrome: false,
    debug: false,
    logQR: true,
    browserArgs: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ],
    autoClose: 0,
    tokenStore: "file",
    folderNameToken: "./tokens",
  });

  // ── Escuta mensagens ──────────────────────────────────────────────────
  clienteWpp.onMessage(async (mensagem) => {
    try {
      // Só grupos
      if (!mensagem.isGroupMsg) return;

      const grupoId = mensagem.chatId;

      // Filtra grupos se configurado
      if (GRUPOS_PERMITIDOS.length > 0) {
        const permitido = GRUPOS_PERMITIDOS.some(g => grupoId.includes(g));
        if (!permitido) return;
      }

      const texto = mensagem.body || mensagem.caption || "";
      if (!texto) return;

      // Só encaminha se parece mensagem de falha (tem emoji de status ou campo "Usina:")
      const ehFalha = /🔴|🟡|🟢|🟠/.test(texto) || /Usina:/i.test(texto);
      if (!ehFalha) return;

      console.log(`\n📨 Mensagem de falha recebida de ${grupoId}`);
      console.log(`   Texto: ${texto.substring(0, 80)}...`);

      // Encaminha para o servidor principal
      if (SERVIDOR_PRINCIPAL) {
        const headers = { "Content-Type": "application/json" };
        if (WEBHOOK_SECRET) headers["X-Webhook-Secret"] = WEBHOOK_SECRET;

        const payload = {
          event: "messages.upsert",
          data: {
            key: {
              remoteJid: grupoId,
              fromMe: false,
            },
            message: {
              conversation: texto,
            },
          },
        };

        const resp = await axios.post(`${SERVIDOR_PRINCIPAL}/webhook`, payload, { headers, timeout: 10000 });
        console.log(`   ✅ Encaminhado: ${JSON.stringify(resp.data)}`);
      } else {
        console.log("⚠️  SERVIDOR_URL não configurado — mensagem não encaminhada");
      }

    } catch (err) {
      console.error("❌ Erro ao processar mensagem:", err.message);
    }
  });

  console.log("✅ WPPConnect iniciado e escutando mensagens");
}

// ── Endpoints de status e controle ───────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", wpp: statusConexao });
});

app.get("/qr", (req, res) => {
  if (statusConexao === "conectado") {
    return res.json({ status: "conectado", mensagem: "WhatsApp já está conectado!" });
  }
  if (qrCodeAtual) {
    // Retorna página HTML com o QR para escanear pelo navegador
    return res.send(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;background:#f0f0f0;">
          <h2>Escaneie o QR Code com o WhatsApp</h2>
          <p style="color:#666;">Abra o WhatsApp → três pontinhos → Aparelhos conectados → Conectar aparelho</p>
          <img src="${qrCodeAtual}" style="width:300px;height:300px;border:8px solid white;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.15);" />
          <p style="color:#999;font-size:13px;margin-top:16px;">Esta página atualiza automaticamente em 30 segundos</p>
          <script>setTimeout(() => location.reload(), 30000);</script>
        </body>
      </html>
    `);
  }
  res.json({ status: statusConexao, mensagem: "QR ainda não gerado, aguarde..." });
});

app.get("/status", (req, res) => {
  res.json({
    status: statusConexao,
    grupos_configurados: GRUPOS_PERMITIDOS,
    servidor_principal: SERVIDOR_PRINCIPAL || "não configurado",
  });
});

// Endpoint para listar grupos (útil para pegar os IDs)
app.get("/grupos", async (req, res) => {
  if (!clienteWpp || statusConexao !== "conectado") {
    return res.json({ erro: "WhatsApp não conectado ainda" });
  }
  try {
    const chats = await clienteWpp.listChats();
    const grupos = chats
      .filter(c => c.isGroup)
      .map(c => ({ id: c.id._serialized, nome: c.name }));
    res.json({ grupos });
  } catch (err) {
    res.json({ erro: err.message });
  }
});

// ── Inicia servidor e WPPConnect ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  iniciarWPP().catch(err => {
    console.error("❌ Erro ao iniciar WPPConnect:", err);
  });
});
