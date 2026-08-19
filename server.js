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
const path    = require("path");

const app = express();
app.use(express.json({ limit: "20mb" }));

const SERVIDOR_URL   = process.env.SERVIDOR_URL   || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const PORT           = process.env.PORT           || 3000;
const GRUPOS_IDS     = (process.env.GRUPOS_IDS || "").split(",").map(g => g.trim()).filter(Boolean);

// Grupos mapeados pro resumo diário/semanal (Gestão O&M) — TODA mensagem
// desses grupos é capturada e arquivada, independente de ser relevante
// pra detecção de falha ou não. Implementado em 27/07/2026 a pedido do
// Fred, pra permitir que o resumo diário também traga um apanhado do
// que foi tratado em cada grupo, não só o que já era parseado (status
// de OS). Mapeamento de ID confirmado direto no servidor na mesma data.
const GRUPOS_RESUMO_DIARIO = {
  "120363423233716775": "[O&M] - Grid Co. | Renogrid",
  "120363423427343356": "[O&M] - Grid Co. | Thopen",
  "120363426381032089": "[O&M] - Grid Co. | Alves Lima",
  "120363427259899891": "[O&M] - Grid Co. | Sal Energia",
  "120363423844956611": "[O&M] - Grid Co. | GD Energy",
  "120363402559504115": "[O&M] - Grid Co. | 2C",
  "120363424804307945": "Thopen & GridCo. | Usinas FRED ALEXANDRINO",
  "120363406191445169": "O&M - San. Bárb./Pirac. - SP LESTE 03",
  "120363405244065477": "O&M CE Sítio Bonfim - Grid/Thopen",
  "120363426886851537": "Equipe Nova Xavantina",
  "120363425342949474": "Equipe Araputanga/Poconé",
  "120363422795399103": "Equipe Ibaté/Boa Esperança",
  "120363426700120222": "Equipe Colíder - Grid Co.",
  "120363428268426406": "Equipe Matão/Topázio",
  "120363427839577268": "Equipe Elias Fausto",
  "120363403858325184": "Equipe Sete Lagoas",
  "120363406329162612": "Equipe Nobres",
  "120363405111083249": "Equipe Crateús",
  "120363410081447469": "Equipe Crateús",
  "120363421162420788": "COS — Técnicos O&M Centro-Oeste",
  "120363425837962709": "COS — Técnicos O&M Sul",
  "120363402176878100": "COS — Técnicos O&M Nordeste",
  "120363423533840348": "COS — Técnicos O&M Sudeste",
  "120363421052607450": "COS — Técnicos O&M Norte",
  "120363428178674382": "Equipe - Aquiraz/Cascavel",
};
const AUTH_FOLDER    = "./auth_info";

// ── Backup da sessão do WhatsApp no GitHub (repo PRIVADO) ────────────────
// Disco do Render free tier é efêmero: toda vez que o serviço reinicia
// (deploy, sleep/wake, crash) a pasta auth_info é apagada e seria preciso
// escanear o QR code de novo. Pra permitir que esse serviço também possa
// dormir no futuro sem perder a sessão, fazemos backup/restore via GitHub.
const GITHUB_TOKEN         = process.env.GITHUB_TOKEN || "";
const GITHUB_BACKUP_REPO   = process.env.GITHUB_BACKUP_REPO   || "Fred-Alexandrino/wppconnect-auth-backup";
const GITHUB_BACKUP_PATH   = process.env.GITHUB_BACKUP_PATH   || "auth_info_backup.json";
const GITHUB_BACKUP_BRANCH = process.env.GITHUB_BACKUP_BRANCH || "main";
const BACKUP_HABILITADO    = !!GITHUB_TOKEN;
const DEBOUNCE_BACKUP_MS   = 45000; // agrupa varias creds.update seguidas num so commit

let backupTimer = null;

let qrCodeAtual   = null;
let statusConexao = "desconectado";
let sock          = null;
let desconectadoDesde = null; // timestamp de quando a conexão caiu, usado pelo vigia abaixo
let conectando    = false; // trava de reentrância — ver nota no início de conectar()

