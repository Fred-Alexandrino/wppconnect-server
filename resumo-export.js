/**
 * resumo-export.js — arquivo de mensagens dos grupos + envio ao repositório
 * privado de resumos (GitHub), onde o Claude gera o resumo.
 *
 * Variáveis de ambiente:
 *   RESUMOS_GH_TOKEN   token fino do GitHub (Contents: leitura e escrita no repo abaixo)
 *   RESUMOS_REPO       padrão "Fred-Alexandrino/resumos-whatsapp"
 *   RESUMO_HORARIOS    opcional, ex: "07:30,13:00,18:00" (horário de Fortaleza)
 *   RESUMO_TODOS       "1" = exporta todos os grupos arquivados (padrão: só mapeados + extras)
 *   GRUPOS_RESUMO_EXTRA JSON {"<idNumerico>":"Nome"} com grupos além dos mapeados
 *   GRUPOS_TIPO        JSON {"<nome do grupo>":"Cliente|Equipe"} para forçar o tipo
 *   DATA_DIR           padrão "./data"
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "./data";
const ARQ = path.join(DATA_DIR, "resumo-msgs.jsonl");
const REPO = process.env.RESUMOS_REPO || "Fred-Alexandrino/resumos-whatsapp";
const GH_TOKEN = process.env.RESUMOS_GH_TOKEN || "";
const RETENCAO_S = 8 * 24 * 3600;
const TZ = "America/Fortaleza";

function json(env, padrao) { try { return env ? JSON.parse(env) : padrao; } catch (_) { return padrao; } }
// Grupos além dos mapeados em server.js (IDs confirmados em 09/11/2026)
const EXTRAS_PADRAO = {
  "120363430482583512": "Equipe Tupi Paulista/St Anast/Alv. Machado",
  "120363431601050989": "Equipe Ipixuna - 2C",
  "120363410279004309": "Equipe Coração/Guatambu",
  "120363431235680039": "Equipe Alto Parana/Paranavaí",
  "120363430888041572": "Equipe União 2C",
  "120363432086889798": "Equipe Colorado/Mandaguaçu/Sarandi",
  "120363413986264625": "Equipe Céu Azul/Assis Chat.",
};
const EXTRAS = Object.assign({}, EXTRAS_PADRAO, json(process.env.GRUPOS_RESUMO_EXTRA, {}));
const TIPOS = json(process.env.GRUPOS_TIPO, {});

const nomesCache = new Map();
let nomesEm = 0, nomesBuscando = false;
const vistos = new Set();
let ctx = null;

function fmt(ts, opts) { return new Date(ts * 1000).toLocaleString("pt-BR", Object.assign({ timeZone: TZ }, opts)); }
function dataHora(ts) { return fmt(ts, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", ""); }
function stamp(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}-${p.hour === "24" ? "00" : p.hour}${p.minute}`;
}
function ontemMeiaNoite(agoraS) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(agoraS * 1000)).map((x) => [x.type, x.value]));
  // Fortaleza é UTC-3 o ano todo
  return Date.UTC(+p.year, +p.month - 1, +p.day - 1, 3, 0, 0) / 1000;
}

async function atualizarNomes() {
  if (nomesBuscando || !ctx || !ctx.getSock()) return;
  nomesBuscando = true;
  try {
    const todos = await ctx.getSock().groupFetchAllParticipating();
    for (const [jid, g] of Object.entries(todos)) nomesCache.set(jid.replace("@g.us", ""), g.subject || "");
    nomesEm = Date.now();
  } catch (e) { console.warn("[resumo] nomes dos grupos:", e.message); }
  nomesBuscando = false;
}
function nomeDe(id) {
  if (Date.now() - nomesEm > 3600e3) atualizarNomes();
  return (ctx.mapeados[id] || EXTRAS[id] || nomesCache.get(id) || "");
}
function midia(m) {
  if (!m) return "";
  if (m.audioMessage) return "[áudio]";
  if (m.imageMessage) return "[imagem]";
  if (m.videoMessage) return "[vídeo]";
  if (m.documentMessage) return "[documento " + (m.documentMessage.fileName || "") + "]";
  if (m.stickerMessage) return "";
  return "";
}

function registrar(msg) {
  try {
    const jid = msg?.key?.remoteJid || "";
    if (!jid.endsWith("@g.us") || !msg.message) return;
    const id = jid.replace("@g.us", "");
    const mid = msg.key.id;
    if (mid) { if (vistos.has(mid)) return; vistos.add(mid); if (vistos.size > 20000) vistos.clear(); }
    const texto = ctx.extrairTexto(msg) || midia(msg.message);
    if (!texto) return;
    const ts = Number(msg.messageTimestamp || Math.floor(Date.now() / 1000));
    const rem = msg.key.fromMe ? "Fred" : (msg.pushName || (msg.key.participant || "").replace(/@.*/, "") || "desconhecido");
    fs.appendFileSync(ARQ, JSON.stringify({ t: ts, g: id, r: rem, x: texto }) + "\n");
  } catch (e) { console.warn("[resumo] registrar:", e.message); }
}

