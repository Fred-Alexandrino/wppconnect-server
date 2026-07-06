/**
 * server.js — Baileys (WhatsApp Web API sem Chrome)
 *
 * Conecta ao WhatsApp via QR code, escuta mensagens dos grupos
 * em tempo real E expõe endpoint para busca retroativa de histórico.
 *
 * Dois modos independentes:
 *  1. Monitoramento em tempo real — sempre ativo, não depende de clique
 *  2. /api/messages/:grupoId     — chamado pelo app.py quando botão "Verificar Rondas" é clicado
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const express = require("express");
const axios   = require("axios");
const pino    = require("pino");
const fs      = require("fs");

const app = express();
app.use(express.json());

const SERVIDOR_URL   = process.env.SERVIDOR_URL   || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const PORT           = process.env.PORT           || 3000;
const GRUPOS_IDS     = (process.env.GRUPOS_IDS || "").split(",").map(g => g.trim()).filter(Boolean);
const AUTH_FOLDER    = "./auth_info";

let qrCodeAtual   = null;
let statusConexao = "desconectado";
let sock          = null;

// ── Extrai texto de qualquer tipo de mensagem Baileys ────────────────────
function extrairTexto(msg) {
  if (!msg?.message) return "";
  const m = msg.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  );
}

// ── Verifica se a mensagem é relevante (ronda/falha) ─────────────────────
function ehMensagemRelevante(texto) {
  return (
    /🔴|🟡|🟢|🟠|✅|⏸️/.test(texto) ||
    /Usina:/i.test(texto) ||
    /DESVIO:/i.test(texto) ||
    /·\s*(Problema|Descrição|Impacto)/i.test(texto)
  );
}

// ── Encaminha mensagem para o app.py (webhook) ───────────────────────────
async function encaminharParaServidor(grupoId, texto) {
  if (!SERVIDOR_URL || !texto) return null;

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
  return resp.data;
}

// ── Inicia conexão com WhatsApp ──────────────────────────────────────────
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    browser: ["Painel Falhas", "Chrome", "1.0"],
    // Habilita sincronização de histórico (necessário para fetchMessageHistory)
    syncFullHistory: true,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  // ── Monitora mudanças de conexão ───────────────────────────────────────
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const QRCode = require("qrcode");
      QRCode.toDataURL(qr, (err, url) => {
        if (!err) {
          qrCodeAtual   = url;
          statusConexao = "aguardando_qr";
          console.log("📱 QR Code gerado — acesse /qr para escanear");
        }
      });
    }

    if (connection === "open") {
      statusConexao = "conectado";
      qrCodeAtual   = null;
      console.log("✅ WhatsApp conectado!");
      console.log("📡 Monitoramento em tempo real ATIVO");
    }

    if (connection === "close") {
      const codigo     = lastDisconnect?.error?.output?.statusCode;
      const reconectar = codigo !== DisconnectReason.loggedOut;
      console.log(`⚠️  Conexão encerrada (código ${codigo}). Reconectando: ${reconectar}`);
      statusConexao = "desconectado";
      if (reconectar) {
        setTimeout(conectar, 5000);
      } else {
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        setTimeout(conectar, 3000);
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  //  MODO 1 — MONITORAMENTO EM TEMPO REAL
  //  Sempre ativo. Não depende do botão "Verificar Rondas".
  //  Processa mensagens assim que chegam nos grupos configurados.
  // ══════════════════════════════════════════════════════════════════════
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;

        const grupoId = msg.key.remoteJid;
        if (!grupoId.endsWith("@g.us")) continue;

        // Filtra grupos se configurado
        if (GRUPOS_IDS.length > 0) {
          const permitido = GRUPOS_IDS.some(g => grupoId.includes(g));
          if (!permitido) continue;
        }

        const texto = extrairTexto(msg);
        if (!texto || !ehMensagemRelevante(texto)) continue;

        console.log(`\n📨 [Tempo real] Falha recebida de ${grupoId}`);
        console.log(`   ${texto.substring(0, 80)}...`);

        const resultado = await encaminharParaServidor(grupoId, texto);
        console.log(`   ✅ Gravado: ${JSON.stringify(resultado)}`);
      } catch (err) {
        console.error("❌ [Tempo real] Erro ao processar mensagem:", err.message);
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  MODO 2 — BUSCA RETROATIVA (chamada pelo botão "Verificar Rondas")
//  Usa fetchMessageHistory do Baileys para buscar histórico de mensagens.
//  Retorna array normalizado para o app.py processar.
// ══════════════════════════════════════════════════════════════════════════
async function buscarHistorico(grupoId, sinceTimestamp, limit) {
  const encontradas = [];

  try {
    let cursor     = undefined;
    let tentativas = 0;

    while (encontradas.length < limit && tentativas < 8) {
      tentativas++;

      const resultado = await sock.fetchMessageHistory(
        50,  // mensagens por lote
        { id: grupoId, type: "group" },
        cursor
      );

      if (!resultado?.messages?.length) break;

      for (const msg of resultado.messages) {
        const ts = Number(msg.messageTimestamp || 0);

        // Para quando chegou a mensagens mais antigas que o período pedido
        if (sinceTimestamp > 0 && ts < sinceTimestamp) {
          return encontradas;
        }

        if (msg.key?.fromMe) continue;

        const texto = extrairTexto(msg);
        if (!texto) continue;

        encontradas.push({
          key:              msg.key,
          messageTimestamp: ts,
          message:          { conversation: texto },
          body:             texto,
          text:             texto,
        });

        if (encontradas.length >= limit) break;
      }

      cursor = resultado.syncCursor;
      if (!cursor) break;
    }
  } catch (err) {
    // fetchMessageHistory pode não estar disponível em todas as sessões.
    // O monitoramento em tempo real não é afetado.
    console.warn(`⚠️  fetchMessageHistory não disponível: ${err.message}`);
    console.warn("   Retornando array vazio. Tempo real continua ativo.");
  }

  return encontradas;
}

// ── Endpoints ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", wpp: statusConexao });
});

app.get("/status", (req, res) => {
  res.json({
    status:              statusConexao,
    grupos_configurados: GRUPOS_IDS,
    servidor_principal:  SERVIDOR_URL || "não configurado",
  });
});

app.get("/qr", (req, res) => {
  if (statusConexao === "conectado") {
    return res.send(`
      <html><body style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;background:#f0f0f0;">
        <div style="text-align:center;">
          <h2 style="color:#25D366;">✅ WhatsApp Conectado!</h2>
          <p>Monitoramento em tempo real <strong>ativo</strong>.</p>
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
    const lista  = Object.entries(grupos).map(([id, g]) => ({ id, nome: g.subject }));
    res.json({ total: lista.length, grupos: lista });
  } catch (err) {
    res.json({ erro: err.message });
  }
});

/**
 * GET /api/messages/:grupoId
 *
 * Busca histórico de mensagens de um grupo.
 * Chamado pelo app.py quando o botão "Verificar Rondas" é clicado.
 *
 * Query params:
 *   sinceTimestamp — Unix timestamp em segundos. Retorna mensagens a partir deste momento.
 *   limit          — Número máximo de mensagens (padrão: 200)
 *
 * Headers:
 *   X-Webhook-Secret — chave secreta (obrigatório se WEBHOOK_SECRET estiver configurado)
 */