// ── Controle de alertas de conexão (escopo de MÓDULO, não de conectar()) ──
// Precisa sobreviver a reconexões automáticas. Antes esse estado ficava
// dentro de conectar(), então cada reconexão (que acontece com frequência,
// mesmo sem problema real) recriava as variáveis do zero — e um blip que
// se resolvia sozinho em segundos podia gerar um novo alerta de QR/queda
// a cada ciclo, mesmo com a conexão ok. Relatado pelo Fred em 04/08/2026
// recebendo "WhatsApp precisa de novo QR Code" repetidamente sem motivo
// real. Agora, além de sobreviver a reconexões, tem um cooldown mínimo
// entre alertas do mesmo tipo.
let alertaDesconexaoEnviado = false;
let timerAlertaDesconexao = null;
let timerAlertaQr = null;
let ultimoAlertaQrEnviadoEm = 0;
const JANELA_GRACA_MS = 25000; // 25s — tempo pra reconexão automática se resolver sozinha
const COOLDOWN_ALERTA_QR_MS = 10 * 60 * 1000; // 10 min — evita repetir alerta de QR a cada refresh/reconexão

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
    /·\s*(Problema|Descrição|Impacto)/i.test(texto) ||
    /ATUALIZA[CÇ][AÃ]O\s+(OS|ATIVIDADE)/i.test(texto)
  );
}

// ── Captura TODA mensagem dos grupos mapeados pro resumo diário/semanal
//    (Gestão O&M) — independente de ser "relevante" pra detecção de
//    falha. Fire-and-forget (não trava o fluxo principal se falhar; só
//    loga o erro), pois isso é arquivamento, não algo crítico como
//    registrar uma falha nova. ─────────────────────────────────────────
async function capturarMensagemParaResumo(grupoId, nomeGrupo, remetente, texto) {
  if (!SERVIDOR_URL || !texto) return;
  const headers = { "Content-Type": "application/json" };
  if (WEBHOOK_SECRET) headers["X-Webhook-Secret"] = WEBHOOK_SECRET;
  try {
    await axios.post(`${SERVIDOR_URL}/capturar-mensagem-grupo`, {
      grupoId, nomeGrupo, remetente, texto,
    }, { headers, timeout: 10000 });
  } catch (err) {
    console.error(`⚠️ [Captura resumo] Falha ao arquivar mensagem de ${nomeGrupo}: ${err.message}`);
  }
}

// ── Encaminha mensagem para o app.py (webhook), com retry + alerta ──────
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

  const esperas = [2000, 5000, 10000];
  let ultimoErro = null;
  for (let tentativa = 0; tentativa <= esperas.length; tentativa++) {
    try {
      const resp = await axios.post(`${SERVIDOR_URL}/webhook`, payload, { headers, timeout: 15000 });
      return resp.data;
    } catch (err) {
      ultimoErro = err;
      console.error(`❌ [Repasse] Tentativa ${tentativa + 1} falhou: ${err.message}`);
      if (tentativa < esperas.length) {
        await new Promise(r => setTimeout(r, esperas[tentativa]));
      }
    }
  }

  // Todas as tentativas falharam — mensagem real de ocorrência ficaria
  // perdida silenciosamente (só no console, que ninguém vê em tempo
  // real). Alerta imediato pro dashboard, incluindo um trecho do texto
  // perdido, pra dar pelo menos a chance de registrar manualmente depois
  // via /processar-texto-manual (bug identificado em 13/07/2026: mensagens
  // reais de rondas somem por dias sem ninguém saber).
  await alertarStatusConexao(
    "falha_encaminhamento",
    `Grupo ${grupoId} — falha: ${ultimoErro?.message || "desconhecida"} — início: "${texto.substring(0, 200)}"`
  );
  return null;
}

async function alertarStatusConexao(status, detalhe = "") {
  if (!SERVIDOR_URL) return;
  try {
    const headers = { "Content-Type": "application/json" };
    if (WEBHOOK_SECRET) headers["X-Webhook-Secret"] = WEBHOOK_SECRET;
    await axios.post(`${SERVIDOR_URL}/alertar-wpp-status`, { status, detalhe }, { headers, timeout: 10000 });
  } catch (e) {
    console.error("⚠️ Falha ao alertar status de conexão:", e.message);
  }
}

