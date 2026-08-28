// Passo 1 do import do histórico do Discord: transforma as respostas de
// `GET /api/v9/channels/{id}/messages` capturadas num HAR em um JSON local já
// na estrutura das tabelas do Talkeando (users / messages / attachments /
// message_link_previews / message_embeds).
//
// NÃO baixa nada e NÃO lê cookie/token do HAR — só os corpos JSON de mensagem.
// O passo 2 (`cargo run -- import-discord-json --path <arquivo>`) é quem baixa
// as imagens do CDN, grava no volume de anexos e insere no Postgres.
//
//   node scripts/discord-import/har-to-json.mjs [caminho-do-har] [saida.json]
//
// Padrões: HAR em ~/Downloads/discord-new.har, saída ao lado deste script.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HAR_PATH = process.argv[2] || path.join(os.homedir(), "Downloads", "discord-new.har");
const OUT_PATH = process.argv[3] || path.join(HERE, "estacao-finita.json");

// Mapeamento aprovado Discord -> canal de texto do Talkeando. Canais fora desta
// lista são ignorados. Ver docs/discord-har-import.md.
const CHANNEL_MAPPINGS = {
  "1353746785260015647": "monitor-de-noticias",
  "590274170131185749": "átrio-principal",
  "712339355477344298": "setor-habitacional",
  "666381552648716317": "central-de-docs",
  "693929027316088873": "mercado-negro",
  "1511410023987675328": "black-baratheon",
  "695237283565142027": "comandos-de-console",
  "1518996513584582837": "atrio-principlarper",
  // Canais novos deste HAR — o usuário confirmou que ambos são o atrio-principlarper.
  "1527733306429542491": "atrio-principlarper",
  "1353746748199403540": "atrio-principlarper",
};

const DISCORD_SOURCE = "discord.com.har"; // igual ao ledger do importador atual

// --- uuid v5 (SHA-1), sem dependências, para IDs estáveis entre execuções ----
const UUID_NS = "6f1c8f4e-9c1a-5b7e-8a3d-2e6b7c9d0a11"; // namespace fixo deste importador
function uuidv5(name, namespace = UUID_NS) {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = crypto.createHash("sha1");
  hash.update(nsBytes);
  hash.update(Buffer.from(name, "utf8"));
  const bytes = hash.digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // versão 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- helpers ----------------------------------------------------------------
const IMAGE_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
function inferContentType(filename, given) {
  if (given) return given;
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return IMAGE_EXT[ext] || "application/octet-stream";
}

// Desescapa o Markdown do Discord (\#, \!, \., \-, \* ...), converte a sintaxe
// de emoji/menção customizada para algo legível e normaliza CRLF.
function unescapeDiscord(text) {
  if (!text) return "";
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, "$1")
    .replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, ":$1:") // <:emoji:123> -> :emoji:
    .replace(/<#\d+>/g, "#canal") // referência de canal sem nome resolvível
    .replace(/<@&\d+>/g, "@cargo"); // menção de cargo sem nome resolvível
}

const URL_RE = /https?:\/\/[^\s<>()]+/gi;
function isPureLink(content) {
  const t = content.trim();
  if (!t) return false;
  const matches = t.match(URL_RE);
  return matches && matches.length === 1 && matches[0].length >= t.length - 1;
}

