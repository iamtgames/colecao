// Verifica se algum canal de YouTube da lista "canais" esta transmitindo AO VIVO agora.
// Roda via GitHub Actions (.github/workflows/check-live.yml).
//
// Usa a API oficial do YouTube Data API v3 (chave em process.env.YOUTUBE_API_KEY,
// guardada como secret do GitHub Actions — nunca aparece no codigo nem no site).
//
// Por que trocamos a raspagem de HTML por essa abordagem:
// tentamos antes raspar https://www.youtube.com/@handle/live direto, mas o YouTube
// bloqueia requisicoes vindas de IPs de datacenter (como os runners do GitHub Actions)
// com um erro "LOGIN_REQUIRED" especificamente em alguns canais/lives, mesmo quando
// a transmissao esta genuinamente ao vivo (confirmado manualmente via navegador).
// A API oficial nao sofre esse bloqueio e da a resposta correta sempre.
//
// HISTORICO (23/07/2026): a primeira versao usava o feed RSS publico e gratuito
// (https://www.youtube.com/feeds/videos.xml?channel_id=...) pra achar videos
// candidatos sem gastar cota. Esse feed passou a retornar 404/500 de forma
// inconsistente pra todos os canais simultaneamente (confirmado em 2 execucoes
// reais do workflow, mesmo enviando User-Agent de navegador) — ou seja, parou
// de ser confiavel vindo de IPs de datacenter do GitHub Actions. Trocamos pela
// abordagem abaixo, que usa so a API oficial (nao depende de scraping):
//
// Estrategia pra gastar pouca cota (limite gratuito: 10.000 unidades/dia):
// 1) Cada canal tem uma "uploads playlist" oficial cujo ID e sempre o
//    channelId com o prefixo "UC" trocado por "UU" (regra estavel e documentada
//    da API do YouTube). Buscamos os 3 videos mais recentes dessa playlist via
//    playlistItems.list (part=snippet), que custa so 1 unidade por chamada —
//    9 canais = 9 unidades por execucao, nada perto do limite diario.
// 2) Junta os ids de video de TODOS os canais numa unica chamada videos.list
//    (part=snippet), que custa so ~1 unidade no total, nao importa quantos ids
//    (ate 50).
// 3) Filtra quem tem snippet.liveBroadcastContent === 'live'.

const fs = require('fs');

const API_KEY = process.env.YOUTUBE_API_KEY;

// TWITCH (adicionado 26/07/2026): mesmo esquema de aviso "AO VIVO" que os
// canais de YouTube ja tem, so que via Twitch Helix API. Precisa de um app
// registrado em https://dev.twitch.tv/console/apps (Client ID + Client
// Secret guardados como secrets do GitHub Actions: TWITCH_CLIENT_ID e
// TWITCH_CLIENT_SECRET -- nunca aparecem no codigo nem no site). Fluxo:
// 1) pega um "app access token" via OAuth client credentials
//    (POST id.twitch.tv/oauth2/token) -- token de app, nao precisa de login
//    de usuario nem de refresh manual, a Twitch renova sozinha a cada chamada.
// 2) consulta GET helix/streams?user_login=... -- se o canal aparecer na
//    resposta, esta ao vivo agora; se nao aparecer, esta offline.
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

const CANAIS_TWITCH = [
  { id: 13, n: 'PELEHZADA', login: 'pelehzada' },
  { id: 14, n: 'tofogames10', login: 'tofogames10' },
  { id: 15, n: 'corvofps', login: 'corvofps' },
];

// Mesmos ids/nomes do array "canais" no index.html — mantenha em sincronia
// ao adicionar/remover canais de YouTube na aba Vendedores/Lives/Leiloes.
// channelId (UC...) resolvido uma vez via API (channels.list?forHandle=) e
// fixado aqui pra nao gastar cota resolvendo handle -> id toda hora.
const CANAIS_YOUTUBE = [
  { id: 1, n: 'Diego Sheth', channelId: 'UC6ZRxYOOJw2rwtuIerO-lrA' },
  { id: 2, n: 'Antec.r', channelId: 'UCWX9kXOO4awp-c3VeJtObPw' },
  { id: 3, n: 'Garimpo dos Games', channelId: 'UCkDTuzfIG3s_Z-JSoHw3IZQ' },
  { id: 4, n: 'Cara de Barata', channelId: 'UCefKgYBOrc3yff2gkhgslcQ' },
  { id: 5, n: 'DJ Games Retro', channelId: 'UC1yok96pYoUNtNnyN7zzWPQ' },
  { id: 6, n: 'Jotape Arcade', channelId: 'UCDoeapAROOAnkBwd178MpUQ' },
  { id: 7, n: 'Sigchap', channelId: 'UCpTyn0RRvTmjgNi7YYzUstA' },
  { id: 9, n: 'Rodrigo Retro Games', channelId: 'UChKgfyQRLATKl7dl-z6tolg' },
  { id: 12, n: 'VG Invest', channelId: 'UCEHV0ePP26xJVcPEoCLxfSQ' },
];

const MAX_VIDEOS_POR_CANAL = 3;

function uploadsPlaylistId(channelId) {
  // Regra oficial da API: a "uploads playlist" de qualquer canal e o mesmo
  // channelId trocando o prefixo "UC" por "UU".
  return channelId.startsWith('UC') ? `UU${channelId.slice(2)}` : null;
}