// ── Agenda um backup (debounced) apos creds.update ───────────────────────
function agendarBackupAuth() {
  if (!BACKUP_HABILITADO) return;
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    fazerBackupAuth().catch(err => console.error("⚠️  [Backup Auth] Falha:", err.message));
  }, DEBOUNCE_BACKUP_MS);
}

// ── Empacota todos os arquivos de auth_info num unico JSON e sobe pro GitHub
async function fazerBackupAuth() {
  if (!BACKUP_HABILITADO) return;
  if (!fs.existsSync(AUTH_FOLDER)) return;

  const arquivos = fs.readdirSync(AUTH_FOLDER).filter(
    f => fs.statSync(path.join(AUTH_FOLDER, f)).isFile()
  );
  if (arquivos.length === 0) return;

  const pacote = {};
  for (const nome of arquivos) {
    pacote[nome] = fs.readFileSync(path.join(AUTH_FOLDER, nome)).toString("base64");
  }

  const conteudoB64 = Buffer.from(JSON.stringify(pacote), "utf-8").toString("base64");
  const apiUrl = `https://api.github.com/repos/${GITHUB_BACKUP_REPO}/contents/${GITHUB_BACKUP_PATH}`;
  const headers = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
  };

  let shaAtual = null;
  try {
    const atual = await axios.get(apiUrl, { headers, params: { ref: GITHUB_BACKUP_BRANCH } });
    shaAtual = atual.data.sha;
  } catch (e) {
    if (e.response?.status !== 404) throw e; // 404 = ainda nao existe backup, tudo bem
  }

  await axios.put(apiUrl, {
    message: `backup auth_info [skip ci] ${new Date().toISOString()}`,
    content: conteudoB64,
    branch: GITHUB_BACKUP_BRANCH,
    ...(shaAtual ? { sha: shaAtual } : {}),
  }, { headers });

  console.log(`💾 [Backup Auth] ${arquivos.length} arquivo(s) salvos no GitHub (${GITHUB_BACKUP_REPO})`);
}

// ── Restaura auth_info do GitHub, se nao houver sessao local ainda ───────
async function restaurarAuthDoGitHub() {
  if (!BACKUP_HABILITADO) {
    console.log("ℹ️  [Restore Auth] GITHUB_TOKEN não configurado — backup/restore desativado");
    return false;
  }

  const jaTemSessao = fs.existsSync(AUTH_FOLDER) &&
    fs.readdirSync(AUTH_FOLDER).some(f => f.includes("creds"));
  if (jaTemSessao) return false; // sessao local ja existe, nao sobrescreve

  const apiUrl = `https://api.github.com/repos/${GITHUB_BACKUP_REPO}/contents/${GITHUB_BACKUP_PATH}`;
  const headers = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
  };

  try {
    const resp = await axios.get(apiUrl, { headers, params: { ref: GITHUB_BACKUP_BRANCH } });
    const pacote = JSON.parse(Buffer.from(resp.data.content, "base64").toString("utf-8"));

    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    for (const [nome, conteudoB64] of Object.entries(pacote)) {
      fs.writeFileSync(path.join(AUTH_FOLDER, nome), Buffer.from(conteudoB64, "base64"));
    }
    console.log(`♻️  [Restore Auth] ${Object.keys(pacote).length} arquivo(s) restaurados do GitHub — sessão recuperada sem precisar de QR`);
    return true;
  } catch (e) {
    if (e.response?.status === 404) {
      console.log("ℹ️  [Restore Auth] Nenhum backup encontrado no GitHub — sessão nova, QR necessário");
    } else {
      console.error("⚠️  [Restore Auth] Falha ao restaurar:", e.message);
    }
    return false;
  }
}