function avatarUrl(discordId, hash) {
  if (!hash) return null;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${discordId}/${hash}.${ext}?size=128`;
}

// --- 1. carregar o HAR e juntar todas as páginas de mensagem ---------------
const har = JSON.parse(fs.readFileSync(HAR_PATH, "utf8"));
const messagesById = new Map(); // discordMessageId -> { raw, channelId }

for (const entry of har.log.entries) {
  if (entry.request.method !== "GET") continue;
  const m = entry.request.url.match(/\/channels\/(\d+)\/messages(?:\?|$)/);
  if (!m) continue;
  const channelId = m[1];
  if (!CHANNEL_MAPPINGS[channelId]) continue;
  const body = entry.response?.content?.text;
  if (!body) continue;
  let arr;
  try { arr = JSON.parse(body); } catch { continue; }
  if (!Array.isArray(arr)) continue;
  for (const raw of arr) {
    if (raw && raw.id) messagesById.set(raw.id, { raw, channelId });
  }
}

// --- 2. autores -----------------------------------------------------------
const users = new Map(); // discordId -> user record
function ensureUser(author) {
  if (!author || !author.id) return null;
  if (!users.has(author.id)) {
    users.set(author.id, {
      id: uuidv5(`user:${author.id}`),
      discord_id: author.id,
      username: `d_${author.id}`,
      // global_name é o apelido pedido pelo usuário; bots não têm -> username.
      display_name: author.global_name || author.username || `d_${author.id}`,
      avatar_url: avatarUrl(author.id, author.avatar),
      profile_tag: author.clan?.tag || author.primary_guild?.tag || null,
    });
  }
  return users.get(author.id);
}

// --- 3. classificar + montar mensagens ----------------------------------
const messages = [];
const kindCounts = {};
const perChannel = {};
let imagesToDownload = 0;

// ordena por timestamp para o JSON já sair cronológico
const ordered = [...messagesById.values()].sort((a, b) => a.raw.timestamp.localeCompare(b.raw.timestamp));

for (const { raw, channelId } of ordered) {
  const channelName = CHANNEL_MAPPINGS[channelId];
  const author = ensureUser(raw.author);
  if (!author) continue;

  const rawContent = (raw.content || "").trim();
  const attachmentsRaw = raw.attachments || [];
  const embedsRaw = raw.embeds || [];
  const isSystem = raw.type === 6 || raw.type === 20;

  // Unfurl de link: embed cujo `url` aparece no conteúdo -> vira link_preview.
  const contentUrls = (rawContent.match(URL_RE) || []).map((u) => u.replace(/[).,]+$/, ""));
  const unfurl = embedsRaw.find((e) => e.url && contentUrls.some((u) => u === e.url || e.url.startsWith(u) || u.startsWith(e.url)));
  // Embeds "de verdade" (bot): sobra tudo que não é o unfurl acima.
  const richEmbeds = embedsRaw.filter((e) => e !== unfurl);

  const imageAttachments = attachmentsRaw.filter(
    (a) => (a.content_type || "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(a.filename || ""),
  );

  let content = unescapeDiscord(raw.content || "");
  // resolve <@id> -> @DisplayName quando conhecemos o usuário
  content = content.replace(/<@!?(\d+)>/g, (whole, id) => (users.has(id) ? `@${users.get(id).display_name}` : whole));
  content = content.trim();

  let kind;
  if (isSystem && !rawContent && !attachmentsRaw.length && !richEmbeds.length) kind = "system";
  else if (imageAttachments.length && !rawContent) kind = "image";
  else if (attachmentsRaw.length && rawContent) kind = "text+attachment";
  else if (attachmentsRaw.length) kind = "image";
  else if (!rawContent && richEmbeds.length) kind = "embed";
  else if (isPureLink(rawContent) || (!rawContent && unfurl)) kind = "link";
  else kind = "text";

  const attachments = attachmentsRaw.map((a) => ({
    id: uuidv5(`att:${a.id}`),
    discord_id: String(a.id),
    filename: a.filename || "attachment",
    content_type: inferContentType(a.filename || "", a.content_type),
    size_bytes: a.size ?? 0,
    source_url: a.url,
  }));
  imagesToDownload += attachments.length;

  let link_preview = null;
  if (unfurl) {
    const img = unfurl.image?.url || unfurl.thumbnail?.url || null;
    link_preview = {
      url: unfurl.url,
      title: unfurl.title || null,
      description: unfurl.description ? unescapeDiscord(unfurl.description) : null,
      site_name: unfurl.provider?.name || unfurl.author?.name || null,
      image_source_url: img,
    };
    if (img) imagesToDownload += 1;
  }

  const embeds = richEmbeds
    .filter((e) => e.title || e.description || (e.fields && e.fields.length) || e.image || e.author)
    .map((e, position) => {
      if (e.image?.url) imagesToDownload += 1;
      if (e.thumbnail?.url) imagesToDownload += 1;
      if (e.footer?.icon_url) imagesToDownload += 1;
      return {
        position,
        title: e.title || null,
        description: e.description ? unescapeDiscord(e.description) : null,
        url: e.url || null,
        color: typeof e.color === "number" ? e.color : null,
        author_name: e.author?.name || null,
        author_url: e.author?.url || null,
        provider_name: e.provider?.name || null,
        footer_text: e.footer?.text || null,
        footer_icon_source_url: e.footer?.icon_url || null,
        image_source_url: e.image?.url || null,
        thumbnail_source_url: e.thumbnail?.url || null,
        fields: (e.fields || []).map((f) => ({ name: f.name, value: unescapeDiscord(f.value), inline: !!f.inline })),
      };
    });

  // system sem nada aproveitável e sem embed: guarda um texto mínimo pra não sumir
  if (kind === "system" && !content) content = "[Mensagem de sistema importada do Discord]";

  messages.push({
    id: uuidv5(`msg:${raw.id}`),
    discord_id: raw.id,
    channel_name: channelName,
    author_id: author.id,
    kind,
    content,
    created_at: raw.timestamp,
    edited_at: raw.edited_timestamp || null,
    attachments,
    link_preview,
    embeds,
  });

  kindCounts[kind] = (kindCounts[kind] || 0) + 1;
  perChannel[channelName] = (perChannel[channelName] || 0) + 1;
}

// --- 4. escrever + resumo ----------------------------------------------
const out = {
  source: DISCORD_SOURCE,
  har_file: path.basename(HAR_PATH),
  generated_at: new Date().toISOString(),
  channels: CHANNEL_MAPPINGS,
  users: [...users.values()].sort((a, b) => a.discord_id.localeCompare(b.discord_id)),
  messages,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");

console.log(`HAR:    ${HAR_PATH}`);
console.log(`Saída:  ${OUT_PATH}`);
console.log(`Usuários: ${out.users.length}`);
console.log(`Mensagens: ${messages.length}`);
console.log(`Por tipo:`, kindCounts);
console.log(`Por canal:`, perChannel);
console.log(`Imagens a baixar no passo 2 (anexos + preview + embed): ~${imagesToDownload}`);
