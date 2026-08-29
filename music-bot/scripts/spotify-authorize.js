#!/usr/bin/env node
// One-time helper for authorizing the bot's Spotify account. It deliberately
// reads credentials from the environment and never writes them to disk.
const http = require("http");
const crypto = require("crypto");

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = process.env.SPOTIFY_REDIRECT_URI || "http://127.0.0.1:8787/spotify/callback";

if (!clientId || !clientSecret) {
  console.error("Defina SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET antes de executar este script.");
  process.exit(1);
}

const callback = new URL(redirectUri);
if (callback.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(callback.hostname)) {
  console.error("SPOTIFY_REDIRECT_URI deve ser um callback HTTP local, por exemplo http://127.0.0.1:8787/spotify/callback.");
  process.exit(1);
}

const state = crypto.randomBytes(24).toString("hex");
const authorize = new URL("https://accounts.spotify.com/authorize");
authorize.search = new URLSearchParams({
  client_id: clientId,
  response_type: "code",
  redirect_uri: redirectUri,
  scope: "playlist-read-private playlist-read-collaborative",
  state,
}).toString();

const server = http.createServer(async (request, response) => {
  const received = new URL(request.url, redirectUri);
  const code = received.searchParams.get("code");
  if (received.pathname !== callback.pathname || received.searchParams.get("state") !== state || !code) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Autorização inválida. Volte ao terminal e tente novamente.");
    return;
  }
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.refresh_token) throw new Error(token.error_description || token.error || `HTTP ${tokenResponse.status}`);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("Autorização concluída. Você já pode fechar esta aba.");
    console.log("\nCopie o valor abaixo para o GitHub Secret SPOTIFY_REFRESH_TOKEN:\n");
    console.log(token.refresh_token);
    server.close();
  } catch (error) {
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("Não foi possível trocar o código. Veja o terminal.");
    console.error(`Falha ao obter refresh token: ${error.message}`);
    server.close(() => process.exitCode = 1);
  }
});

server.listen(Number(callback.port || 80), callback.hostname, () => {
  console.log("No Spotify Dashboard, adicione exatamente este Redirect URI:");
  console.log(redirectUri);
  console.log("\nAbra esta URL no navegador, entre na conta que o bot usará e autorize:\n");
  console.log(authorize.toString());
});