app.get("/api/messages/:grupoId", async (req, res) => {
  // Autenticação
  if (WEBHOOK_SECRET) {
    const secret = req.headers["x-webhook-secret"] || req.query.secret || "";
    if (secret !== WEBHOOK_SECRET) {
      return res.status(401).json({ erro: "não autorizado" });
    }
  }

  if (!sock || statusConexao !== "conectado") {
    return res.status(503).json({
      erro:     "WhatsApp não conectado",
      status:   statusConexao,
      messages: [],
    });
  }

  const grupoId        = req.params.grupoId;
  const sinceTimestamp = parseInt(req.query.sinceTimestamp || "0", 10);
  const limit          = Math.min(parseInt(req.query.limit || "200", 10), 500);

  const desde = sinceTimestamp
    ? new Date(sinceTimestamp * 1000).toLocaleString("pt-BR")
    : "sem filtro de tempo";

  console.log(`\n🔍 [Rondas] Busca histórica | grupo: ${grupoId} | desde: ${desde} | limit: ${limit}`);

  try {
    const messages = await buscarHistorico(grupoId, sinceTimestamp, limit);
    console.log(`   📦 ${messages.length} mensagens retornadas`);
    res.json({ messages, total: messages.length, grupoId });
  } catch (err) {
    console.error(`❌ [Rondas] Erro: ${err.message}`);
    res.status(500).json({ erro: err.message, messages: [] });
  }
});

/**
 * POST /api/processar
 * Recebe texto diretamente e encaminha para o app.py.
 * Útil para reprocessamento manual ou testes.
 */
app.post("/api/processar", async (req, res) => {
  if (WEBHOOK_SECRET) {
    const secret = req.headers["x-webhook-secret"] || "";
    if (secret !== WEBHOOK_SECRET) {
      return res.status(401).json({ erro: "não autorizado" });
    }
  }

  const { texto, grupoId = "manual@g.us" } = req.body || {};
  if (!texto) return res.status(400).json({ erro: "campo 'texto' obrigatório" });

  try {
    const resultado = await encaminharParaServidor(grupoId, texto);
    res.json({ ok: true, resultado });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Inicia ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor Baileys na porta ${PORT}`);
  console.log(`📡 Modo 1 (tempo real): sempre ativo ao conectar`);
  console.log(`🔍 Modo 2 (histórico):  disponível via GET /api/messages/:grupoId`);
  conectar().catch(err => console.error("❌ Erro ao conectar:", err));
});