// ── Inicia conexão com WhatsApp ──────────────────────────────────────────
async function conectar() {
  // TRAVA DE REENTRÂNCIA + FECHAMENTO DO SOCKET ANTIGO (adicionado
  // 17/08/2026): conectar() podia ser chamada mais de uma vez em paralelo
  // — pelo handler de "connection.update" (close → setTimeout(conectar,
  // 5000)) e pelo Vigia (setInterval de 1min), sem nenhuma trava entre
  // eles. Cada chamada cria um socket NOVO via makeWASocket() sem nunca
  // fechar o socket antigo, então em janelas de instabilidade dava pra
  // acabar com DUAS conexões WebSocket vivas usando a MESMA sessão ao
  // mesmo tempo — o WhatsApp detecta isso como conflito e derruba com
  // código 440 repetidamente (foi exatamente o padrão observado em
  // 17/08/2026: ciclos de poucos segundos entre "conectado" e "encerrada
  // código 440", até degenerar num código 405 persistente). Agora só uma
  // chamada de conectar() roda por vez, e o socket anterior é fechado
  // explicitamente antes de abrir um novo.
  if (conectando) {
    console.log("⏭️  [conectar] Já há uma conexão em andamento — ignorando chamada duplicada.");
    return;
  }
  conectando = true;
  try {
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end(undefined);
      } catch (err) {
        console.log("⚠️  [conectar] Erro ao fechar socket anterior (ignorado):", err.message);
      }
      sock = null;
    }

    await restaurarAuthDoGitHub();

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

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    agendarBackupAuth();
  });

  // ── Monitora mudanças de conexão ───────────────────────────────────────
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const QRCode = require("qrcode");
      QRCode.toDataURL(qr, (err, url) => {
        if (!err) {
          qrCodeAtual   = url;
          statusConexao = "aguardando_qr";
          console.log("📱 QR Code gerado — acesse /qr para escanear");
          // O Baileys gera um QR novo a cada ~20-60s enquanto não é
          // escaneado, e uma reconexão automática também pode passar por
          // um estado "aguardando_qr" bem breve antes de conectar sozinha
          // de verdade. Por isso só alerta depois de uma janela de graça
          // (dá tempo de resolver sozinho, igual já era feito pra queda de
          // conexão) E com um cooldown mínimo entre alertas — evita tanto
          // o refresh do QR quanto reconexões automáticas gerando push
          // repetido (relatado pelo Fred em 04/08/2026).
          if (!timerAlertaQr && Date.now() - ultimoAlertaQrEnviadoEm > COOLDOWN_ALERTA_QR_MS) {
            timerAlertaQr = setTimeout(() => {
              timerAlertaQr = null;
              if (statusConexao === "aguardando_qr") {
                ultimoAlertaQrEnviadoEm = Date.now();
                alertarStatusConexao("aguardando_qr");
              }
            }, JANELA_GRACA_MS);
          }
        }
      });
    }

    if (connection === "open") {
      statusConexao = "conectado";
      qrCodeAtual   = null;
      desconectadoDesde = null;
      if (timerAlertaQr) {
        clearTimeout(timerAlertaQr);
        timerAlertaQr = null;
      }
      console.log("✅ WhatsApp conectado!");
      console.log("📡 Monitoramento em tempo real ATIVO");
      // reconectou dentro da janela de graça — cancela o alerta pendente,
      // já que foi só uma instabilidade momentânea (comum em conexões
      // WebSocket) e não uma queda de verdade. Sem isso, todo blip
      // passageiro virava notificação falsa (relatado pelo Fred em
      // 14/07/2026 — "WhatsApp desconectado" chegando com frequência sem
      // nenhuma queda real).
      if (timerAlertaDesconexao) {
        clearTimeout(timerAlertaDesconexao);
        timerAlertaDesconexao = null;
      }
      // só avisa "reconectado" se um alerta de "desconectado" tiver
      // sido REALMENTE enviado antes — não basta ter havido um evento de
      // close, já que a maioria se resolve dentro da janela de graça sem
      // nunca virar alerta nenhum. Sem essa distinção, toda oscilação
      // breve (close→open em poucos segundos, comum e inofensiva) gerava
      // um "reconectado" solto, sem nenhum "desconectado" correspondente
      // — relatado pelo Fred em 05/08/2026 recebendo "reconectado" 3x
      // seguidas com o WhatsApp nunca tendo saído do ar de verdade.
      if (alertaDesconexaoEnviado) {
        alertarStatusConexao("reconectado");
        alertaDesconexaoEnviado = false;
      }
    }

    if (connection === "close") {
      const codigo     = lastDisconnect?.error?.output?.statusCode;
      const reconectar = codigo !== DisconnectReason.loggedOut;
      console.log(`⚠️  Conexão encerrada (código ${codigo}). Reconectando: ${reconectar}`);
      statusConexao = "desconectado";
      if (!desconectadoDesde) desconectadoDesde = Date.now();

      // só alerta se a conexão continuar caída depois da janela de graça —
      // dá tempo pro Baileys reconectar sozinho antes de incomodar o Fred
      // com uma notificação de algo que já se resolveu.
      if (timerAlertaDesconexao) clearTimeout(timerAlertaDesconexao);
      timerAlertaDesconexao = setTimeout(() => {
        if (statusConexao === "desconectado") {
          alertaDesconexaoEnviado = true;
          alertarStatusConexao("desconectado", `código ${codigo}, sem reconectar após ${JANELA_GRACA_MS/1000}s`);
        }
        timerAlertaDesconexao = null;
      }, JANELA_GRACA_MS);

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

        const grupoIdNumerico = grupoId.replace("@g.us", "");
        const textoBruto = extrairTexto(msg);

        // Captura pro resumo diário/semanal — roda pra QUALQUER mensagem
        // dos grupos mapeados, independente de ser relevante pra
        // detecção de falha ou não, e independente do filtro GRUPOS_IDS
        // abaixo (que é só pro fluxo de falha/ronda).
        if (textoBruto && GRUPOS_RESUMO_DIARIO[grupoIdNumerico]) {
          const remetente = msg.pushName || msg.key.participant || "desconhecido";
          capturarMensagemParaResumo(grupoId, GRUPOS_RESUMO_DIARIO[grupoIdNumerico], remetente, textoBruto);
        }

        // Filtra grupos se configurado
        if (GRUPOS_IDS.length > 0) {
          const permitido = GRUPOS_IDS.some(g => grupoId.includes(g));
          if (!permitido) continue;
        }

        const texto = textoBruto;
        if (!texto || !ehMensagemRelevante(texto)) continue;

        console.log(`\n📨 [Tempo real] Falha recebida de ${grupoId}`);
        console.log(`   ${texto.substring(0, 80)}...`);

        const resultado = await encaminharParaServidor(grupoId, texto);
        if (resultado === null) {
          console.error(`   ❌ Falha ao gravar após todas as tentativas — alerta enviado`);
        } else {
          console.log(`   ✅ Gravado: ${JSON.stringify(resultado)}`);
        }
      } catch (err) {
        console.error("❌ [Tempo real] Erro ao processar mensagem:", err.message);
      }
    }
  });
  } catch (err) {
    console.error("❌ [conectar] Erro ao estabelecer conexão:", err.message);
    throw err;
  } finally {
    conectando = false;
  }
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

