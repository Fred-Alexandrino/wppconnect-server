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
const RETENCAO_S = 30 * 24 * 3600; // 30 dias (botão Ajuda precisa de histórico)
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
// Grupos que NUNCA entram no resumo (têm usinas fora do mapeamento do Fred)
const EXCLUIR = new Set([
  "120363423427343356", // [O&M] - Grid Co. | Thopen
  "120363426381032089", // [O&M] - Grid Co. | Alves Lima
  "120363427259899891", // [O&M] - Grid Co. | Sal Energia
  "120363423844956611", // [O&M] - Grid Co. | GD Energy
].concat((process.env.GRUPOS_EXCLUIR || "").split(",").map((x) => x.trim()).filter(Boolean)));

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
  return [...ids].filter((id) => !EXCLUIR.has(id));
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

// Contatos (nome da agenda do celular / nome público) por número e por LID, para identificar membros de grupos.
const ARQ_CONTATOS = path.join(DATA_DIR, "contatos.json");
let contatos = {};
try { contatos = JSON.parse(fs.readFileSync(ARQ_CONTATOS, "utf8")); } catch (e) { contatos = {}; }
let salvarContatosT = null;
function guardarContatos(lista) {
  for (const c of lista || []) {
    const chaves = [c.id, c.jid, c.lid, c.phoneNumber].filter(Boolean).map((x) => String(x).split(":")[0].split("@")[0]);
    for (const k of chaves) {
      const atual = contatos[k] || {};
      contatos[k] = { nome: c.name || atual.nome || "", notify: c.notify || c.verifiedName || atual.notify || "" };
    }
  }
  clearTimeout(salvarContatosT);
  salvarContatosT = setTimeout(() => { try { fs.writeFileSync(ARQ_CONTATOS, JSON.stringify(contatos)); } catch (e) {} }, 2000);
}
function ligarContatos(sock) {
  sock.ev.on("contacts.upsert", guardarContatos);
  sock.ev.on("contacts.update", guardarContatos);
  sock.ev.on("messaging-history.set", ({ contacts }) => guardarContatos(contacts));
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
  // Troca a foto de um grupo (12/11/2026 — imagens de identificação dos grupos de equipe).
  // POST /api/grupo-foto {grupo: "<id>@g.us", imagem: "<base64 PNG/JPEG>", verificar?: true}
  // Só funciona onde o número da ponte é administrador; com verificar=true só informa se é admin.
  app.post("/api/grupo-foto", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const sock = ctx.getSock();
      if (!sock || !sock.user) return res.status(503).json({ erro: "WhatsApp desconectado" });
      let jid = String((req.body || {}).grupo || "").trim();
      if (!/^\d+(-\d+)?(@g\.us)?$/.test(jid)) return res.status(400).json({ erro: "grupo inválido" });
      if (!jid.endsWith("@g.us")) jid += "@g.us";
      const meta = await sock.groupMetadata(jid);
      const eu = String(sock.user.id || "").split(":")[0].split("@")[0];
      const euLid = String(sock.user.lid || "").split(":")[0].split("@")[0];
      const p = (meta.participants || []).find((x) => {
        const id = String(x.id || "").split(":")[0].split("@")[0];
        const pn = String(x.phoneNumber || x.jid || "").split(":")[0].split("@")[0];
        return id === eu || pn === eu || (euLid && id === euLid);
      });
      const admin = !!(p && (p.admin === "admin" || p.admin === "superadmin"));
      const soAdmins = !!meta.restrict;
      if ((req.body || {}).verificar) return res.json({ ok: true, grupo: jid, nome: meta.subject, admin, soAdminsEditam: soAdmins });
      if (!admin && soAdmins) return res.status(403).json({ erro: "o número da ponte não é administrador deste grupo", nome: meta.subject });
      const img = Buffer.from(String((req.body || {}).imagem || ""), "base64");
      if (img.length < 1000) return res.status(400).json({ erro: "imagem vazia" });
      if (!(img[0] === 0xff && img[1] === 0xd8)) return res.status(400).json({ erro: "envie JPEG 640x640" });
      // Envia direto (o updateProfilePicture do Baileys exige sharp/jimp, que não estão instalados na VM2).
      await sock.query({ tag: "iq", attrs: { to: "s.whatsapp.net", type: "set", xmlns: "w:profile:picture", target: jid },
        content: [{ tag: "picture", attrs: { type: "image" }, content: img }] });
      res.json({ ok: true, grupo: jid, nome: meta.subject, admin });
    } catch (e) {
      res.status(500).json({ erro: String(e.message || e).slice(0, 300) });
    }
  });

  // ── Gestão de grupos (13/11/2026): membros com nome, contatos e alterações ──
  const normId = (x) => String(x || "").split(":")[0].split("@")[0];
  app.get("/api/grupo-membros", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const sock = ctx.getSock();
      if (!sock || !sock.user) return res.status(503).json({ erro: "WhatsApp desconectado" });
      let jid = String(req.query.grupo || "").trim(); if (!jid.endsWith("@g.us")) jid += "@g.us";
      const meta = await sock.groupMetadata(jid);
      const membros = (meta.participants || []).map((p) => {
        const id = normId(p.id), pn = normId(p.phoneNumber || p.jid || (String(p.id).endsWith("@s.whatsapp.net") ? p.id : ""));
        const c = contatos[pn] || contatos[id] || {};
        return { id: p.id, numero: pn || "", nome: c.nome || c.notify || "", admin: p.admin || "" };
      });
      res.json({ ok: true, grupo: jid, nome: meta.subject, descricao: meta.desc || "", membros });
    } catch (e) { res.status(500).json({ erro: String(e.message || e).slice(0, 300) }); }
  });
  app.get("/api/contatos", (req, res) => {
    if (!auth(req, res)) return;
    const q = String(req.query.busca || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const termos = q.split(",").map((t) => t.trim()).filter(Boolean);
    const lista = Object.entries(contatos).map(([k, v]) => ({ chave: k, ...v }))
      .filter((c) => !termos.length || termos.some((t) => String((c.nome || "") + " " + (c.notify || "")).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(t)));
    res.json({ ok: true, total: Object.keys(contatos).length, contatos: lista.slice(0, 200) });
  });
  app.post("/api/contatos-sincronizar", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const sock = ctx.getSock();
      const antes = Object.keys(contatos).length;
      await sock.resyncAppState(["critical_unblock_low", "regular_high", "regular_low", "regular", "critical_block"], true);
      await new Promise((r) => setTimeout(r, 3000));
      res.json({ ok: true, antes, depois: Object.keys(contatos).length });
    } catch (e) { res.status(500).json({ erro: String(e.message || e).slice(0, 300), total: Object.keys(contatos).length }); }
  });
  // POST /api/grupo-gerenciar {grupo, acao: renomear|descricao|adicionar|remover, nome?, texto?, participantes?: ["5511..."]}
  app.post("/api/grupo-gerenciar", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const sock = ctx.getSock();
      if (!sock || !sock.user) return res.status(503).json({ erro: "WhatsApp desconectado" });
      const b = req.body || {};
      let jid = String(b.grupo || "").trim(); if (!jid.endsWith("@g.us")) jid += "@g.us";
      if (b.acao === "renomear") { await sock.groupUpdateSubject(jid, String(b.nome || "").slice(0, 100)); return res.json({ ok: true }); }
      if (b.acao === "remover-foto") { await sock.removeProfilePicture(jid); return res.json({ ok: true }); }
      if (b.acao === "descricao") { await sock.groupUpdateDescription(jid, String(b.texto || "")); return res.json({ ok: true }); }
      if (b.acao === "adicionar" || b.acao === "remover") {
        const parts = (b.participantes || []).map((x) => String(x).includes("@") ? String(x) : String(x).replace(/\D/g, "") + "@s.whatsapp.net");
        if (!parts.length) return res.status(400).json({ erro: "participantes vazio" });
        const r = await sock.groupParticipantsUpdate(jid, parts, b.acao === "adicionar" ? "add" : "remove");
        return res.json({ ok: true, resultado: r });
      }
      res.status(400).json({ erro: "ação inválida" });
    } catch (e) { res.status(500).json({ erro: String(e.message || e).slice(0, 300) }); }
  });

  app.use("/api/ajuda-mensagens", cors);
  // Leitura de mensagens para o botão Ajuda (qualquer grupo arquivado, inclusive os fora do resumo).
  // GET /api/ajuda-mensagens?grupo=<id ou parte do nome>[,outro...]&horas=48&limit=400
  app.get("/api/ajuda-mensagens", async (req, res) => {
    if (!auth(req, res)) return;
    try {
      if (!nomesCache.size || Date.now() - nomesEm > 3600e3) await atualizarNomes();
      const horas = Math.min(Math.max(parseInt(req.query.horas || "48", 10) || 48, 1), 720);
      const limit = Math.min(Math.max(parseInt(req.query.limit || "400", 10) || 400, 1), 1500);
      const termos = String(req.query.grupo || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (!termos.length) return res.status(400).json({ erro: "parâmetro 'grupo' obrigatório (id ou parte do nome)" });
      const msgs = lerMensagens(Math.floor(Date.now() / 1000) - horas * 3600);
      const ids = new Set(msgs.map((m) => m.g));
      const casados = [...ids].filter((id) => {
        const nome = (nomeDe(id) || "").toLowerCase();
        return termos.some((t) => id === t || (nome && nome.includes(t)));
      });
      const grupos = casados.map((id) => ({ id, nome: nomeDe(id) || id }));
      const sel = msgs.filter((m) => casados.includes(m.g)).slice(-limit);
      res.json({
        horas, total: sel.length, grupos,
        mensagens: sel.map((m) => ({ quando: fmt(m.t, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", ""), t: m.t, grupo: nomeDe(m.g) || m.g, remetente: m.r, texto: m.x })),
      });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
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

module.exports = { registrar, registrarRotas, ligarContatos };