async function pegarVideosRecentes(canal) {
  const playlistId = uploadsPlaylistId(canal.channelId);
  if (!playlistId) {
    console.warn(`Aviso: channelId de ${canal.n} nao comeca com "UC" — nao da pra derivar a uploads playlist.`);
    return [];
  }
  try {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=${MAX_VIDEOS_POR_CANAL}&key=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.warn(`Aviso: playlistItems falhou pra ${canal.n}: ${data.error.message}`);
      return [];
    }
    const ids = (data.items || [])
      .map(it => it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId)
      .filter(Boolean);
    return ids.map(videoId => ({ videoId, canal }));
  } catch (e) {
    console.error(`Erro buscando uploads de ${canal.n}:`, e.message);
    return [];
  }
}

// Le o canais_live.json atual (se existir) pra servir de rede de seguranca:
// se uma das duas plataformas falhar nessa execucao, mantemos o ultimo
// estado conhecido dela em vez de apagar por engano, mas continuamos
// atualizando normalmente a plataforma que funcionou.
function lerEstadoAnterior() {
  try {
    const bruto = fs.readFileSync('canais_live.json', 'utf8');
    const data = JSON.parse(bruto);
    return Array.isArray(data.live) ? data.live : [];
  } catch (e) {
    return [];
  }
}

async function checarYoutubeLive() {
  if (!API_KEY) {
    console.warn('Aviso: YOUTUBE_API_KEY nao configurada -- pulando checagem do YouTube.');
    return null;
  }
  try {
    const listasPorCanal = await Promise.all(CANAIS_YOUTUBE.map(pegarVideosRecentes));
    const candidatos = listasPorCanal.flat();

    if (!candidatos.length) {
      console.warn('Aviso: nenhum video encontrado via playlistItems pra nenhum canal do YouTube -- mantendo estado anterior desses canais.');
      return null;
    }

    const idParaCanal = {};
    candidatos.forEach(c => { idParaCanal[c.videoId] = c.canal; });
    const idsUnicos = Object.keys(idParaCanal);

    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${idsUnicos.join(',')}&key=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      console.warn(`Aviso: erro da API do YouTube: ${data.error.message} -- mantendo estado anterior desses canais.`);
      return null;
    }

    const live = (data.items || [])
      .filter(v => v.snippet.liveBroadcastContent === 'live')
      .map(v => {
        const canal = idParaCanal[v.id];
        return {
          id: canal.id,
          n: canal.n,
          plat: 'youtube',
          videoId: v.id,
          videoTitle: v.snippet.title,
          videoUrl: `https://www.youtube.com/watch?v=${v.id}`,
          thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`
        };
      });
    console.log(`YouTube: ${idsUnicos.length} videos checados via API, ${live.length} canal(is) ao vivo agora.`);
    return live;
  } catch (e) {
    console.warn(`Aviso: falha checando o YouTube: ${e.message} -- mantendo estado anterior desses canais.`);
    return null;
  }
}

async function pegarTokenTwitch() {
  const url = `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(data.message || 'Twitch nao retornou access_token.');
  }
  return data.access_token;
}

async function checarTwitchLive() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    console.warn('Aviso: TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET nao configurados -- pulando checagem da Twitch.');
    return null;
  }
  try {
    const token = await pegarTokenTwitch();
    const query = CANAIS_TWITCH.map(c => `user_login=${encodeURIComponent(c.login)}`).join('&');
    const res = await fetch(`https://api.twitch.tv/helix/streams?${query}`, {
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.error) {
      console.warn(`Aviso: erro da API da Twitch: ${data.message || data.error} -- mantendo estado anterior desses canais.`);
      return null;
    }
    const live = (data.data || []).map(stream => {
      const canal = CANAIS_TWITCH.find(c => c.login.toLowerCase() === stream.user_login.toLowerCase());
      if (!canal) return null;
      return {
        id: canal.id,
        n: canal.n,
        plat: 'twitch',
        login: canal.login,
        videoTitle: stream.title,
        videoUrl: `https://www.twitch.tv/${canal.login}`,
        thumbnail: (stream.thumbnail_url || '').replace('{width}', '440').replace('{height}', '248')
      };
    }).filter(Boolean);
    console.log(`Twitch: ${CANAIS_TWITCH.length} canal(is) checado(s), ${live.length} ao vivo agora.`);
    return live;
  } catch (e) {
    console.warn(`Aviso: falha checando a Twitch: ${e.message} -- mantendo estado anterior desses canais.`);
    return null;
  }
}

async function main() {
  const anterior = lerEstadoAnterior();
  const idsYoutube = new Set(CANAIS_YOUTUBE.map(c => c.id));
  const idsTwitch = new Set(CANAIS_TWITCH.map(c => c.id));

  const [liveYoutube, liveTwitch] = await Promise.all([
    checarYoutubeLive(),
    checarTwitchLive(),
  ]);

  // null = a checagem dessa plataforma falhou nessa execucao -> mantem o que
  // já estava salvo pros canais dela, em vez de apagar por causa de uma
  // falha temporaria da API/rede.
  const resultadoYoutube = liveYoutube !== null ? liveYoutube : anterior.filter(c => idsYoutube.has(c.id));
  const resultadoTwitch = liveTwitch !== null ? liveTwitch : anterior.filter(c => idsTwitch.has(c.id));

  if (liveYoutube === null && liveTwitch === null && !anterior.length) {
    throw new Error('YouTube e Twitch falharam e nao ha estado anterior pra reaproveitar -- abortando pra nao gravar canais_live.json vazio por engano.');
  }

  const live = [...resultadoYoutube, ...resultadoTwitch];

  const payload = {
    updated: new Date().toISOString(),
    live
  };

  fs.writeFileSync('canais_live.json', JSON.stringify(payload, null, 2) + '\n');
  console.log(`OK: ${live.length} canal(is) ao vivo agora (YouTube + Twitch).`);
  live.forEach(c => console.log(` - ${c.n}: ${c.videoTitle}`));
}

main().catch(err => {
  console.error('Erro ao checar lives:', err);
  process.exit(1);
});