/**
 * POST /api/backup-auth
 * Dispara backup manual da sessão pro GitHub (fora do debounce automático).
 * Útil pra validar a persistência sem esperar o próximo creds.update.
 */
app.post("/api/backup-auth", async (req, res) => {
  if (WEBHOOK_SECRET) {
    const secret = req.headers["x-webhook-secret"] || "";
    if (secret !== WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, erro: "não autorizado" });
    }
  }
  if (!BACKUP_HABILITADO) {
    return res.status(400).json({ ok: false, erro: "GITHUB_TOKEN não configurado no servidor" });
  }
  try {
    await fazerBackupAuth();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
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

/**
 * POST /api/enviar-mensagem
 *
 * Envia uma mensagem de texto para um grupo/contato do WhatsApp.
 * Usado pelo envio automático de comunicados (ex.: OSs em aberto às 7h).
 *
 * Body: { "grupoId": "1234567890-123456@g.us", "texto": "..." }
 * Headers: X-Webhook-Secret — obrigatório se WEBHOOK_SECRET estiver configurado
 */
app.post("/api/enviar-mensagem", async (req, res) => {
  if (WEBHOOK_SECRET) {
    const secret = req.headers["x-webhook-secret"] || "";
    if (secret !== WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, erro: "unauthorized" });
    }
  }
  if (!sock || statusConexao !== "conectado") {
    return res.status(503).json({ ok: false, erro: "WhatsApp não conectado" });
  }
  const { grupoId, texto } = req.body || {};
  if (!grupoId || !texto) {
    return res.status(400).json({ ok: false, erro: "grupoId e texto são obrigatórios" });
  }
  // Retry com backoff — antes era 1 única tentativa; um soluço passageiro
  // na rede do WhatsApp bem no instante do envio (ex.: ronda das 8h de
  // 16/08/2026 que não chegou) derrubava a mensagem sem segunda chance.
  // Mesmo padrão de resiliência já usado em encaminharParaServidor().
  const esperas = [1500, 4000];
  let ultimoErro = null;
  for (let tentativa = 0; tentativa <= esperas.length; tentativa++) {
    try {
      await sock.sendMessage(grupoId, { text: texto });
      return res.json({ ok: true, tentativas: tentativa + 1 });
    } catch (err) {
      ultimoErro = err;
      console.error(`❌ [enviar-mensagem] Tentativa ${tentativa + 1} falhou: ${err.message}`);
      if (tentativa < esperas.length) {
        await new Promise(r => setTimeout(r, esperas[tentativa]));
      }
    }
  }
  res.status(500).json({ ok: false, erro: ultimoErro?.message || "falha desconhecida", tentativas: esperas.length + 1 });
});