function lerMensagens(desde) {
  if (!fs.existsSync(ARQ)) return [];
  const out = [];
  for (const l of fs.readFileSync(ARQ, "utf8").split("\n")) {
    if (!l) continue;
    try { const o = JSON.parse(l); if (o.t >= desde) out.push(o); } catch (_) {}
  }
  return out.sort((a, b) => a.t - b.t);
}
function limpar() {
  try {
    const manter = lerMensagens(Math.floor(Date.now() / 1000) - RETENCAO_S);
    fs.writeFileSync(ARQ, manter.map((o) => JSON.stringify(o)).join("\n") + (manter.length ? "\n" : ""));
  } catch (_) {}
}
function tipoDe(nome) {
  if (TIPOS[nome]) return TIPOS[nome];
  if (/^(equipe|cos\b|o&m\s*-)/i.test(nome)) return "Equipe";
  return "Cliente";
}
function gruposExportados(msgs) {
  const ids = new Set([...Object.keys(ctx.mapeados), ...Object.keys(EXTRAS)]);
  if (process.env.RESUMO_TODOS === "1") msgs.forEach((m) => ids.add(m.g));
  return [...ids];
}

function gerarTexto(agoraS) {
  const desde = ontemMeiaNoite(agoraS);
  const msgs = lerMensagens(desde);
  const ids = gruposExportados(msgs);
  const porNome = new Map();
  for (const id of ids) {
    const nome = nomeDe(id) || id;
    if (!porNome.has(nome)) porNome.set(nome, []);
    porNome.get(nome).push(...msgs.filter((m) => m.g === id));
  }
  let total = 0;
  const blocos = [];
  for (const [nome, lista] of [...porNome.entries()].sort((a, b) => a[0].localeCompare(b[0], "pt-BR"))) {
    lista.sort((a, b) => a.t - b.t); total += lista.length;
    const corpo = lista.length ? lista.map((m) => `[${dataHora(m.t)}] ${m.r}: ${m.x}`).join("\n") : "(sem mensagens no período)";
    blocos.push(`<grupo nome="${nome.replace(/"/g, "'")}" tipo="${tipoDe(nome)}">\n${corpo}\n</grupo>`);
  }
  const head = `Mensagens de ${dataHora(desde)} até ${dataHora(agoraS)} (horário de Fortaleza). ${total} mensagens de ${blocos.length} grupo(s). Fonte: servidor WhatsApp. Áudios, imagens e documentos aparecem só como marcador.`;
  return { texto: head + "\n\n" + blocos.join("\n\n"), total, grupos: blocos.length };
}

async function publicar() {
  if (!GH_TOKEN) throw new Error("RESUMOS_GH_TOKEN não configurado");
  const agora = Math.floor(Date.now() / 1000);
  const { texto, total, grupos } = gerarTexto(agora);
  const arquivo = stamp(agora) + ".md";
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/inbox/${arquivo}`, {
    method: "PUT",
    headers: { Authorization: "Bearer " + GH_TOKEN, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "content-type": "application/json" },
    body: JSON.stringify({ message: "Mensagens " + arquivo, content: Buffer.from(texto, "utf8").toString("base64") }),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return { ok: true, arquivo, total, grupos };
}

let ultimo = 0;
async function disparar() {
  if (Date.now() - ultimo < 60e3) throw new Error("aguarde 1 minuto entre pedidos");
  ultimo = Date.now();
  return publicar();
}

function registrarRotas(app, c) {
  ctx = c;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  limpar(); setInterval(limpar, 6 * 3600e3);
  const auth = (req, res) => {
    if (c.secret && (req.headers["x-webhook-secret"] || req.query.secret || "") !== c.secret) { res.status(401).json({ erro: "não autorizado" }); return false; }
    return true;
  };
  const cors = (req, res, next) => {
    const o = req.headers.origin;
    if (o === "https://fred-alexandrino.github.io") {
      res.set({ "Access-Control-Allow-Origin": o, "Access-Control-Allow-Headers": "content-type,x-webhook-secret", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
  app.use("/api/enviar-resumo", cors);
  app.use("/api/resumo-preview", cors);
  app.use("/api/resumo-grupos", cors);
  app.post("/api/enviar-resumo", async (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(await disparar()); } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  app.get("/api/resumo-preview", (req, res) => {
    if (!auth(req, res)) return;
    res.type("text/plain; charset=utf-8").send(gerarTexto(Math.floor(Date.now() / 1000)).texto);
  });
  app.get("/api/resumo-grupos", async (req, res) => {
    if (!auth(req, res)) return;
    await atualizarNomes();
    const msgs = lerMensagens(Math.floor(Date.now() / 1000) - RETENCAO_S);
    const cont = {}; msgs.forEach((m) => (cont[m.g] = (cont[m.g] || 0) + 1));
    const exp = new Set(gruposExportados(msgs));
    res.json([...nomesCache.entries()].map(([id, nome]) => ({ id, nome, mensagens8dias: cont[id] || 0, exportado: exp.has(id) })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")));
  });
  const horarios = (process.env.RESUMO_HORARIOS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (horarios.length) {
    let feito = "";
    setInterval(() => {
      const hm = new Date().toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
      const chave = new Date().toLocaleDateString("pt-BR", { timeZone: TZ }) + " " + hm;
      if (horarios.includes(hm) && feito !== chave) { feito = chave; disparar().then((r) => console.log("[resumo] agendado:", r.arquivo, r.total)).catch((e) => console.warn("[resumo] agendado falhou:", e.message)); }
    }, 20e3);
  }
  console.log(`[resumo] arquivo de mensagens ativo (${ARQ})` + (GH_TOKEN ? "" : " — sem RESUMOS_GH_TOKEN, envio desativado"));
}

module.exports = { registrar, registrarRotas };