/**
 * POST /api/enviar-imagem
 *
 * Envia uma imagem (com legenda opcional) para um grupo/contato do WhatsApp.
 * Usado pelos Comunicados Livres, quando o usuário anexa um print/foto.
 *
 * Body: { "grupoId": "...", "imagemBase64": "<base64 sem prefixo data:>", "legenda": "..." (opcional) }
 * Headers: X-Webhook-Secret — obrigatório se WEBHOOK_SECRET estiver configurado
 */
app.post("/api/enviar-imagem", async (req, res) => {
  if (WEBHOOK_SECRET) {
    const secret = req.headers["x-webhook-secret"] || "";
    if (secret !== WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, erro: "unauthorized" });
    }
  }
  if (!sock || statusConexao !== "conectado") {
    return res.status(503).json({ ok: false, erro: "WhatsApp não conectado" });
  }
  const { grupoId, imagemBase64, legenda } = req.body || {};
  if (!grupoId || !imagemBase64) {
    return res.status(400).json({ ok: false, erro: "grupoId e imagemBase64 são obrigatórios" });
  }
  try {
    const buffer = Buffer.from(imagemBase64, "base64");
    const mensagem = { image: buffer };
    if (legenda) mensagem.caption = legenda;
    await sock.sendMessage(grupoId, mensagem);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
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

// ── Vigia de reconexão forçada ──────────────────────────────────────────────
// O Baileys já tenta reconectar sozinho a cada queda (ver connection.update
// acima), mas em alguns casos esse loop pode ficar preso tentando repetidas
// vezes sem nunca completar (sessão travada, erro não tratado dentro de
// conectar() antes do socket terminar de montar, etc.) — foi exatamente
// isso que aconteceu em 15/08/2026: o WhatsApp ficou "desconectado" por
// horas até um reinício manual do serviço resolver. Esse vigia detecta esse
// cenário (desconectado continuamente por tempo demais, mesmo com o loop de
// reconexão normal rodando) e força uma reconexão do zero automaticamente,
// sem precisar reiniciar o processo inteiro nem depender de alguém notar.
const VIGIA_LIMIAR_MS = 3 * 60 * 1000; // 3min continuamente desconectado
setInterval(() => {
  if (statusConexao !== "conectado" && desconectadoDesde && (Date.now() - desconectadoDesde) > VIGIA_LIMIAR_MS) {
    console.log(`🔧 [Vigia] Desconectado há mais de ${VIGIA_LIMIAR_MS / 60000}min — forçando reconexão do zero.`);
    desconectadoDesde = Date.now(); // reseta a janela pra não disparar de novo a cada 60s
    conectar().catch(err => console.error("❌ [Vigia] Erro ao forçar reconexão:", err));
  }
}, 60 * 1000); // checa a cada 1min

// ── Inicia ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor Baileys na porta ${PORT}`);
  console.log(`📡 Modo 1 (tempo real): sempre ativo ao conectar`);
  console.log(`🔍 Modo 2 (histórico):  disponível via GET /api/messages/:grupoId`);
  conectar().catch(err => console.error("❌ Erro ao conectar:", err));
});
